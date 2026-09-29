//! Spike #5: 跳板链的 mock 集成测试（进程内 sshd，模式复用 tests/auth_mock.rs）。
//!
//! 锁住 jump::connect 的两条核心路径：
//! 1. 两跳成功路径：链 = [mock, mock]，target = mock —— 隧道经 mock 的
//!    direct-tcpip handler（TCP 连接 + accept + 双向泵字节）回到 mock 自身，
//!    最终会话必须完成完整握手 + 认证（host key 指纹可证）。
//! 2. 断点定位路径：链 = [mock, {死端口}] 必须在 3 秒内返回
//!    `JumpError::HopFailed { index: 1 }`（不是笼统超时）；另覆盖断在第 0 跳
//!    与断在 target（index = chain.len()）的序号归属。
//!
//! 台账裁定（T2）：跳板链先以 mock 锁行为，真夹具（容器内自连）由
//! examples/jump_spike.rs 验证。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ottr_ssh::{AuthMethod, Error, HopSpec, JumpError, jump};
use russh::Channel;
use russh::keys::{Algorithm, HashAlg, PrivateKey};
use russh::server::{Auth, ChannelOpenHandle, Server as _};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 断点定位红线：带跳序号的错误必须 3 秒内返回（简报 Step 3）。
const BREAKPOINT_BUDGET: Duration = Duration::from_secs(3);

// Mock 服务的账号体系（写死，与真实夹具的 spike/spike-pass 无关）。
const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "mock-pass";

// ---------------------------------------------------------------- mock sshd

/// 每个连接一份的认证配置（Arc 共享，Clone 传入新连接）。
#[derive(Clone)]
struct MockAuth {
    passwords: Arc<std::collections::HashMap<&'static str, &'static str>>,
}

impl russh::server::Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(match self.passwords.get(user) {
            Some(expected) if *expected == password => Auth::Accept,
            _ => Auth::reject(),
        })
    }

    /// direct-tcpip：连上 `(host, port)` 后 accept，再 **spawn** 双向泵。
    ///
    /// 必须 spawn：russh 服务端在同一连接的读循环里 await 本 handler，
    /// 若原地 `copy_bidirectional` 会占死读循环、通道数据无法分发，链路死锁。
    /// 连接失败 → `reject(ConnectFailed)` → 客户端侧 `channel_open_direct_tcpip`
    /// 立即收到 CHANNEL_OPEN_FAILURE（断点定位的「秒回」依据）。
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<russh::server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
            Ok(mut tcp) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut tunnel = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tunnel, &mut tcp).await;
                });
            }
            Err(_) => {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
    }
}

struct MockSshd {
    auth: MockAuth,
}

impl russh::server::Server for MockSshd {
    type Handler = MockAuth;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        self.auth.clone()
    }
}

/// 起一个内存 sshd，返回监听地址与本次会话的 host key。
async fn spawn_mock_sshd() -> (SocketAddr, PrivateKey) {
    let host_key =
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("generate host key");
    let config = Arc::new(russh::server::Config {
        auth_rejection_time: Duration::from_millis(20),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![host_key.clone()],
        inactivity_timeout: None,
        ..Default::default()
    });

    let auth = MockAuth {
        passwords: Arc::new(std::collections::HashMap::from([(
            MOCK_USER,
            MOCK_PASSWORD,
        )])),
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock sshd");
    let addr = listener.local_addr().expect("mock sshd local addr");

    let mut sshd = MockSshd { auth };
    tokio::spawn(async move {
        let _ = sshd.run_on_socket(config, &listener).await;
    });

    (addr, host_key)
}

// ---------------------------------------------------------------- helpers

/// spike 阶段 mock 策略：一律接受（真夹具 example 走 pin 指纹）。
fn accept_all_policy() -> ottr_ssh::HostKeyPolicy {
    Arc::new(|_fingerprint: &str| true)
}

fn hop_to(addr: SocketAddr) -> HopSpec {
    HopSpec {
        host: addr.ip().to_string(),
        port: addr.port(),
        username: MOCK_USER.into(),
        auth: AuthMethod::Password(MOCK_PASSWORD.into()),
        host_key: accept_all_policy(),
    }
}

/// 挖一个「无服务」端口：绑定后立即释放，得到确定无监听的端口号
/// （连接被即时拒绝，不会像「绑定不 accept」那样悬挂在 backlog 上）。
fn dead_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind to reserve port");
    let port = listener.local_addr().expect("reserved port").port();
    drop(listener);
    port
}

