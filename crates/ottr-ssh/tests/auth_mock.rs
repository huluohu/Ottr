//! Spike #1: 三种认证的进程内 mock 集成测试。
//!
//! 用 russh 的 server API 起内存 sshd（监听 127.0.0.1:0，密码表与密钥白名单写死），
//! 驱动 `ottr_ssh::connect` 走 password / publickey / keyboard-interactive 三条认证路径。
//!
//! 台账裁定：keyboard-interactive 以 mock server 验证（真实 PAM TOTP 不在本 spike 范围）。

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_ssh::{AuthMethod, Error, HostKeyPolicy, connect};
use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey, load_secret_key};
use russh::server::{Auth, Response, Server as _};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

// Mock 服务的账号体系（写死，与真实夹具的 spike/spike-pass 无关）。
const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "mock-pass";
const MOCK_TOTP_CODE: &str = "123456";
const KBD_PROMPT: &str = "Verification code";

// Task 2 产出的真实夹具密钥（无口令），mock 的密钥白名单取其公钥。
const FIXTURE_KEY_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/spike_ed25519");

fn fixture_key() -> PrivateKey {
    load_secret_key(FIXTURE_KEY_PATH, None).expect("load fixtures/spike_ed25519")
}

// ---------------------------------------------------------------- mock sshd

/// 每个 client 连接一份的认证配置（Arc 共享，Clone 传入新连接）。
#[derive(Clone)]
struct MockAuth {
    /// user -> password，写死。
    passwords: Arc<HashMap<&'static str, &'static str>>,
    /// user -> 允许的公钥白名单，写死。
    key_whitelist: Arc<HashMap<&'static str, PublicKey>>,
    /// keyboard-interactive 期望的验证码。
    totp_code: Arc<String>,
}

