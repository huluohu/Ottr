//! JumpSession wire 级 TDD（Phase 2 Task 2 Step 2）：进程内 mock sshd 三实例
//! 组成「两跳跳板 + target」拓扑（Phase 0 auth_mock 多实例先例，russh
//! `server::run_stream` + 自持 accept 循环），全链跑真实 SSH 协议字节。
//!
//! 与 Phase 0 session.rs 的 A1 mock 的差别：本 mock 额外实现
//! * `channel_open_direct_tcpip`：TCP 连通 → accept + 双向泵（隧道语义）；
//!   连不通 → `reject(ConnectFailed)`（真实 sshd 的行为，断点定位的依据）；
//! * `exec_request`：channel_success → data(whoami 结果) → exit_status →
//!   eof → close（target 上的命令执行闭环）。
//!
//! 断点观测：每实例 Ledger 记 `connected`（auth_succeeded）与 `closed`
//! （run_stream 会话结束 = 连接终结——显式 DISCONNECT 或裸 drop 收尾都触发）。
//! teardown 断言 = 断开后各实例 `closed` 在预算内计数（服务端会话终结，
//! 这是 Phase 0 挂账「中间跳无法显式拆除」的清偿证据）。
//!
//! Run: `cargo test -p ottr-ssh --test jump_session_mock`

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_ssh::jump_session::JumpSession;
use ottr_ssh::{AuthMethod, HopSpec};

const TEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 断点定位红线（B7 承诺：显式协议错误，不是笼统超时）。
const BREAKPOINT_BUDGET: Duration = Duration::from_secs(3);
/// teardown 收敛预算（本机环回毫秒级可达；5s 已是宽限）。
const TEARDOWN_BUDGET: Duration = Duration::from_secs(5);

/// 每实例观测账本。
#[derive(Default)]
struct Ledger {
    connected: AtomicU64,
    closed: AtomicU64,
}

impl Ledger {
    fn connected(&self) -> u64 {
        self.connected.load(Ordering::SeqCst)
    }
    fn closed(&self) -> u64 {
        self.closed.load(Ordering::SeqCst)
    }
}

struct MockHandler {
    ledger: Arc<Ledger>,
}

impl russh::server::Handler for MockHandler {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        _user: &str,
        _password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }

    async fn auth_succeeded(
        &mut self,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.ledger.connected.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    // target 上的会话通道：accept（exec_request 里 channel_success 前置）。
    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    // exec 闭环：固定回 "mock-user" + exit 0（whoami 语义）。
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        _data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, &b"mock-user"[..])?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    // 隧道语义：TCP 连通 → accept + 双向泵；连不通 → ConnectFailed（立即）。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
            Ok(tcp) => {
                reply.accept().await;
                let mut stream = channel.into_stream();
                tokio::spawn(async move {
                    let mut tcp = tcp;
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                });
            }
            Err(_) => {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
    }
}

/// 起一个 mock sshd（127.0.0.1 随机端口），返回 (地址, 账本)。
async fn spawn_mock_sshd() -> (std::net::SocketAddr, Arc<Ledger>) {
    let ledger = Arc::new(Ledger::default());
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("mock sshd Ed25519 host key");
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ledger_for_task = Arc::clone(&ledger);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let cfg = Arc::clone(&config);
            let led = Arc::clone(&ledger_for_task);
            tokio::spawn(async move {
                let handler = MockHandler {
                    ledger: led.clone(),
                };
                if let Ok(session) = russh::server::run_stream(cfg, stream, handler).await {
                    let _ = session.await;
                }
                led.closed.fetch_add(1, Ordering::SeqCst);
            });
        }
    });
    (addr, ledger)
}

fn hop(addr: std::net::SocketAddr) -> HopSpec {
    HopSpec {
        host: addr.ip().to_string(),
        port: addr.port(),
        username: "tester".into(),
        auth: AuthMethod::Password("pw".into()),
        // 测试面：指纹全放行（主机密钥策略语义由 src-tauri TOFU 层测试承担）
        host_key: Arc::new(|_| true),
    }
}

/// 铸一个「保证无服务」的本地端口（bind 后即弃）。
async fn dead_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