fn dead_hop() -> HopSpec {
    HopSpec {
        host: "127.0.0.1".into(),
        port: dead_port(),
        username: MOCK_USER.into(),
        auth: AuthMethod::Password(MOCK_PASSWORD.into()),
        host_key: accept_all_policy(),
    }
}

fn fingerprint_of(key: &PrivateKey) -> String {
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn two_hop_chain_reaches_target() {
    let (addr, host_key) = spawn_mock_sshd().await;

    // 链 = [mock, mock]，target = mock：两级 direct-tcpip 隧道嵌套。
    let session = tokio::time::timeout(
        TEST_TIMEOUT,
        jump::connect(vec![hop_to(addr), hop_to(addr)], hop_to(addr)),
    )
    .await
    .expect("two-hop chain must finish within timeout")
    .expect("two-hop chain must reach the target");

    // 最终会话必须真实完成过握手 + 认证（指纹 = mock sshd 的 host key）。
    let expected = fingerprint_of(&host_key);
    assert_eq!(
        session.host_key_fingerprint().as_deref(),
        Some(expected.as_str()),
        "final session must have handshaked with the mock sshd host key"
    );
}

#[tokio::test]
async fn dead_second_hop_reports_index_1_fast() {
    let (addr, _host_key) = spawn_mock_sshd().await;
    let mut bad = hop_to(addr);
    bad.port = dead_port();

    let started = Instant::now();
    let result = tokio::time::timeout(
        BREAKPOINT_BUDGET,
        jump::connect(vec![hop_to(addr), bad], hop_to(addr)),
    )
    .await
    .expect("breakpoint error must surface within the 3s budget (not a vague timeout)");
    let elapsed = started.elapsed();

    let err = result.expect_err("dead second hop must fail");
    match err {
        JumpError::HopFailed { index, source } => {
            assert_eq!(
                index, 1,
                "failure must be attributed to the second hop (index 1)"
            );
            assert!(
                matches!(&*source, Error::Protocol { .. }),
                "underlying cause must be Protocol (CHANNEL_OPEN_FAILURE), got {source:?}"
            );
        }
    }
    assert!(
        elapsed < BREAKPOINT_BUDGET,
        "breakpoint location took {elapsed:?}, budget is {BREAKPOINT_BUDGET:?}"
    );
}

#[tokio::test]
async fn dead_first_hop_reports_index_0() {
    let (addr, _host_key) = spawn_mock_sshd().await;

    let result = tokio::time::timeout(TEST_TIMEOUT, jump::connect(vec![dead_hop()], hop_to(addr)))
        .await
        .expect("unreachable first hop must fail fast, not hang");

    match result.expect_err("unreachable first hop must fail") {
        JumpError::HopFailed { index, .. } => {
            assert_eq!(
                index, 0,
                "failure must be attributed to the first hop (index 0)"
            );
        }
    }
}

#[tokio::test]
async fn dead_target_reports_index_chain_len() {
    let (addr, _host_key) = spawn_mock_sshd().await;

    // 一跳跳板可达，target 不可达：index = chain.len() = 1（target 的序号）。
    let result = tokio::time::timeout(TEST_TIMEOUT, jump::connect(vec![hop_to(addr)], dead_hop()))
        .await
        .expect("unreachable target must fail fast, not hang");

    match result.expect_err("unreachable target must fail") {
        JumpError::HopFailed { index, .. } => {
            assert_eq!(
                index, 1,
                "target failure must be attributed to index = chain.len()"
            );
        }
    }
}