impl russh::server::Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<Auth, Self::Error> {
        Ok(match self.passwords.get(user) {
            Some(expected) if *expected == password => Auth::Accept,
            _ => Auth::reject(),
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        // 白名单按密钥材料比较（PublicKey 的 PartialEq 含 comment 字段，
        // 私钥文件与 .pub 文件携带的 comment 不同会导致误判）。
        let whitelisted = self
            .key_whitelist
            .get(user)
            .is_some_and(|allowed| allowed.key_data() == key.key_data());
        Ok(if whitelisted { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        match response {
            // 第一轮：下发一个 TOTP prompt（不回显）。
            None => Ok(Auth::Partial {
                name: "totp".into(),
                instructions: "Enter the verification code from your authenticator".into(),
                prompts: Cow::Borrowed(&[(Cow::Borrowed(KBD_PROMPT), false)]),
            }),
            // 第二轮：校验客户端收集 prompt 后回的验证码。
            Some(response) => {
                let answers: Vec<String> = response
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .collect();
                let correct = answers.len() == 1 && answers[0] == *self.totp_code;
                Ok(if correct { Auth::Accept } else { Auth::reject() })
            }
        }
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
        passwords: Arc::new(HashMap::from([(MOCK_USER, MOCK_PASSWORD)])),
        key_whitelist: Arc::new(HashMap::from([(
            MOCK_USER,
            fixture_key().public_key().clone(),
        )])),
        totp_code: Arc::new(MOCK_TOTP_CODE.to_string()),
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

type FingerprintLog = Arc<Mutex<Vec<String>>>;

/// spike 阶段策略：一律接受，但必须记录指纹（由被测 connect 内部记录）。
fn recording_policy(log: &FingerprintLog) -> ottr_ssh::HostKeyPolicy {
    let log = Arc::clone(log);
    Arc::new(move |fingerprint: &str| {
        log.lock().unwrap().push(fingerprint.to_string());
        true
    })
}

async fn connect_with_timeout(
    addr: SocketAddr,
    user: &str,
    auth: AuthMethod,
    log: &FingerprintLog,
) -> Result<ottr_ssh::SshSession, ottr_ssh::Error> {
    let host = addr.ip().to_string();
    tokio::time::timeout(
        TEST_TIMEOUT,
        connect(&host, addr.port(), user, auth, recording_policy(log)),
    )
    .await
    .expect("connect must finish within timeout")
}

fn fingerprint_of(key: &PrivateKey) -> String {
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn password_auth_ok() {
    let (addr, host_key) = spawn_mock_sshd().await;
    let fingerprints: FingerprintLog = Arc::new(Mutex::new(Vec::new()));

    let session = connect_with_timeout(
        addr,
        MOCK_USER,
        AuthMethod::Password(MOCK_PASSWORD.to_string()),
        &fingerprints,
    )
    .await
    .expect("password auth with correct password must succeed");

    // check_server_key 必须真实记录了 mock sshd 的 host key 指纹。
    let expected = fingerprint_of(&host_key);
    assert_eq!(
        fingerprints.lock().unwrap().as_slice(),
        [expected.as_str()],
        "check_server_key must record the server host key fingerprint"
    );
    assert_eq!(
        session.host_key_fingerprint().as_deref(),
        Some(expected.as_str()),
        "SshSession must expose the recorded host key fingerprint"
    );
}

#[tokio::test]
async fn password_auth_wrong() {
    let (addr, _host_key) = spawn_mock_sshd().await;
    let fingerprints: FingerprintLog = Arc::new(Mutex::new(Vec::new()));

    let result = connect_with_timeout(
        addr,
        MOCK_USER,
        AuthMethod::Password("wrong-pass".to_string()),
        &fingerprints,
    )
    .await;

    let err = result.expect_err("password auth with wrong password must fail");
    assert!(
        matches!(err, Error::AuthRejected { .. }),
        "expected AuthRejected, got {err:?}"
    );
    // 主机密钥交换先于认证，即使认证失败指纹也应被记录。
    assert_eq!(
        fingerprints.lock().unwrap().len(),
        1,
        "host key fingerprint must be recorded even when auth fails"
    );
}

#[tokio::test]
async fn key_auth_ok() {
    let (addr, host_key) = spawn_mock_sshd().await;
    let fingerprints: FingerprintLog = Arc::new(Mutex::new(Vec::new()));

    let session = connect_with_timeout(
        addr,
        MOCK_USER,
        AuthMethod::Key {
            path: FIXTURE_KEY_PATH.into(),
            passphrase: None,
        },
        &fingerprints,
    )
    .await
    .expect("key auth with whitelisted fixture key must succeed");

    let expected = fingerprint_of(&host_key);
    assert_eq!(
        session.host_key_fingerprint().as_deref(),
        Some(expected.as_str()),
        "SshSession must expose the recorded host key fingerprint"
    );

    // 负向对照：同一把密钥但不在白名单的用户必须被拒。
    let intruder = connect_with_timeout(
        addr,
        "intruder",
        AuthMethod::Key {
            path: FIXTURE_KEY_PATH.into(),
            passphrase: None,
        },
        &fingerprints,
    )
    .await;
    let err = intruder.expect_err("key auth for a user outside the whitelist must fail");
    assert!(
        matches!(err, Error::AuthRejected { .. }),
        "expected AuthRejected, got {err:?}"
    );
}

#[tokio::test]
async fn host_key_mismatch_is_rejected_not_silently_accepted() {
    let (addr, host_key) = spawn_mock_sshd().await;
    // 策略拒绝一切主机密钥（模拟 pin 不匹配）。
    let deny_all: HostKeyPolicy = Arc::new(|_fingerprint: &str| false);
    let host = addr.ip().to_string();
    let result = tokio::time::timeout(
        TEST_TIMEOUT,
        connect(
            &host,
            addr.port(),
            MOCK_USER,
            AuthMethod::Password(MOCK_PASSWORD.to_string()),
            deny_all,
        ),
    )
    .await
    .expect("connect must finish within timeout");

    let err = result.expect_err("connection with deny-all host key policy must fail");
    let actual_fp = match &err {
        Error::HostKeyRejected { fingerprint, .. } => fingerprint.clone(),
        other => panic!("expected Error::HostKeyRejected, got {other:?}"),
    };
    assert_eq!(
        actual_fp,
        fingerprint_of(&host_key),
        "HostKeyRejected must carry the server's actual fingerprint"
    );
}

#[tokio::test]
async fn keyboard_interactive_collects_code() {
    let (addr, host_key) = spawn_mock_sshd().await;
    let fingerprints: FingerprintLog = Arc::new(Mutex::new(Vec::new()));

    // client 端 keyboard-interactive 回调：收集 prompt 并回验证码（后续接 TOTP UI）。
    let prompts_seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let prompts_seen_in_cb = Arc::clone(&prompts_seen);
    let responder = Arc::new(move |prompts: &[String]| -> Vec<String> {
        prompts_seen_in_cb
            .lock()
            .unwrap()
            .extend(prompts.iter().cloned());
        vec![MOCK_TOTP_CODE.to_string(); prompts.len()]
    });

    let session = connect_with_timeout(
        addr,
        MOCK_USER,
        AuthMethod::KeyboardInteractive { responder },
        &fingerprints,
    )
    .await
    .expect("keyboard-interactive with correct code must succeed");

    assert_eq!(
        *prompts_seen.lock().unwrap(),
        vec![KBD_PROMPT.to_string()],
        "client keyboard-interactive callback must collect the server prompt"
    );
    let expected = fingerprint_of(&host_key);
    assert_eq!(
        session.host_key_fingerprint().as_deref(),
        Some(expected.as_str()),
        "SshSession must expose the recorded host key fingerprint"
    );
}