/// 轮询等账本 closed 达到阈值（teardown 收敛观测）。
async fn wait_closed(led: &Ledger, at_least: u64) -> bool {
    let deadline = Instant::now() + TEARDOWN_BUDGET;
    while Instant::now() < deadline {
        if led.closed() >= at_least {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    led.closed() >= at_least
}

/// 在 target 上跑一次 exec whoami（SshSession::exec 全闭环）。
async fn whoami(session: &ottr_ssh::SshSession) -> String {
    let out = tokio::time::timeout(TEST_TIMEOUT, session.exec("whoami"))
        .await
        .expect("exec timeout")
        .expect("exec");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

// --- 全链通 + 显式 teardown：三跳拓扑上 exec，断开后三实例会话全部终结 ----

#[tokio::test(flavor = "multi_thread")]
async fn full_chain_exec_then_disconnect_tears_down_all_hops() {
    let (m0, l0) = spawn_mock_sshd().await;
    let (m1, l1) = spawn_mock_sshd().await;
    let (m2, l2) = spawn_mock_sshd().await;

    let js = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(vec![hop(m0), hop(m1)], hop(m2)),
    )
    .await
    .expect("chain connect timeout")
    .expect("three-leg chain must connect");
    assert_eq!(js.hop_count(), 2);

    // 三实例都看到了成功认证的连接（链路逐跳建立）。
    assert!(l0.connected() >= 1 && l1.connected() >= 1 && l2.connected() >= 1);
    // target 上命令闭环：协议字节穿过两级隧道往返。
    assert_eq!(whoami(&js.target()).await, "mock-user");

    // 显式 teardown：Ok 返回 + 三实例服务端会话在预算内终结。
    js.disconnect().await.expect("disconnect");
    assert!(wait_closed(&l0, 1).await, "hop0 服务端会话未终结");
    assert!(wait_closed(&l1, 1).await, "hop1 服务端会话未终结");
    assert!(wait_closed(&l2, 1).await, "target 服务端会话未终结");
}

// --- 中间跳断点：HopFailed index=1 + 已建立跳板被立即拆除（失败路径 teardown）----

#[tokio::test(flavor = "multi_thread")]
async fn middle_hop_failure_locates_breakpoint_and_tears_down_established_hops() {
    let (m0, l0) = spawn_mock_sshd().await;
    let (_m1_unused, _l1_unused) = spawn_mock_sshd().await; // 占位：链上第二跳用死端口
    let dead = dead_port().await;

    let started = Instant::now();
    let result = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(
            vec![hop(m0), hop_no_auth("127.0.0.1", dead)],
            hop_no_auth("127.0.0.1", 22),
        ),
    )
    .await
    .expect("connect must fail within TEST_TIMEOUT, not hang");
    let elapsed = started.elapsed();

    match result {
        Ok(_) => panic!("chain through dead port {dead} must not succeed"),
        Err(ottr_ssh::JumpError::HopFailed { index, source }) => {
            assert_eq!(index, 1, "断点必须定位在中间跳（index=1）: {source}");
            assert!(
                elapsed < BREAKPOINT_BUDGET,
                "断点定位 {elapsed:?} 超出 3s 红线（应为立即协议错误，非笼统超时）"
            );
        }
    }

    // 失败路径 teardown：已建立的 hop0 必须被显式拆除（A1 语义在链上的扩展）。
    assert!(
        wait_closed(&l0, 1).await,
        "HopFailed 后已建立跳板的服务端会话未终结（失败路径泄漏）"
    );
}

// --- 首跳断点：本地 TCP 直连失败 → index=0（无会话可拆，不 panic）----------

#[tokio::test(flavor = "multi_thread")]
async fn first_hop_failure_reports_index_zero() {
    let dead = dead_port().await;
    let started = Instant::now();
    let result = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(
            vec![hop_no_auth("127.0.0.1", dead)],
            hop_no_auth("127.0.0.1", 22),
        ),
    )
    .await
    .expect("connect must fail within TEST_TIMEOUT");
    let elapsed = started.elapsed();
    match result {
        Ok(_) => panic!("chain through dead port {dead} must not succeed"),
        Err(ottr_ssh::JumpError::HopFailed { index, .. }) => {
            assert_eq!(index, 0, "首跳失败必须定位在 index=0");
            assert!(elapsed < BREAKPOINT_BUDGET, "首跳失败 {elapsed:?} 超红线");
        }
    }
}

// --- target 断点：跳板全通、隧道到 target 失败 → index=chain.len() + 跳板拆除 --

#[tokio::test(flavor = "multi_thread")]
async fn target_failure_reports_chain_len_and_tears_down_hops() {
    let (m0, l0) = spawn_mock_sshd().await;
    let dead = dead_port().await;

    let result = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(vec![hop(m0)], hop_no_auth("127.0.0.1", dead)),
    )
    .await
    .expect("connect must fail within TEST_TIMEOUT");
    match result {
        Ok(_) => panic!("chain to dead target port {dead} must not succeed"),
        Err(ottr_ssh::JumpError::HopFailed { index, .. }) => {
            assert_eq!(index, 1, "target 失败的跳序号 = 跳板数（1）");
        }
    }
    assert!(wait_closed(&l0, 1).await, "target 失败后跳板未拆除");
}

// --- Drop 兜底：未显式 disconnect 就 drop → 后台补断连（尽力而为契约）-------

#[tokio::test(flavor = "multi_thread")]
async fn drop_without_disconnect_still_tears_down_in_runtime_context() {
    let (m0, l0) = spawn_mock_sshd().await;
    let (m1, l1) = spawn_mock_sshd().await;

    {
        let js = tokio::time::timeout(TEST_TIMEOUT, JumpSession::connect(vec![hop(m0)], hop(m1)))
            .await
            .expect("connect timeout")
            .expect("chain");
        let _ = whoami(&js.target()).await;
        // 不调 disconnect，直接出作用域 drop——Drop 兜底应 spawn 后台拆除。
    }

    assert!(wait_closed(&l0, 1).await, "drop 后 hop0 服务端会话未终结");
    assert!(wait_closed(&l1, 1).await, "drop 后 target 服务端会话未终结");
}

// --- 空链退化：直连 target（跳序号 0 语义与 jump::connect 空链分支一致）------

#[tokio::test(flavor = "multi_thread")]
async fn empty_chain_degrades_to_direct_target() {
    let (m, l) = spawn_mock_sshd().await;
    let js = tokio::time::timeout(TEST_TIMEOUT, JumpSession::connect(vec![], hop(m)))
        .await
        .expect("connect timeout")
        .expect("empty chain = direct");
    assert_eq!(js.hop_count(), 0);
    assert_eq!(whoami(&js.target()).await, "mock-user");
    js.disconnect().await.expect("disconnect");
    assert!(wait_closed(&l, 1).await);
}

/// hop 规格变体（host/port 直填；断点用——dead port 无服务，认证无所谓）。
fn hop_no_auth(host: &str, port: u16) -> HopSpec {
    HopSpec {
        host: host.into(),
        port,
        username: "tester".into(),
        auth: AuthMethod::Password("pw".into()),
        host_key: Arc::new(|_| true),
    }
}
