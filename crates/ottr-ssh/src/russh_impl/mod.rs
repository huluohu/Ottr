//! russh 实现：`connect` / `SshSession`（类型别名 [`RusshTransport`]）。
//!
//! russh 具体类型只出现在本模块与 [`crate::SshTransport`] 的关联类型中
//! （spike 阶段 pragmatic：Channel 直接用 russh 类型，见 trait 文档的 libssh2 适配点）。

use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};

use crate::auth::{self, ClientAuthHandler, HostKeyPolicy};
use crate::{AuthMethod, Error, Result, SshTransport};

/// 组装握手用 config 与 host key 记录型 Handler（[`connect`] 与
/// [`connect_stream`] 共用，保证直连与隧道跳行为一致）。
fn handshake_parts(
    host_key_cb: HostKeyPolicy,
) -> (
    Arc<client::Config>,
    ClientAuthHandler,
    Arc<Mutex<Vec<u8>>>,
    Arc<Mutex<Vec<String>>>,
    Arc<Mutex<Option<String>>>,
) {
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
    (
        config,
        handler,
        host_key_bytes,
        host_key_fingerprints,
        host_key_rejected,
    )
}

/// 把握手结果映射为自有错误：策略拒绝过主机密钥 → [`Error::HostKeyRejected`]
/// （russh 的 UnknownKey 擦除为 source），其余 → [`Error::Protocol`]。
fn map_handshake_err(
    source: russh::Error,
    host_key_rejected: &Arc<Mutex<Option<String>>>,
) -> Error {
    if let Some(fingerprint) = host_key_rejected.lock().unwrap().take() {
        return Error::HostKeyRejected {
            fingerprint,
            source: Some(Box::new(source)),
        };
    }
    Error::Protocol {
        message: source.to_string(),
        source: Some(Box::new(source)),
    }
}

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
    let (config, handler, host_key_bytes, host_key_fingerprints, host_key_rejected) =
        handshake_parts(host_key_cb);

    let mut handle = match client::connect(config, (addr, port), handler).await {
        Ok(handle) => handle,
        Err(source) => return Err(map_handshake_err(source, &host_key_rejected)),
    };
    auth::authenticate(&mut handle, username, auth).await?;

    Ok(SshSession {
        handle,
        host_key_bytes,
        host_key_fingerprints,
    })
}

/// 在既有字节流（通常是上一跳会话打开的 direct-tcpip 隧道，见
/// [`SshSession::open_direct_tcpip_stream`]）上完成 SSH 握手与认证。
///
/// Spike#5 跳板链的构建块：握手/认证行为与 [`connect`] 完全一致
/// （同一 config、同一 Handler），只是传输从 TCP 换成调用方提供的流。
pub async fn connect_stream<S>(
    stream: S,
    username: &str,
    auth: AuthMethod,
    host_key_cb: HostKeyPolicy,
) -> Result<SshSession>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (config, handler, host_key_bytes, host_key_fingerprints, host_key_rejected) =
        handshake_parts(host_key_cb);

    let mut handle = match client::connect_stream(config, stream, handler).await {
        Ok(handle) => handle,
        Err(source) => return Err(map_handshake_err(source, &host_key_rejected)),
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

    /// 主动断开连接（发送 SSH_MSG_DISCONNECT，会话任务退出、TCP 关闭）。
    ///
    /// spike Task 7 Step 4（可中断性）依赖：关标签 → 会话级取消必须有进程端断连。
    /// 注意 russh `Handle::drop` 只打 debug 日志**不关连接**（源码 0.63.3 `impl Drop
    /// for Handle`），Channel 也没有 Drop 收尾——不显式 disconnect 会让 sshd 上的
    /// shell 与 TCP 悬挂。Task 5+ 关标签路径沿用。
    pub async fn disconnect(&self) -> Result<()> {
        use russh::Disconnect;
        self.handle
            .disconnect(Disconnect::ByApplication, "session dropped", "en")
            .await
            .map_err(Error::from)
    }

    /// 打开 SFTP 子系统通道并返回裸双向字节流（Task 8 并行传输的构建块）。
    ///
    /// russh-sftp 的客户端（RawSftpSession / SftpSession）构造需要
    /// `AsyncRead + AsyncWrite` 流；`Channel::into_stream()` 把 subsystem
    /// 通道转成流。Phase 1 的 ottr-transfer 直接继承该路径：
    /// `SshSession::open_sftp_stream` → `RawSftpSession::new(stream)` →
    /// `init` → 定长读写（见 [`crate::sftp`]）。
    pub async fn open_sftp_stream(
        &self,
    ) -> Result<russh::ChannelStream<russh::client::Msg>> {
        let channel = self.handle.channel_open_session().await?;
        // want_reply=true：等 SSH_MSG_CHANNEL_SUCCESS，确认子系统已启动再发 SFTP INIT
        channel
            .request_subsystem(true, "sftp")
            .await?;
        Ok(channel.into_stream())
    }

    /// 经本会话向 `(host, port)` 发起 direct-tcpip（SSH 在服务端侧完成 TCP 连接），
    /// 把通道转成裸双向字节流（Spike#5 跳板链的构建块，供
    /// [`connect_stream`] 在其上握手下一跳）。
    ///
    /// 与 [`open_sftp_stream`](SshSession::open_sftp_stream) 同类：russh 特有
    /// 扩展方法，按 trait 文档的裁定不属于 [`SshTransport`]。
    /// 远端连接失败时服务端回 CHANNEL_OPEN_FAILURE，本方法**立即**返回
    /// [`Error::Protocol`]（source 为 russh `ChannelOpenFailure`）——这是
    /// 「3 秒内断点定位」的依据：失败是显式协议错误，不是笼统超时。
    pub async fn open_direct_tcpip_stream(
        &self,
        host: &str,
        port: u16,
    ) -> Result<russh::ChannelStream<russh::client::Msg>> {
        // originator 仅为服务端日志用（RFC4254 §7），spike 固定占位。
        let channel = self
            .handle
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await?;
        Ok(channel.into_stream())
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
