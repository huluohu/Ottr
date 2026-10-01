//! 认证：`AuthMethod` 三种方式 + russh client `Handler`（host key 记录）。
//!
//! spike 阶段 host key 策略由 `HostKeyPolicy` 决定：mock 测试一律接受但必须记录；
//! 打真实夹具时必须 pin 指纹（不允许静默跳过校验）。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};

use crate::forward::RemoteForwardRouter;
use crate::{Error, KeyError};

/// host key 策略回调：入参为 `SHA256:…` 形式的指纹，返回是否接受该主机密钥。
/// 返回 false 时连接失败（不会静默跳过校验）。
pub type HostKeyPolicy = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// keyboard-interactive 的 prompt 响应回调：入参为服务器下发的 prompt 文本列表，
/// 返回与 prompt 数量一致的答案列表。spike 后接 TOTP UI（进程内弹窗/输入框）。
pub type PromptResponder = Arc<dyn Fn(&[String]) -> Vec<String> + Send + Sync>;

/// 认证方式。
pub enum AuthMethod {
    /// 密码认证。
    Password(String),
    /// 私钥认证。`path` 为 OpenSSH 私钥文件，`passphrase` 为解密口令（无口令传 `None`）。
    Key {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// keyboard-interactive（TOTP 等挑战应答）。`responder` 收集 prompt 并给出答案。
    KeyboardInteractive { responder: PromptResponder },
}

/// russh client Handler：
/// - `check_server_key` 记录服务器主机密钥（原始字节 + SHA256 指纹），再交策略回调裁定；
///   策略拒绝时记录被拒指纹，供 `connect` 把 russh 的 UnknownKey 映射为
///   [`Error::HostKeyRejected`]（不把 russh 错误类型暴露给消费方）；
/// - keyboard-interactive 不在本 Handler（russh 0.63 由调用方驱动 start/respond 循环，
///   见 [`crate::auth::authenticate`]）。
pub(crate) struct ClientAuthHandler {
    policy: HostKeyPolicy,
    /// 记录的主机公钥原始字节（ssh public key blob）。
    host_key_bytes: Arc<Mutex<Vec<u8>>>,
    /// 记录的 `SHA256:…` 指纹（按记录顺序）。
    host_key_fingerprints: Arc<Mutex<Vec<String>>>,
    /// 策略拒绝时的服务器指纹（Some 即发生过拒绝）。
    host_key_rejected: Arc<Mutex<Option<String>>>,
    /// remote(-R) 转发的入站路由（Phase 2 Task 1）：sshd 侧监听端口收到连接时
    /// 以 `forwarded-tcpip` channel 打开到达本回调——按 (connected_address,
    /// connected_port) 查表投递给 remote runner（见 forward.rs
    /// RemoteForwardRouter）。None（绝大多数连接）= 默认行为：接受后无人消费、
    /// channel 随 drop 关闭。
    forward_router: Option<RemoteForwardRouter>,
}

impl ClientAuthHandler {
    pub(crate) fn new(
        policy: HostKeyPolicy,
        host_key_bytes: Arc<Mutex<Vec<u8>>>,
        host_key_fingerprints: Arc<Mutex<Vec<String>>>,
        host_key_rejected: Arc<Mutex<Option<String>>>,
        forward_router: Option<RemoteForwardRouter>,
    ) -> Self {
        Self {
            policy,
            host_key_bytes,
            host_key_fingerprints,
            host_key_rejected,
            forward_router,
        }
    }
}

impl russh::client::Handler for ClientAuthHandler {
    type Error = russh::Error;

    /// 记录主机密钥指纹到共享缓冲（spike 必须记录），再按策略裁定接受与否。
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public_key = server_public_key.public_key();
        let fingerprint = public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();

        // 必须记录：无论策略接受与否。
        self.host_key_bytes
            .lock()
            .unwrap()
            .extend_from_slice(&russh::keys::PublicKeyBase64::public_key_bytes(&public_key));
        self.host_key_fingerprints
            .lock()
            .unwrap()
            .push(fingerprint.clone());

        let accept = (self.policy)(&fingerprint);
        if !accept {
            // 记录拒绝上下文，connect 据此返回 Error::HostKeyRejected。
            *self.host_key_rejected.lock().unwrap() = Some(fingerprint);
        }
        Ok(accept)
    }

    /// 服务端在 -R 监听端口上收到入站连接（`forwarded-tcpip` channel open）。
    /// 有路由登记 → accept 并投递给 remote runner；无登记（该端口的转发已停/
    /// bind_port=0 的注册竞态窗口）→ reply 落 drop = 自动拒绝（客户端看到
    /// connection refused，重试即成功）。
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        // 先 accept 再投递：路由失败（转发已停）时丢弃已接受的 channel = 立即
        // 关闭，效果等同拒绝且不拖垮连接。
        reply.accept().await;
        if let Some(router) = &self.forward_router {
            router.route(connected_address, connected_port, channel);
        }
        Ok(())
    }
}

/// 在已建立的连接上执行认证，按 `AuthMethod` 分发。
/// 服务端拒绝映射为 [`Error::AuthRejected`]（russh 以 `Ok(Failure)` 表示拒绝）。
pub(crate) async fn authenticate(
    handle: &mut Handle<ClientAuthHandler>,
    username: &str,
    auth: AuthMethod,
) -> Result<(), Error> {
    let result = match auth {
        AuthMethod::Password(password) => handle.authenticate_password(username, password).await?,
        AuthMethod::Key { path, passphrase } => {
            let key = russh::keys::load_secret_key(&path, passphrase.as_deref()).map_err(|e| {
                Error::KeyLoad {
                    path: path.display().to_string(),
                    source: KeyError::from(e), // russh 错误在此转为自有分类
                }
            })?;
            // 非 RSA 密钥 hash_alg 被忽略；RSA 走 best_supported_rsa_hash（Task 4 再接）。
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle.authenticate_publickey(username, key).await?
        }
        AuthMethod::KeyboardInteractive { responder } => {
            return keyboard_interactive_auth(handle, username, responder).await;
        }
    };
    match result {
        russh::client::AuthResult::Success => Ok(()),
        russh::client::AuthResult::Failure { .. } => Err(Error::AuthRejected),
    }
}

/// keyboard-interactive 循环：start -> (InfoRequest -> responder 收集 prompt -> respond)*
/// -> Success / Failure。russh 0.63 的客户端无 Handler 回调，循环由本函数驱动。
async fn keyboard_interactive_auth(
    handle: &mut Handle<ClientAuthHandler>,
    username: &str,
    responder: PromptResponder,
) -> Result<(), Error> {
    let mut state = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;
    loop {
        match state {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Err(Error::AuthRejected),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let texts: Vec<String> = prompts.iter().map(|p| p.prompt.clone()).collect();
                let answers = responder(&texts);
                if answers.len() != texts.len() {
                    return Err(Error::PromptAnswerMismatch {
                        prompts: texts.len(),
                        answers: answers.len(),
                    });
                }
                state = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}
