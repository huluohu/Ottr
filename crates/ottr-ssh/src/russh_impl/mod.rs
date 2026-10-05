//! russh 实现：`connect` / `SshSession`（类型别名 [`RusshTransport`]）。
//!
//! russh 具体类型只出现在本模块与 [`crate::SshTransport`] 的关联类型中
//! （spike 阶段 pragmatic：Channel 直接用 russh 类型，见 trait 文档的 libssh2 适配点）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};

use crate::auth::{self, ClientAuthHandler, HostKeyPolicy};
use crate::{AuthMethod, Error, Result, SshTransport};

/// 组装握手用 config 与 host key 记录型 Handler（`connect*` 系列共用，
/// 保证直连与隧道跳行为一致）。`keepalive_interval` 透传进 russh 传输层：
/// `Some(d)` 时 run loop 每 d 发送传输层 keepalive（SSH 全局请求，**不进任何
/// channel 数据流**——不会污染终端）；`keepalive_max`（默认 3）个周期内未收到
/// 对端任何数据即 KeepaliveTimeout 断连（死链检测，Phase 1 会话重连的消费点）。
fn handshake_parts(
    host_key_cb: HostKeyPolicy,
    keepalive_interval: Option<Duration>,
    forward_router: Option<crate::forward::RemoteForwardRouter>,
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
        forward_router,
    );
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval,
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
    connect_with_keepalive(addr, port, username, auth, host_key_cb, None, None).await
}

/// [`connect`] 的 keepalive 变体（Phase 1 会话管理消费）：交互式长连会话传
/// `Some(Duration::from_secs(60))` 开启传输层 keepalive；短生命周期连接
/// （deploy/exec）用 [`connect`]（interval=None，行为与 Phase 0 完全一致）。
/// `forward_router`（Phase 2 Task 1）：remote(-R) 转发的入站路由表——会话上
/// 要跑 -R 转发时传 Some（连接的 Handler 据此接收 `forwarded-tcpip` channel）；
/// None 时远端转发的入站连接被默认拒绝（与 Phase 0/1 行为一致）。
pub async fn connect_with_keepalive(
    addr: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    host_key_cb: HostKeyPolicy,
    keepalive_interval: Option<Duration>,
    forward_router: Option<crate::forward::RemoteForwardRouter>,
) -> Result<SshSession> {
    let (config, handler, host_key_bytes, host_key_fingerprints, host_key_rejected) =
        handshake_parts(host_key_cb, keepalive_interval, forward_router);

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
    connect_stream_with_keepalive(stream, username, auth, host_key_cb, None, None).await
}

/// [`connect_stream`] 的 keepalive/router 变体（Phase 2 Task 2 JumpSession）：
/// 隧道之上的会话与直连会话语义对齐——长连跳板/target 传 `Some(interval)`
/// 开传输层 keepalive；remote(-R) 转发的入站路由随 Handler 挂进隧道连接
/// （链式主机的 -R 与直连主机同一语义）。
pub async fn connect_stream_with_keepalive<S>(
    stream: S,
    username: &str,
    auth: AuthMethod,
    host_key_cb: HostKeyPolicy,
    keepalive_interval: Option<Duration>,
    forward_router: Option<crate::forward::RemoteForwardRouter>,
) -> Result<SshSession>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (config, handler, host_key_bytes, host_key_fingerprints, host_key_rejected) =
        handshake_parts(host_key_cb, keepalive_interval, forward_router);

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

/// [`SshSession::exec`] 的结果：stdout/stderr 分离 + 退出码。
/// `exit_status: None` = 服务端未回 ExitStatus 就关闭了通道（异常流，调用方按失败处置）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
}

impl SshSession {
    /// 最近一次记录的服务器主机密钥指纹（`SHA256:…`）。
    pub fn host_key_fingerprint(&self) -> Option<String> {
        self.host_key_fingerprints.lock().unwrap().last().cloned()
    }

