//! 真机 E2E 夹具：keyboard-interactive mock sshd（2026-11-02 批次二）。
//!
//! 起一个**进程内** sshd，只实现 keyboard-interactive 一条认证路径：
//! 服务器下发 `Verification code:` 提问，校验客户端答上来的 6 位码——
//! 与 `crates/ottr-ssh/tests/auth_mock.rs` 的 mock 同款逻辑，但**独立成
//! 可执行夹具**（测试里的 mock 跑在测试进程内，真机验证需要一个能常驻的
//! 独立进程）。
//!
//! 用途：真机（Linux 桌面）上验证 Ottr 的交互式认证全链路——
//! 「连接 → 服务器提问 → Ottr 弹窗 → TOTP 码自动填入 → 提交 → 连上」。
//! 免去 docker 依赖（`scripts/spike-sshd.sh` 需要 docker）。
//!
//! 用法：
//! ```text
//! cargo run --example mock_kbdint_server -- <端口> <TOTP 种子 base32>
//! # 例：cargo run -p ottr-ssh --example mock_kbdint_server -- 2223 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
//! ```
//! 账号固定为 `spike`，口令固定为 `spike-pass`（与仓库夹具口径一致）。

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::{Algorithm, HashAlg, PublicKey, load_secret_key};
use russh::server::{Auth, Handler, Response, Server as _};

/// 固定账号（与仓库夹具 `scripts/spike-sshd.sh` 同口径）。
const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "spike-pass";
/// 提问文本（与 `crates/ottr-ssh/tests/auth_mock.rs` 同款措辞）。
const KBD_PROMPT: &str = "Verification code";
/// 认证通过后的 shell 横幅（真机上肉眼可辨「确实连上了」）。
const SHELL_BANNER: &[u8] = b"[mock-kbdint] interactive shell ready\r\nspike@mock:~$ ";

/// 每个 client 连接一份的认证配置。
#[derive(Clone)]
struct MockAuth {
    passwords: Arc<HashMap<&'static str, &'static str>>,
    totp_seed: Arc<String>,
    /// 公钥白名单（user → 公钥）：ssh-agent 验收用。
    key_whitelist: Arc<HashMap<&'static str, PublicKey>>,
}

impl Handler for MockAuth {
    type Error = russh::Error;

