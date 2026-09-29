//! russh 实现：`connect` / `SshSession`（类型别名 [`RusshTransport`]）。
//!
//! russh 具体类型只出现在本模块与 [`crate::SshTransport`] 的关联类型中
//! （spike 阶段 pragmatic：Channel 直接用 russh 类型，见 trait 文档的 libssh2 适配点）。

use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};

use crate::auth::{self, ClientAuthHandler, HostKeyPolicy};
use crate::{AuthMethod, Error, Result, SshTransport};

/// 建立连接并完成认证。
///
/// `host_key_cb` 收到 `SHA256:…` 指纹并裁定是否接受；返回 false 时连接以
/// [`Error::HostKeyRejected`] 失败（携带服务器实际指纹），绝不静默跳过主机密钥校验。
/// 指纹（含原始公钥字节）总是记录在 [`SshSession`] 上供 UI 展示/TOFU 落库。
pub async fn connect(
    addr: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    host_key_cb: HostKeyPolicy,
) -> Result<SshSession> {
    let host_key_bytes = Arc::new(Mutex::new(Vec::new()));
    let host_key_fingerprints = Arc::new(Mutex::new(Vec::new()));
    let host_key_rejected: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = ClientAuthHandler::new(
        host_key_cb,
        Arc::clone(&host_key_bytes),
        Arc::clone(&host_key_fingerprints),
        Arc::clone(&host_key_rejected),
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: None,
        ..Default::default()
    });

    let connect_result = client::connect(config, (addr, port), handler).await;
    let mut handle = match connect_result {
        Ok(handle) => handle,
        Err(source) => {
            // 策略拒绝过主机密钥 → 返回自有变体（russh 的 UnknownKey 擦除为 source）。
            if let Some(fingerprint) = host_key_rejected.lock().unwrap().take() {
                return Err(Error::HostKeyRejected {
                    fingerprint,
                    source: Some(Box::new(source)),
                });
            }
            return Err(Error::Protocol {
                message: source.to_string(),
                source: Some(Box::new(source)),
            });
        }
    };
    auth::authenticate(&mut handle, username, auth).await?;

    Ok(SshSession {
        handle,
        host_key_bytes,
        host_key_fingerprints,
    })
}

/// 一条已认证的 SSH 会话（russh `Handle` 持有者）。
pub struct SshSession {
    handle: Handle<ClientAuthHandler>,
    host_key_bytes: Arc<Mutex<Vec<u8>>>,
    host_key_fingerprints: Arc<Mutex<Vec<String>>>,
}

impl SshSession {
    /// 最近一次记录的服务器主机密钥指纹（`SHA256:…`）。
    pub fn host_key_fingerprint(&self) -> Option<String> {
        self.host_key_fingerprints.lock().unwrap().last().cloned()
    }

    /// 记录的服务器主机公钥原始字节（ssh public key blob，TOFU 落库用）。
    pub fn host_key_bytes(&self) -> Vec<u8> {
        self.host_key_bytes.lock().unwrap().clone()
    }

    /// 打开交互式 PTY 会话通道（等价于 trait 方法，见 [`SshTransport`]）。
    pub async fn open_pty(&self, cols: u32, rows: u32) -> Result<russh::Channel<russh::client::Msg>> {
        <Self as SshTransport>::open_pty(self, cols, rows).await
    }
}

impl std::fmt::Debug for SshSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Handle 未实现 Debug；会话调试信息只暴露主机密钥记录，不暴露内部通道。
        f.debug_struct("SshSession")
            .field("host_key_fingerprints", &self.host_key_fingerprints)
            .finish_non_exhaustive()
    }
}

impl SshTransport for SshSession {
    type Channel = russh::Channel<russh::client::Msg>;

    async fn connect(
        addr: &str,
        port: u16,
        username: &str,
        auth: AuthMethod,
        host_key_cb: HostKeyPolicy,
    ) -> Result<Self> {
        connect(addr, port, username, auth, host_key_cb).await
    }

    async fn open_pty(
        &self,
        cols: u32,
        rows: u32,
    ) -> Result<Self::Channel> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        Ok(channel)
    }
}

/// russh 实现的传输类型（spec 的隔离约束：消费方依赖 [`crate::SshTransport`]，
/// russh 不达标时可换成 libssh2 实现而不动消费方代码）。
pub type RusshTransport = SshSession;
