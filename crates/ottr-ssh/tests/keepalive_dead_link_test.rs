//! BL-207②：传输层 keepalive 死链检测的自动化测试（ottr-ssh 单测层 mock
//! transport——进程内 russh server + **可冻结的 TCP 代理**；不依赖 docker
//! 夹具：真 sshd 无法在测试中模拟「拔网线」，而代理冻结可以在 TCP 两端
//! 保持开口的前提下掐断数据转发 = 精确的死链语义）。
//!
//! 死链 ≠ 对端 FIN/RST：drop socket 会走「对端关闭立即感知」路径（读循环
//! 直接报错），那是另一条已验证的路径。这里冻结代理转发并**持有**两端
//! socket（不发 FIN/RST）——链路上再无任何数据流动，唯一的检测手段就是
//! keepalive 超时（`keepalive_max`（默认 3）× interval 未收到对端数据即断）。
//!
//! 断言面：
//! * 健康链路 + keepalive 开启：keepalive 周期流动**不产生**任何 channel 事件
//!   （keepalive 是传输层全局请求，不进 channel 数据流——终端零污染的契约）；
//! * 冻结链路 + keepalive 开启：`keepalive_max × interval` 量级内 channel 终止
//!   （会话转发循环据此发 `ottr://session-closed`(Closed) 触发重连）；
//! * 冻结链路 + keepalive 关闭（对照面）：不指望检测——证明检测确实来自
//!   keepalive 而非其他机制。
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect_with_keepalive};
use russh::server::{Auth, Server as _};

const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "mock-pass";
/// keepalive 间隔：150ms × keepalive_max 3 ≈ 450ms 检测窗口（测试要快）。
const KEEPALIVE: Duration = Duration::from_millis(150);
/// 死链检测预算（450ms 量级 + 调度余量）。
const DEADLINE: Duration = Duration::from_secs(6);
/// 健康对照观察窗。
const HEALTHY_WINDOW: Duration = Duration::from_millis(1200);

// ------------------------------------------------------------------ mock sshd

#[derive(Clone)]
struct MockAuth;

impl russh::server::Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == MOCK_USER && password == MOCK_PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    /// 接受 session 通道打开（open_pty 的对端；不 accept = 拒绝）。
    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
}

struct MockSshd;

impl russh::server::Server for MockSshd {
    type Handler = MockAuth;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        MockAuth
    }
}

async fn spawn_mock_sshd() -> SocketAddr {
    let host_key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("generate host key");
    let config = Arc::new(russh::server::Config {
        keys: vec![host_key],
        // 关键：服务端不做 inactivity 超时——死链判定必须全部来自客户端 keepalive。
        inactivity_timeout: None,
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut sshd = MockSshd;
        let _ = sshd.run_on_socket(config, &listener).await;
    });
    addr
}

// ------------------------------------------------- 可冻结 TCP 代理（死链源）

/// TCP 代理：客户端 ↔ 代理 ↔ mock sshd。`freeze()` 掐断双向转发但**持有**
/// 两端 socket（不 drop = 不发 FIN/RST），链路进入「活着但全哑」的死链态。
async fn spawn_freezable_proxy(sshd: SocketAddr) -> (SocketAddr, Freeze) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (freeze_tx, freeze_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        loop {
            let Ok((client, _)) = listener.accept().await else {
                return;
            };
            let Ok(server) = tokio::net::TcpStream::connect(sshd).await else {
                return;
            };
            pump(client, server, freeze_rx.clone());
        }
    });
    (addr, Freeze { tx: freeze_tx })
}

#[derive(Clone)]
struct Freeze {
    tx: tokio::sync::watch::Sender<bool>,
}

impl Freeze {
    fn freeze(&self) {
        let _ = self.tx.send(true);
    }
}

/// 双向泵：冻结即永久挂起（future 不返回 = socket 半体不被 drop）。
/// socket 用 `into_split()` 拆读写半体——两个任务各持一端读半 + 对端写半，
/// 冻结时各自持有到底，绝不 drop（drop = FIN = 另一条检测路径）。
fn pump(
    client: tokio::net::TcpStream,
    server: tokio::net::TcpStream,
    freeze_rx: tokio::sync::watch::Receiver<bool>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut client_r, mut client_w) = client.into_split();
    let (mut server_r, mut server_w) = server.into_split();
    let mut rx1 = freeze_rx.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            if *rx1.borrow() {
                // 死链态：挂起整个任务，socket 半体由本 future 持有（不关）。
                std::future::pending::<()>().await;
            }
            tokio::select! {
                _ = rx1.changed() => continue,
                read = client_r.read(&mut buf) => {
                    match read {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            if server_w.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    });
    let mut rx2 = freeze_rx;
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            if *rx2.borrow() {
                std::future::pending::<()>().await;
            }
            tokio::select! {
                _ = rx2.changed() => continue,
                read = server_r.read(&mut buf) => {
                    match read {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            if client_w.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    });
}

// ------------------------------------------------------------------- 助手

fn accept_all_policy() -> HostKeyPolicy {
    Arc::new(|fingerprint: &str| {
        assert!(fingerprint.starts_with("SHA256:"), "指纹形态契约");
        true
    })
}

async fn connect_via(proxy: &SocketAddr, keepalive: Option<Duration>) -> SshSession {
    connect_with_keepalive(
        &proxy.ip().to_string(),
        proxy.port(),
        MOCK_USER,
        AuthMethod::Password(MOCK_PASSWORD.to_string()),
        accept_all_policy(),
        keepalive,
        None,
    )
    .await
    .expect("connect via proxy")
}

// -------------------------------------------------------------------- tests

/// 主断言：健康期零 channel 事件 + 冻结后 keepalive 量级内检测死链。
#[tokio::test]
async fn keepalive_detects_dead_link_within_max_window() {
    let sshd = spawn_mock_sshd().await;
    let (proxy, freeze) = spawn_freezable_proxy(sshd).await;
    let session = connect_via(&proxy, Some(KEEPALIVE)).await;
    let mut channel = session.open_pty(80, 24).await.expect("session channel");

    // 健康对照：keepalive 周期流动期间 channel 无任何事件（传输层全局请求
    // 不进 channel 数据流）。
    let healthy = tokio::time::timeout(HEALTHY_WINDOW, channel.wait()).await;
    assert!(
        healthy.is_err(),
        "healthy link must stay quiet on the channel, got {healthy:?}"
    );

    // 掐断转发（socket 两端保持开口）→ 死链 → keepalive 超时终止通道。
    freeze.freeze();
    let verdict = tokio::time::timeout(DEADLINE, channel.wait())
        .await
        .expect("keepalive_max×interval 内必须检测死链并终止 channel");
    assert!(
        matches!(verdict, None | Some(russh::ChannelMsg::Close)),
        "channel 终止事件，got {verdict:?}"
    );
}

/// 对照面：无 keepalive 的连接在冻结链路上不指望检测（若有事件反而是
/// 实现漂移——证明上面的检测确实来自 keepalive 而非 FIN/RST/超时兜底）。
#[tokio::test]
async fn without_keepalive_frozen_link_stays_silent() {
    let sshd = spawn_mock_sshd().await;
    let (proxy, freeze) = spawn_freezable_proxy(sshd).await;
    let session = connect_via(&proxy, None).await;
    let mut channel = session.open_pty(80, 24).await.expect("session channel");
    freeze.freeze();
    let silent = tokio::time::timeout(HEALTHY_WINDOW, channel.wait()).await;
    assert!(
        silent.is_err(),
        "no keepalive = no detection expected (control), got {silent:?}"
    );
}