    /// 记录的服务器主机公钥原始字节（ssh public key blob，TOFU 落库用）。
    ///
    /// **累积语义（BL-215 成文，行为不变）**——「何时重置、何时累积」：
    /// * **每条连接一个独立缓冲**：缓冲在 [`handshake_parts`] 里新建，随该次
    ///   `connect*` 的 Handler 走；新连接（直连/隧道每一跳）都是空缓冲起步，
    ///   **绝不跨连接累积**——「会话表里每条 SshSession 的字节流」互不相干。
    /// * **连接内只增不减（append-only）**：[`crate::auth`] 的
    ///   `check_server_key` 对每次密钥交换都 `extend_from_slice`——包括认证
    ///   前的首次交换与**会话存续期内的每次 rekey**（SSH 传输层 rekey 会重新
    ///   走主机密钥校验，russh 对此复用同一 Handler）。
    /// * 因此本方法返回的是「连接生命周期内见过的**全部** key blob 按时间序
    ///   拼接」，而 [`Self::host_key_fingerprint`] 取 `last()` = **当前活跃**
    ///   服务的密钥。两者口径不同：落库/比对信任锚应认 `host_key_fingerprint`
    ///   （或按 blob 长度切分取末段）；把 `host_key_bytes()` 当单条 key 解析
    ///   在发生过 rekey 的连接上是错的（会是两段 blob 拼接）。
    /// * 现状无进程内消费方（TOFU 落库走指纹面）；文档钉死口径供未来消费者。
    pub fn host_key_bytes(&self) -> Vec<u8> {
        self.host_key_bytes.lock().unwrap().clone()
    }

    /// 打开交互式 PTY 会话通道（等价于 trait 方法，见 [`SshTransport`]）。
    pub async fn open_pty(
        &self,
        cols: u32,
        rows: u32,
    ) -> Result<russh::Channel<russh::client::Msg>> {
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

    /// 在远端执行单条命令（exec 通道，无 PTY）：收齐 stdout/stderr 与退出码。
    ///
    /// 消费方：Task 6 公钥部署（[`crate::deploy`]）、Task 12 monitor 只读命令采集。
    /// 与 `open_pty` + `channel.exec` 的 spike 路径（examples/real_fixture.rs）不同，
    /// 这里不开 PTY——命令输出是结构化数据而非交互流，避免 shell 脚本/回车污染输出。
    pub async fn exec(&self, command: &str) -> Result<ExecOutput> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status: Option<u32> = None;
        // Eof 后服务端仍会发 ExitStatus / Close：只对 Close / 通道关闭收尾，
        // 保证退出码不被提前丢弃。
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                russh::ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                russh::ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(ExecOutput {
            stdout,
            stderr,
            exit_status,
        })
    }

    /// 打开 SFTP 子系统通道并返回裸双向字节流（Task 8 并行传输的构建块）。
    ///
    /// russh-sftp 的客户端（RawSftpSession / SftpSession）构造需要
    /// `AsyncRead + AsyncWrite` 流；`Channel::into_stream()` 把 subsystem
    /// 通道转成流。Phase 1（Task 10）起该路径由 ottr-transfer crate 消费
    /// （sftp.rs 已迁入）：`SshSession::open_sftp_stream` →
    /// `RawSftpSession::new(stream)` → `init` → 并行分块读写。
    /// ottr-ssh 不反向依赖 ottr-transfer（后者依赖前者），此处仅以文字引用。
    pub async fn open_sftp_stream(&self) -> Result<russh::ChannelStream<russh::client::Msg>> {
        let channel = self.handle.channel_open_session().await?;
        // want_reply=true：等 SSH_MSG_CHANNEL_SUCCESS，确认子系统已启动再发 SFTP INIT
        channel.request_subsystem(true, "sftp").await?;
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

    /// 请求服务端监听 `(address, port)` 并把入站连接以 `forwarded-tcpip`
    /// channel 转回客户端（-R 远端转发的登记动作；入站接收面 =
    /// [`crate::forward::RemoteForwardRouter] 挂进 Handler 的路由表）。
    /// `port = 0` 时由服务端选择，返回值为实际端口（OpenSSH 语义）；
    /// 服务端拒绝（RequestDenied，如 AllowTcpForwarding no / 端口被占）→
    /// [`Error::Protocol`]。
    pub async fn tcpip_forward(&self, address: &str, port: u16) -> Result<u16> {
        self.handle
            .tcpip_forward(address, port as u32)
            .await
            .map(|bound| bound as u16)
            .map_err(Error::from)
    }

    /// 撤销 [`tcpip_forward`](SshSession::tcpip_forward) 的服务端监听
    /// （转发停止/runner 收尾时调用；会话已死时无害错误，调用方 best-effort）。
    pub async fn cancel_tcpip_forward(&self, address: &str, port: u16) -> Result<()> {
        self.handle
            .cancel_tcpip_forward(address, port as u32)
            .await
            .map(|_| ())
            .map_err(Error::from)
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

    async fn open_pty(&self, cols: u32, rows: u32) -> Result<Self::Channel> {
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
