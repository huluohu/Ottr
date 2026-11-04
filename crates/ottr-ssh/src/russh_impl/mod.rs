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
#[allow(clippy::type_complexity)] // 握手装配五元组（内部函数，仅 connect 一处消费）
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

/// [`SshSession::exec_with_timeout`] 的结果：命令输出 + **超时标记**。
///
/// **为什么不是 [`ExecOutput`]**（形态选型理由，2026-11-04）：
/// * **超时 ≠ 命令失败**——超时是**消费侧**中止（远端命令可能仍在跑、已被
///   关通道杀掉），必须与「远端回了个非零退出码」可分辨；退出码语义里没有
///   「超时」这一档，混进去会让调用方把超时误报成失败退出码。
/// * [`ExecOutput`] 是既有消费面（deploy / monitor / cron / batch）的**公共
///   类型**，给它加字段会波及那些 `ExecOutput { .. }` 字面量构造点（跨 crate
///   的构造面冻结 = 既有消费面回归风险）。故超时面走**独立类型**：
///   `exec()` 的返回类型与既有消费面**零变化**，只有新链路
///   （`exec_with_timeout`）才拿得到超时标记。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutcome {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_status: Option<u32>,
    /// 消费侧硬超时命中：**通道已被显式关闭**（远端不留悬挂 shell）。
    /// `true` 时 `exit_status` 恒为 `None`（命令被中止，没有退出码）。
    pub timed_out: bool,
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
    /// SSH 层输出上限（2026-10-16 全面评审 ssh-1/cron-2：exec 无上限累积
    /// 进 Vec，批量并发可 OOM——所有消费面的截断都在 exec 返回后，防不住
    /// 内存峰值。10MB 覆盖 cron 64KB cap 三个数量级余量，远小于 OOM 线）。
    pub const EXEC_OUTPUT_CAP: usize = 10 * 1024 * 1024;

    /// [`Self::exec`] 的**内部硬超时**（兜底值，秒）。
    ///
    /// 取值依据：既有消费面的**业务超时**上限是 batch 的 3600s（cron 120s、
    /// monitor / deploy 更短）——内部兜底必须**长于**任何业务超时，否则兜底
    /// 会先于业务超时砍掉合法长任务。故取 2 小时（业务上限的两倍余量）。
    ///
    /// **旧注释的谎言已修正**（2026-11-04）：旧注释声称「内部 5 分钟硬超时」，
    /// 而实现里**根本没有 timeout**——超时只是 drop future，russh `Channel`
    /// 没有 Drop 收尾 → **远端 shell 悬挂 + 通道泄漏**。现在超时是**真的**：
    /// 显式关闭 exec 通道后再返回（见 [`Self::exec_with_timeout`]）。
    pub const EXEC_DEFAULT_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

    /// 与 `open_pty` + `channel.exec` 的 spike 路径（examples/real_fixture.rs）不同，
    /// 这里不开 PTY——命令输出是结构化数据而非交互流，避免 shell 脚本/回车污染输出。
    ///
    /// **内部有硬超时**（[`Self::EXEC_DEFAULT_TIMEOUT`]，2 小时）：超时 → 显式
    /// 关闭 exec 通道 → 返回 [`Error::Timeout`]（远端不留悬挂 shell）。既有消费
    /// 面（cron 120s / batch ≤3600s）的业务超时都短于这个兜底值 → **行为不变**。
    ///
    /// **但既有消费面自己套的业务超时仍在 `exec()` 外面**（cron / batch 用
    /// `tokio::time::timeout` 包住整个调用）：**业务超时先到** → drop future
    /// → russh `Channel` 没有 Drop 收尾 → **远端 shell 仍会悬挂**
    /// （老问题，**非本步回归**——旧实现根本没有 timeout）。本方法的兜底只对
    /// 「没有外层业务超时」或「业务超时比 2h 还长」的调用面有效。
    pub async fn exec(&self, command: &str) -> Result<ExecOutput> {
        let outcome = self
            .exec_with_timeout(command, Self::EXEC_DEFAULT_TIMEOUT)
            .await?;
        if outcome.timed_out {
            // 超时**不是**「命令失败退出码」——用错误通道报出去，别让调用方
            // 把「被中止」误读成「远端回了个退出码」。
            return Err(Error::Timeout {
                message: format!(
                    "ssh exec timed out after {}s (channel closed)",
                    Self::EXEC_DEFAULT_TIMEOUT.as_secs()
                ),
            });
        }
        Ok(ExecOutput {
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            exit_status: outcome.exit_status,
        })
    }

    /// 在远端执行单条命令，**带消费侧硬超时**（exec 通道，无 PTY）。
    ///
    /// 与 [`Self::exec`] 的差别只有一处，但正是要害：**超时会被真正处理**。
    /// 超时不是「drop future」（russh `Channel` 没有 Drop 收尾——drop future
    /// = 远端 shell 悬挂 + 通道泄漏），而是**显式关闭 exec 通道**
    /// （SSH_MSG_CHANNEL_CLOSE）后再返回：远端不留悬挂 shell，服务端也能
    /// 观察到通道被关闭。
    ///
    /// 返回值带 `timed_out` 标记（[`ExecOutcome`]）——调用方据此把「超时」与
    /// 「非零退出码」分开处置（超时时 `exit_status` 恒为 `None`）。
    ///
    /// **超时预算覆盖整段远端交互**（**开通道** → exec 请求 → 收包），且**共用
    /// 同一条 deadline**（不是每条消息重置一次——否则慢速输出可以无限续命）。
    ///
    /// **开通道也在预算内**（2026-11-04 修补 I-2）：deadline 在
    /// `channel_open_session()` **之前**起算，开通道本身由
    /// `timeout_at(deadline, …)` 包裹——服务端不回 CHANNEL_OPEN（半开连接 /
    /// 服务端卡死）时**按时返回超时**，而不是无限期挂起（挂起 = AI 执行面那一
    /// 轮永不返回）。开通道超时分支**没有通道可关**（远端还没起 shell，故
    /// 「不留悬挂 shell」依然成立），但同样带 `timed_out = true`——调用方可
    /// 辨识「超时」与「命令失败」。
    pub async fn exec_with_timeout(&self, command: &str, timeout: Duration) -> Result<ExecOutcome> {
        // deadline 先起算：**开通道 → exec 请求 → 收包**共用这一条。
        let deadline = tokio::time::Instant::now() + timeout;
        let mut channel =
            match tokio::time::timeout_at(deadline, self.handle.channel_open_session()).await {
                Ok(result) => result?,
                Err(_elapsed) => {
                    // 开通道超时：服务端不回 CHANNEL_OPEN。**此时没有通道可关**
                    // （远端尚未起 shell）→ 直接返回超时标记。
                    return Ok(ExecOutcome {
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        exit_status: None,
                        timed_out: true,
                    });
                }
            };
        // exec 请求本身也要在预算内（服务端不回 CHANNEL_SUCCESS 时同样会挂）。
        let requested = tokio::time::timeout_at(deadline, channel.exec(true, command)).await;
        match requested {
            Ok(result) => result?,
            Err(_elapsed) => {
                // 超时：显式关通道 → 远端不留悬挂 shell。
                let _ = channel.close().await;
                return Ok(ExecOutcome {
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    exit_status: None,
                    timed_out: true,
                });
            }
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut truncated = false;
        let mut exit_status: Option<u32> = None;
        loop {
            // 逐条收包，但**同一条 deadline**（见上）。
            let waited = tokio::time::timeout_at(deadline, channel.wait()).await;
            let msg = match waited {
                Ok(msg) => msg,
                Err(_elapsed) => {
                    // ★ 超时收尾：显式关闭 channel（russh Channel 无 Drop 收尾
                    // ——drop future = SSH 通道 + 远端 shell 悬挂）。服务端会收到
                    // SSH_MSG_CHANNEL_CLOSE 并观察到通道关闭。
                    let _ = channel.close().await;
                    if truncated {
                        Self::log_truncated(command);
                    }
                    return Ok(ExecOutcome {
                        stdout,
                        stderr,
                        exit_status: None,
                        timed_out: true,
                    });
                }
            };
            let Some(msg) = msg else {
                // 通道被关闭（服务端收尾）——收工。
                break;
            };
            match msg {
                russh::ChannelMsg::Data { data } => {
                    if stdout.len() + data.len() > Self::EXEC_OUTPUT_CAP {
                        truncated = true;
                    } else {
                        stdout.extend_from_slice(&data);
                    }
                }
                russh::ChannelMsg::ExtendedData { data, .. } => {
                    if stderr.len() + data.len() > Self::EXEC_OUTPUT_CAP {
                        truncated = true;
                    } else {
                        stderr.extend_from_slice(&data);
                    }
                }
                russh::ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
        if truncated {
            Self::log_truncated(command);
        }
        Ok(ExecOutcome {
            stdout,
            stderr,
            exit_status,
            timed_out: false,
        })
    }

    /// 输出截断告警（exec 通道 10 MiB 上限命中）。
    fn log_truncated(command: &str) {
        eprintln!(
            "[exec] output truncated at {} bytes (command: {})",
            Self::EXEC_OUTPUT_CAP,
            &command[..command.len().min(80)]
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::task::JoinHandle;

    /// mock sshd 的行为模式（观测面开关）。
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum MockMode {
        /// 正常：exec 回 stdout + 退出码。
        Echo,
        /// 挂起 exec：只回成功、**不回数据/退出码**（复现远端挂起）。
        HangExec,
        /// **不回 CHANNEL_OPEN**：扣住 open 句柄不答复（复现「服务端接受 TCP
        /// 后卡死不回通道开确认」——客户端的 `channel_open_session()` 会永远
        /// 等不到确认）。
        HoldOpen,
    }

    /// 极简 mock sshd（进程内）：只认 password，只回 exec 的 stdout + 退出码。
    ///
    /// 观测面（"超时后通道被关闭"的取证）：
    /// * `execs` —— 收到的 exec 请求命令原文（逐条）；
    /// * `closes` —— **客户端关通道**的次数（`channel_close` 回调）——超时
    ///   收尾（显式 `channel.close()`）会在服务端这里留下痕迹。
    struct MockServer {
        execs: Arc<Mutex<Vec<String>>>,
        closes: Arc<AtomicUsize>,
        mode: MockMode,
        /// 被扣住的 CHANNEL_OPEN 句柄（[`MockMode::HoldOpen`] 用）。
        ///
        /// **必须扣住而不是 drop**：russh 的
        /// `ChannelOpenHandleInner::drop` 会自动回一条
        /// `AdministrativelyProhibited` 拒绝——那就不是「不回」了（客户端会
        /// 立刻拿到 Err，而不是挂起）。
        held_open: Arc<Mutex<Vec<russh::server::ChannelOpenHandle>>>,
    }

    impl russh::server::Handler for MockServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> std::result::Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> std::result::Result<(), Self::Error> {
            if self.mode == MockMode::HoldOpen {
                // **对 CHANNEL_OPEN 不置一词**：句柄存住（不 drop）→ 客户端永远
                // 等不到通道开确认（半开连接 / 服务端卡死的真实形态）。
                self.held_open.lock().unwrap().push(reply);
                return Ok(());
            }
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> std::result::Result<(), Self::Error> {
            let command = String::from_utf8_lossy(data).into_owned();
            self.execs.lock().unwrap().push(command.clone());
            session.channel_success(channel)?;
            if self.mode != MockMode::HangExec {
                session.data(channel, format!("ran:{command}").into_bytes())?;
                session.exit_status_request(channel, 0)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Ok(())
        }

        /// 客户端关通道（超时收尾的显式 close 会走到这里）。
        async fn channel_close(
            &mut self,
            _channel: russh::ChannelId,
            _session: &mut russh::server::Session,
        ) -> std::result::Result<(), Self::Error> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// 起一个 mock sshd（127.0.0.1 随机端口）：返回端口 + 观测面 + 任务句柄。
    async fn spawn_mock(
        mode: MockMode,
    ) -> (
        u16,
        Arc<Mutex<Vec<String>>>,
        Arc<AtomicUsize>,
        JoinHandle<()>,
    ) {
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .expect("host key");
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let execs = Arc::new(Mutex::new(Vec::new()));
        let closes = Arc::new(AtomicUsize::new(0));
        let handle = tokio::spawn({
            let execs = Arc::clone(&execs);
            let closes = Arc::clone(&closes);
            async move {
                let (stream, _) = listener.accept().await.expect("accept");
                let handler = MockServer {
                    execs,
                    closes,
                    mode,
                    held_open: Arc::new(Mutex::new(Vec::new())),
                };
                let running = russh::server::run_stream(config, stream, handler)
                    .await
                    .expect("run_stream");
                let _ = running.await;
            }
        });
        (port, execs, closes, handle)
    }

    async fn connect_mock(port: u16) -> SshSession {
        connect(
            "127.0.0.1",
            port,
            "spike",
            AuthMethod::Password("spike-pass".into()),
            Arc::new(|_| true),
        )
        .await
        .expect("connect")
    }

    /// 正常路径：命令原文到服务端、stdout 与退出码回传、无超时。
    #[tokio::test]
    async fn exec_with_timeout_returns_output_and_exit_status() {
        let (port, execs, _closes, server) = spawn_mock(MockMode::Echo).await;
        let session = connect_mock(port).await;
        let outcome = session
            .exec_with_timeout("whoami", Duration::from_secs(5))
            .await
            .expect("exec");
        assert!(!outcome.timed_out, "正常路径不该命中超时");
        assert_eq!(outcome.stdout, b"ran:whoami");
        assert_eq!(outcome.stderr, b"");
        assert_eq!(outcome.exit_status, Some(0));
        assert_eq!(
            *execs.lock().unwrap(),
            vec!["whoami".to_string()],
            "服务端收到的命令原文必须一致"
        );
        server.abort();
    }

    /// 超时路径：返回超时标记（**不是**失败退出码）+ **通道被显式关闭**
    /// （服务端 `channel_close` 可见）→ 远端不留悬挂 shell。
    #[tokio::test]
    async fn exec_with_timeout_closes_channel_on_timeout() {
        let (port, execs, closes, server) = spawn_mock(MockMode::HangExec).await;
        let session = connect_mock(port).await;
        let outcome = session
            .exec_with_timeout("sleep 600", Duration::from_millis(200))
            .await
            .expect("exec");
        assert!(outcome.timed_out, "挂起的命令必须报超时");
        assert_eq!(outcome.exit_status, None, "超时没有退出码");
        assert_eq!(execs.lock().unwrap().len(), 1, "命令确实发出去了");
        // 服务端观察到客户端关通道（显式 close 的取证面）。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while closes.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            closes.load(Ordering::SeqCst),
            1,
            "超时后必须显式关闭 channel（远端不留悬挂 shell）"
        );
        server.abort();
    }

    /// 超时标记与失败退出码**可分辨**：超时结果的 `exit_status` 恒为 `None`
    /// 且 `timed_out` 为 true（调用方据此把「超时」与「非零退出码」分开回灌）。
    #[tokio::test]
    async fn exec_with_timeout_marks_timeout_distinctly_from_exit_code() {
        let (port, _execs, _closes, server) = spawn_mock(MockMode::HangExec).await;
        let session = connect_mock(port).await;
        let outcome = session
            .exec_with_timeout("sleep 600", Duration::from_millis(150))
            .await
            .expect("exec");
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_status, None);
        server.abort();
    }

    /// **开通道也在超时预算内**（2026-11-04 修补 I-2）：服务端接受 TCP 后
    /// **不回 CHANNEL_OPEN**（半开连接 / 服务端卡死）→ 必须**按时返回超时**，
    /// 而不是无限期挂起（挂起 = AI 执行面那一轮永不返回）。
    ///
    /// 观测面：**服务端一个 exec 请求都没收到**（命令根本没发出去）+ 调用
    /// 在预算附近返回（不是挂死）。
    #[tokio::test]
    async fn exec_with_timeout_times_out_when_the_server_never_opens_the_channel() {
        let (port, execs, _closes, server) = spawn_mock(MockMode::HoldOpen).await;
        let session = connect_mock(port).await;
        let budget = Duration::from_millis(200);
        let started = std::time::Instant::now();
        let outcome = session
            .exec_with_timeout("whoami", budget)
            .await
            .expect("exec");
        let elapsed = started.elapsed();
        assert!(outcome.timed_out, "开通道挂起必须报超时");
        assert_eq!(outcome.exit_status, None, "超时没有退出码");
        assert!(outcome.stdout.is_empty() && outcome.stderr.is_empty());
        assert!(
            execs.lock().unwrap().is_empty(),
            "通道没开成 → 命令根本没发出去（服务端零 exec 请求）"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "必须按时返回超时而不是挂起（实际耗时 {elapsed:?}）"
        );
        server.abort();
    }
}