    /// 公钥**探测**（客户端先问「这把钥行不行」，不带签名）。
    ///
    /// ⚠️ russh 0.63 的服务端把 publickey 分两段：先调**本方法**（探测）决定
    /// 是否回 PK_OK，客户端收到 PK_OK 才带签名重发；签名验过后才调
    /// [`auth_publickey`]。只实现后者 → 探测阶段就被拒（服务端不回 PK_OK，
    /// 客户端永远走不到签名那步）——表现为「agent 认证被拒」但服务端日志里
    /// 一条 publickey 记录都没有。**两个都要实现。**
    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        let ok = self
            .key_whitelist
            .get(user)
            .map(|expected| expected.key_data() == key.key_data())
            .unwrap_or(false);
        println!(
            "[mock-kbdint] publickey probe user={user} fp={} -> {}",
            key.fingerprint(HashAlg::Sha256),
            if ok { "ACCEPT" } else { "REJECT" }
        );
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    /// 公钥认证（**系统 ssh-agent 桥接的验收面**：agent 持钥、由 agent 签名，
    /// 服务端只见公钥）。白名单取仓库夹具 `fixtures/spike_ed25519` 的公钥——
    /// 真机验收时把同一把私钥装进 agent，即可端到端验「Ottr 侧零密钥材料」。
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = self
            .key_whitelist
            .get(user)
            .map(|expected| expected.key_data() == key.key_data())
            .unwrap_or(false);
        println!(
            "[mock-kbdint] publickey user={user} fp={} -> {}",
            key.fingerprint(HashAlg::Sha256),
            if ok { "ACCEPT" } else { "REJECT" }
        );
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(match self.passwords.get(user) {
            Some(expected) if *expected == password => Auth::Accept,
            _ => Auth::reject(),
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        match response {
            // 第一轮：下发验证码提问（不回显）。
            None => Ok(Auth::Partial {
                name: "totp".into(),
                instructions: "Enter the verification code from your authenticator".into(),
                prompts: Cow::Borrowed(&[(Cow::Borrowed(KBD_PROMPT), false)]),
            }),
            // 第二轮：校验答案。
            Some(response) => {
                let answers: Vec<String> = response
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .collect();
                let expected = current_totp(&self.totp_seed);
                let correct = answers.len() == 1 && answers[0] == expected;
                // 诊断日志：真机 E2E 靠它区分「码算错」与「码过期」——
                // 过期的表现是收到的码等于**上一时间窗**的码。
                let prev = current_totp_at(&self.totp_seed, unix_now() - 30);
                println!(
                    "[mock-kbdint] answer={:?} expected={} prev_window={} remaining={}s -> {}",
                    answers,
                    expected,
                    prev,
                    ottr_totp::remaining_seconds(unix_now(), ottr_totp::DEFAULT_PERIOD),
                    if correct { "ACCEPT" } else { "REJECT" }
                );
                Ok(if correct {
                    Auth::Accept
                } else {
                    Auth::reject()
                })
            }
        }
    }

    // --- 会话通道（认证过之后开 pty + shell）--------------------------------
    //
    // 只实现认证不实现通道的话，客户端会在 open_pty 阶段拿到
    // `AdministrativelyProhibited`——真机 E2E 会误判成「连上了但没反应」。
    // 这里开一个**回显型**极简 shell：来什么字节回什么字节。
    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let (mut read, write) = channel.split();
        tokio::spawn(async move {
            if write.data_bytes(SHELL_BANNER.to_vec()).await.is_err() {
                return;
            }
            loop {
                match read.wait().await {
                    Some(russh::ChannelMsg::Data { data }) => {
                        if write.data_bytes(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Some(russh::ChannelMsg::Eof)
                    | Some(russh::ChannelMsg::Close)
                    | Some(russh::ChannelMsg::ExitStatus { .. })
                    | None => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: russh::ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
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

/// 当前 Unix 秒。
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 按种子 + 指定时刻算期望验证码（与 Ottr 客户端同一 RFC 6238 实现）。
fn current_totp_at(seed_b32: &str, unix_time: i64) -> String {
    ottr_totp::generate_from_base32(
        seed_b32,
        unix_time,
        ottr_totp::DEFAULT_DIGITS,
        ottr_totp::DEFAULT_PERIOD,
    )
    .unwrap_or_default()
}

/// 仓库夹具公钥（`fixtures/spike_ed25519`）——公钥白名单用。
fn fixture_public_key() -> Result<PublicKey, Box<dyn std::error::Error>> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/spike_ed25519");
    Ok(load_secret_key(path, None)?.public_key().clone())
}

/// 按种子 + 当前时间算期望验证码。
fn current_totp(seed_b32: &str) -> String {
    current_totp_at(seed_b32, unix_now())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2223);
    // 期望验证码的**种子**（base32）——服务端按当前时间实时算，与客户端同源。
    let totp_seed = args
        .next()
        .unwrap_or_else(|| "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".to_string());

    let host_key = russh::keys::PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let config = Arc::new(russh::server::Config {
        auth_rejection_time: Duration::from_millis(20),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![host_key.clone()],
        inactivity_timeout: None,
        ..Default::default()
    });

    let auth = MockAuth {
        passwords: Arc::new(HashMap::from([(MOCK_USER, MOCK_PASSWORD)])),
        totp_seed: Arc::new(totp_seed.clone()),
        key_whitelist: Arc::new(HashMap::from([(MOCK_USER, fixture_public_key()?)])),
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!(
        "[mock-kbdint] listening on 127.0.0.1:{port}  user={MOCK_USER}  totp_seed={totp_seed}"
    );

    let mut sshd = MockSshd { auth };
    sshd.run_on_socket(config, &listener).await?;
    Ok(())
}
