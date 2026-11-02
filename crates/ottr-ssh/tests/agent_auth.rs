//! 系统 ssh-agent 认证的**真实端到端**测试（2026-11-03，批次五 P2）。
//!
//! 跑的是真链路：真实的 `ssh-agent` 进程（`$SSH_AUTH_SOCK`）→ 我们的 agent
//! 客户端（russh）→ 外部签名器 → 进程内 mock sshd 的 publickey 认证。
//! 验的是「私钥不出 agent 进程、Ottr 侧零密钥材料」这条承诺确实成立。
//!
//! 前置条件：当前 shell 的 `$SSH_AUTH_SOCK` 指向一个**已加载夹具密钥**的
//! ssh-agent。没满足时本文件**整体跳过**（打印说明，不算失败）——CI 机器上
//! 通常没有这样的 agent，硬失败会变成噪声。
//!
//! 手动跑法：
//! ```bash
//! eval "$(ssh-agent -s)"
//! ssh-add crates/ottr-ssh/fixtures/spike_ed25519
//! cargo test -p ottr-ssh --test agent_auth -- --nocapture
//! ```

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ottr_ssh::{AuthMethod, HostKeyPolicy};
use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey, load_secret_key};
use russh::server::{Auth, Server as _};

const TEST_TIMEOUT: Duration = Duration::from_secs(15);
const MOCK_USER: &str = "spike";
const FIXTURE_KEY_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/spike_ed25519");

// ---------------------------------------------------------------- mock sshd

#[derive(Clone)]
struct MockAuth {
    key_whitelist: Arc<HashMap<&'static str, PublicKey>>,
}

impl russh::server::Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = self
            .key_whitelist
            .get(user)
            .map(|expected| expected.key_data() == key.key_data())
            .unwrap_or(false);
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }
}

struct MockSshd {
    auth: MockAuth,
}

impl russh::server::Server for MockSshd {
    type Handler = MockAuth;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
        self.auth.clone()
    }
}

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
    let fixture = load_secret_key(FIXTURE_KEY_PATH, None).expect("load fixture key");
    let auth = MockAuth {
        key_whitelist: Arc::new(HashMap::from([(MOCK_USER, fixture.public_key().clone())])),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock sshd");
    let addr = listener.local_addr().expect("mock addr");
    let mut sshd = MockSshd { auth };
    tokio::spawn(async move {
        let _ = sshd.run_on_socket(config, &listener).await;
    });
    (addr, host_key)
}

/// 放行一切主机密钥（测试只关心认证路径）。
fn accept_any_host_key() -> HostKeyPolicy {
    Arc::new(|_| true)
}

/// agent 里是否有「夹具那把钥匙」——没有就跳过本用例（不是失败：
/// 机器上的 agent 里装的是别的钥匙）。
///
/// **必须是 async**：早期版本用同步 block_on 包 async，在 tokio 运行时线程里
/// 堵死了 IO 驱动 → 测试挂住（不是超时，是死等）。这里直接 await。
async fn agent_has_fixture_key() -> bool {
    let Ok(session) = ottr_ssh::agent::AgentSession::connect(None).await else {
        return false;
    };
    let fixture = load_secret_key(FIXTURE_KEY_PATH, None).expect("load fixture key");
    let want = fixture.public_key().key_data();
    session.identities().iter().any(|id| match id {
        russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.key_data() == want,
        _ => false,
    })
}

#[tokio::test]
async fn agent_authenticates_with_a_key_held_only_by_the_agent() {
    if std::env::var("SSH_AUTH_SOCK").is_err() {
        eprintln!("跳过：没有 $SSH_AUTH_SOCK（机器上没有运行中的 ssh-agent）");
        return;
    }
    if !agent_has_fixture_key().await {
        eprintln!("跳过：agent 里没有夹具密钥（先 ssh-add fixtures/spike_ed25519）");
        return;
    }

    let (addr, host_key) = spawn_mock_sshd().await;
    let session = tokio::time::timeout(
        TEST_TIMEOUT,
        ottr_ssh::connect(
            &addr.ip().to_string(),
            addr.port(),
            MOCK_USER,
            AuthMethod::Agent { socket: None },
            accept_any_host_key(),
        ),
    )
    .await
    .expect("connect must finish within timeout")
    .expect("agent auth must succeed");

    assert_eq!(
        session.host_key_fingerprint(),
        Some(
            host_key
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
        ),
        "认证成功后会话应记录服务器指纹"
    );
}

#[tokio::test]
async fn agent_without_identities_is_rejected_with_a_readable_reason() {
    // 连**活着的** mock sshd，但 agent 指向一个不存在的 socket →
    // 失败必须发生在 agent 侧（而不是 TCP 层），且错误可读（不是静默挂起）。
    let (addr, _host_key) = spawn_mock_sshd().await;
    let err = ottr_ssh::connect(
        &addr.ip().to_string(),
        addr.port(),
        MOCK_USER,
        AuthMethod::Agent {
            socket: Some(std::path::PathBuf::from("/tmp/ottr-no-such-agent.sock")),
        },
        accept_any_host_key(),
    )
    .await
    .expect_err("连不上的 agent 必须失败");
    let msg = err.to_string();
    assert!(
        msg.contains("ssh-agent") || msg.contains("agent"),
        "错误应说清是 agent 侧问题：{msg}"
    );
}
