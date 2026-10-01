//! 端口转发核心（Phase 2 Task 1，B7 上半；spec §3 B7 端口转发中心）。
//!
//! 三型转发（OpenSSH 惯例对照）：
//!
//! * **local（-L）**：本机 `TcpListener` 接受连接 → 经会话
//!   [`SshSession::open_direct_tcpip_stream`]（Phase 0 jump.rs 资产）在服务端
//!   侧连到 target → [`tokio::io::copy_bidirectional`] 双向泵；
//! * **remote（-R）**：`tcpip_forward`（russh 0.63 的远端监听请求，SSH 全局
//!   请求"tcpip-forward"）让 sshd 监听 bind 端点；每个入站连接以
//!   `forwarded-tcpip` channel 到达客户端，经 [`RemoteForwardRouter`]（挂进
//!   连接的 client Handler，见 `auth.rs`）路由到本模块的 runner，再由本机连
//!   target 并泵；
//! * **dynamic（-D）**：本机 `TcpListener` + 最小 SOCKS5 服务器（RFC1928，
//!   无认证，仅 CONNECT 命令）——握手拿到目标后与 local 同路
//!   （direct-tcpip + 泵），目标按每个 CONNECT 请求现场指定。
//!
//! 生命周期与状态机：每条转发一个独立任务（[`start_forward`] 返回
//! [`ForwardRunning`]：实际绑定端口 + JoinHandle）+ 共享 [`ForwardStats`]
//! （starting/active/error/stopped 四态 + tx/rx 字节计数（pump 处累加，
//! `Arc<AtomicU64>`）+ 连接计数）。停止一律经 [`tokio_util::sync::
//! CancellationToken`]（父令牌取消子连接任务），状态落 stopped 仅当此前处于
//! starting/active——会话断开时 ForwardManager 先标 error 再取消（见
//! src-tauri commands/forward.rs），stopped 不得覆盖 error。
//!
//! 字节计数口径：`tx_bytes` = 写入 SSH channel 方向（客户端→目标），
//! `rx_bytes` = 从 SSH channel 读出方向（目标→客户端）。计数器包在 channel
//! 侧（[`CountedStream`]），TCP 侧原样——两条口径在本模块语义下逐字节相等
//! （SSH 隧道不增减字节），任一侧均为真。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use russh::client::Msg;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::russh_impl::SshSession;
use crate::{Error, Result};

// ---------------------------------------------------------------------------
// 规格（spec/配置 → 运行输入）
// ---------------------------------------------------------------------------

/// 转发类型。ottr-vault 另有 serde 面 `ForwardKind`（存库字符串），此处是
/// 运行面定义——两者字符串口径一致（local/remote/dynamic），src-tauri 命令层
/// 负责映射（crate 间不互相依赖：ottr-ssh 不依赖 ottr-vault）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardKind {
    /// -L：本机监听 → SSH → target（target 从**服务端**视角解析）。
    Local,
    /// -R：服务端监听 → 隧道回本机 → target（target 从**本机**视角解析）。
    Remote,
    /// -D：本机 SOCKS5 代理（目标按 CONNECT 请求现场指定）。
    Dynamic,
}

/// 一条转发规格（监听端点 + 目标）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    /// 监听地址（local/dynamic = 本机；remote = sshd 侧）。
    pub bind_addr: String,
    /// 监听端口；0 = local 动态分配 / remote 由服务端选择（实际端口经
    /// [`ForwardRunning::bound_port`] 返回）。
    pub bind_port: u16,
    /// 目标主机（dynamic 必须为 None）。
    pub target_host: Option<String>,
    /// 目标端口（dynamic 必须为 None）。
    pub target_port: Option<u16>,
}

impl ForwardSpec {
    /// local/remote 的目标解析（必填校验；dynamic 显式报错）。
    fn target(&self) -> Result<(String, u16)> {
        match (self.kind, &self.target_host, self.target_port) {
            (ForwardKind::Local | ForwardKind::Remote, Some(host), Some(port)) if port > 0 => {
                Ok((host.clone(), port))
            }
            (ForwardKind::Dynamic, ..) => Err(Error::Protocol {
                message: "dynamic forward has no static target (per-CONNECT)".into(),
                source: None,
            }),
            _ => Err(Error::Protocol {
                message: "local/remote forward requires target_host/target_port".into(),
                source: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// 运行状态：状态机 + 字节计数（UI 轮询面）
// ---------------------------------------------------------------------------

/// 转发实例状态机（简报定值四态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForwardState {
    /// 任务已起、监听/远端登记未完成。
    Starting,
    /// 监听就绪（local/dynamic = 已 bind；remote = sshd 已接受转发请求）。
    Active,
    /// 失败终态：bind 失败 / 服务端拒绝转发 / 会话断开（Manager 标记）。
    Error(String),
    /// 用户停止（pf_stop）——不覆盖 Error（见 `stop_if_running` 文档）。
    Stopped,
}

/// [`ForwardStats`] 的不可变快照（UI 轮询/Manager 汇总面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardStatsSnapshot {
    pub state: ForwardState,
    /// 写入 SSH channel 方向字节（客户端→目标）。
    pub tx_bytes: u64,
    /// 从 SSH channel 读出方向字节（目标→客户端）。
    pub rx_bytes: u64,
    /// 累计接受的连接数（含失败）。
    pub connections: u64,
    /// 单条连接级失败数（channel 打开失败 / 目标连不上 / SOCKS 握手失败）。
    pub conn_errors: u64,
    /// 实际绑定端口（bind_port=0 时与规格不同）。
    pub bound_port: u16,
}

/// 每转发实例的共享运行状态。字段私有，读数走 [`ForwardStats::snapshot`]。
#[derive(Debug, Default)]
pub struct ForwardStats {
    state: Mutex<Option<ForwardState>>,
    tx_bytes: AtomicU64,
    rx_bytes: AtomicU64,
    connections: AtomicU64,
    conn_errors: AtomicU64,
    bound_port: AtomicU16,
}

impl ForwardStats {
    /// Arc 化构造（任务与 Manager 共享同一份）。
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn set(&self, state: ForwardState) {
        *self.state.lock().expect("forward stats poisoned") = Some(state);
    }

    /// 监听就绪（调用点见 [`start_forward`]）。
    pub(crate) fn set_active(&self) {
        self.set(ForwardState::Active);
    }

    /// 失败（bind / tcpip_forward / 路由通道消亡等）。pub = ForwardManager 的
    /// 会话断开收尾面（session_down 标 Error 的 owner 在 src-tauri 命令域）。
    pub fn set_error(&self, message: impl Into<String>) {
        self.set(ForwardState::Error(message.into()));
    }

    /// 任务收尾的停止落账：**仅当**此前处于 Starting/Active 才落 Stopped——
    /// 会话断开路径先 `set_error` 再取消令牌，任务收尾时状态已是 Error，
    /// 本方法不覆盖（错误终态优先于停止终态，UI 状态灯不失真）。
    pub(crate) fn stop_if_running(&self) {
        let mut slot = self.state.lock().expect("forward stats poisoned");
        let replace = matches!(
            *slot,
            Some(ForwardState::Starting) | Some(ForwardState::Active)
        );
        if replace {
            *slot = Some(ForwardState::Stopped);
        }
    }

    /// 实际绑定端口落账（bind / 服务端选择后立即调用）。
    pub(crate) fn set_bound_port(&self, port: u16) {
        self.bound_port.store(port, Ordering::Relaxed);
    }

    /// 只读快照（无运行记录 = Starting 兜底，理论上不可见）。
    pub fn snapshot(&self) -> ForwardStatsSnapshot {
        let state = self
            .state
            .lock()
            .expect("forward stats poisoned")
            .clone()
            .unwrap_or(ForwardState::Starting);
        ForwardStatsSnapshot {
            state,
            tx_bytes: self.tx_bytes.load(Ordering::Relaxed),
            rx_bytes: self.rx_bytes.load(Ordering::Relaxed),
            connections: self.connections.load(Ordering::Relaxed),
            conn_errors: self.conn_errors.load(Ordering::Relaxed),
            bound_port: self.bound_port.load(Ordering::Relaxed),
        }
    }

    fn conn_opened(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }

    fn conn_failed(&self) {
        self.conn_errors.fetch_add(1, Ordering::Relaxed);
    }

    fn tx(&self, n: u64) {
        self.tx_bytes.fetch_add(n, Ordering::Relaxed);
    }

    fn rx(&self, n: u64) {
        self.rx_bytes.fetch_add(n, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// remote(-R) 的入站路由：连接级 Handler → runner 的桥
// ---------------------------------------------------------------------------

type ForwardedChannel = russh::Channel<Msg>;

/// `forwarded-tcpip` 入站路由表（每 SSH 连接一张）：remote(-R) runner 把
/// 监听键（bind_addr, 实际端口）登记进来，client Handler（`auth.rs`
/// `server_channel_open_forwarded_tcpip` 回调）按服务端报告的
/// connected_address/connected_port 查表投递 channel。未登记（或已停转发的
/// 迟到连接）→ 拒绝该 channel（ChannelOpenHandle 落 drop = 自动拒绝）。
///
/// Clone = Arc 共享；随 SSH 会话存亡（SessionEntry 持有）。
#[derive(Clone, Debug, Default)]
pub struct RemoteForwardRouter {
    sinks: Arc<Mutex<HashMap<(String, u16), mpsc::UnboundedSender<ForwardedChannel>>>>,
}

impl RemoteForwardRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记监听键并取投递端。remote runner 在请求服务端监听**之前**登记
    /// （端口 ≠ 0 时键即终态，无竞态窗口）；bind_port = 0 时服务端选择端口
    /// 在应答里才知道——应答返回后立即换键（亚毫秒窗口，最坏一条入站连接被
    /// 拒，客户端表现为 connection refused，重试即成功；挂账文档）。
    pub(crate) fn register(&self, key: (String, u16)) -> mpsc::UnboundedReceiver<ForwardedChannel> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.sinks.lock().expect("router poisoned").insert(key, tx);
        rx
    }

    /// 换键（bind_port=0 → 服务端选择的实际端口）。
    pub(crate) fn rekey(&self, from: (String, u16), to: (String, u16)) {
        let mut sinks = self.sinks.lock().expect("router poisoned");
        if let Some(tx) = sinks.remove(&from) {
            sinks.insert(to, tx);
        }
    }

    /// 注销监听键（runner 收尾/启动失败）。
    pub(crate) fn deregister(&self, key: &(String, u16)) {
        self.sinks.lock().expect("router poisoned").remove(key);
    }

    /// Handler 回调入口：按 (connected_address, connected_port) 投递；
    /// 返回 false = 无登记（调用方拒绝该 channel）。
    pub(crate) fn route(&self, address: &str, port: u32, channel: ForwardedChannel) -> bool {
        let key = (address.to_string(), u16::try_from(port).unwrap_or(0));
        match self.sinks.lock().expect("router poisoned").get(&key) {
            Some(tx) => tx.send(channel).is_ok(),
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------
// 启动入口与三种 runner
// ---------------------------------------------------------------------------

/// 一条已启动的转发。
#[derive(Debug)]
pub struct ForwardRunning {
    /// 实际监听端口（bind_port=0 时为分配值）。
    pub bound_port: u16,
    /// runner 任务句柄（Manager 持有即视作存活；任务自会随令牌/错误退出）。
    pub join: tokio::task::JoinHandle<()>,
}

/// 启动一条转发：完成监听建立（bind / tcpip_forward）后落 Active 并 spawn
/// runner。监听建立失败**同步**返回错误（状态 Error 同时落账——Manager 据此
/// 在面板展示错误灯，而不是无声无息）。
pub async fn start_forward(
    session: Arc<SshSession>,
    router: &RemoteForwardRouter,
    spec: ForwardSpec,
    stats: Arc<ForwardStats>,
    cancel: CancellationToken,
) -> Result<ForwardRunning> {
    match spec.kind {
        ForwardKind::Local => start_local(session, spec, stats, cancel).await,
        ForwardKind::Remote => start_remote(session, router, spec, stats, cancel).await,
        ForwardKind::Dynamic => start_dynamic(session, spec, stats, cancel).await,
    }
}

/// -L：bind → 每连接 direct-tcpip + 泵。
async fn start_local(
    session: Arc<SshSession>,
    spec: ForwardSpec,
    stats: Arc<ForwardStats>,
    cancel: CancellationToken,
) -> Result<ForwardRunning> {
    let (target_host, target_port) = spec.target()?;
    let listener = TcpListener::bind((spec.bind_addr.as_str(), spec.bind_port))
        .await
        .map_err(|e| {
            let msg = format!("bind {}:{} failed: {e}", spec.bind_addr, spec.bind_port);
            stats.set_error(&msg);
            Error::Io(e)
        })?;
    let bound_port = listener.local_addr().map_err(Error::Io)?.port();
    stats.set_bound_port(bound_port);
    stats.set_active();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    stats.stop_if_running();
                    break;
                }
                accepted = listener.accept() => match accepted {
                    Ok((tcp, _peer)) => {
                        stats.conn_opened();
                        let child = cancel.child_token();
                        let s = Arc::clone(&session);
                        let host = target_host.clone();
                        let st = Arc::clone(&stats);
                        tokio::spawn(async move {
                            let channel = s.open_direct_tcpip_stream(&host, target_port).await;
                            pump_tcp_to_channel(tcp, channel, st, child).await;
                        });
                    }
                    Err(e) => {
                        stats.set_error(format!("local listener accept failed: {e}"));
                        break;
                    }
                }
            }
        }
    });
    Ok(ForwardRunning { bound_port, join })
}

/// -D：bind → 每连接 SOCKS5 握手 → direct-tcpip + 泵（RFC1928 最小实现：
/// 无认证、仅 CONNECT；ATYP 支持 IPv4/域名/IPv6）。
async fn start_dynamic(
    session: Arc<SshSession>,
    spec: ForwardSpec,
    stats: Arc<ForwardStats>,
    cancel: CancellationToken,
) -> Result<ForwardRunning> {
    if spec.target_host.is_some() || spec.target_port.is_some() {
        return Err(Error::Protocol {
            message: "dynamic forward must not carry a static target".into(),
            source: None,
        });
    }
    let listener = TcpListener::bind((spec.bind_addr.as_str(), spec.bind_port))
        .await
        .map_err(|e| {
            let msg = format!("bind {}:{} failed: {e}", spec.bind_addr, spec.bind_port);
            stats.set_error(&msg);
            Error::Io(e)
        })?;
    let bound_port = listener.local_addr().map_err(Error::Io)?.port();
    stats.set_bound_port(bound_port);
    stats.set_active();
    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    stats.stop_if_running();
                    break;
                }
                accepted = listener.accept() => match accepted {
                    Ok((mut tcp, _peer)) => {
                        stats.conn_opened();
                        let child = cancel.child_token();
                        let s = Arc::clone(&session);
                        let st = Arc::clone(&stats);
                        tokio::spawn(async move {
                            // SOCKS5 握手在直连 TCP 上做（不经 SSH）；拿到目标后
                            // 才打开 direct-tcpip——错误目标是本地拒绝，不烧服务端。
                            match socks5_connect_request(&mut tcp).await {
                                Ok((host, port)) => {
                                    let channel =
                                        s.open_direct_tcpip_stream(&host, port).await;
                                    // 成功应答必须在泵数据前写回（RFC1928）；
                                    // 失败路径由 pump 函数内 conn_failed 计数。
                                    if channel.is_ok() {
                                        let _ = socks5_reply(&mut tcp, SOCKS5_REP_SUCCESS).await;
                                    }
                                    pump_tcp_to_channel(tcp, channel, st, child).await;
                                }
                                Err(()) => {
                                    // 失败应答已在握手函数里发过（尽力而为）；
                                    // 连接随 drop 关闭。
                                    st.conn_failed();
                                }
                            }
                        });
                    }
                    Err(e) => {
                        stats.set_error(format!("dynamic listener accept failed: {e}"));
                        break;
                    }
                }
            }
        }
    });
    Ok(ForwardRunning { bound_port, join })
}

/// -R：登记路由 → 请求服务端监听 → 每个入站 channel 由本机连 target 并泵。
async fn start_remote(
    session: Arc<SshSession>,
    router: &RemoteForwardRouter,
    spec: ForwardSpec,
    stats: Arc<ForwardStats>,
    cancel: CancellationToken,
) -> Result<ForwardRunning> {
    let (target_host, target_port) = spec.target()?;
    // 键换名规避 clone 借用冲突（key 进闭包/收尾各一份）。
    let request_key = (spec.bind_addr.clone(), spec.bind_port);
    let mut rx = router.register(request_key.clone());
    let bound_port = match session.tcpip_forward(&spec.bind_addr, spec.bind_port).await {
        Ok(port) => port,
        Err(e) => {
            router.deregister(&request_key);
            let msg = format!(
                "remote forward on {}:{} rejected: {e}",
                spec.bind_addr, spec.bind_port
            );
            stats.set_error(&msg);
            return Err(e);
        }
    };
    stats.set_bound_port(bound_port);
    let live_key = (spec.bind_addr.clone(), bound_port);
    if bound_port != spec.bind_port {
        router.rekey(request_key, live_key.clone());
    }
    stats.set_active();
    let bind_addr = spec.bind_addr.clone();
    let router = router.clone();
    let join = tokio::spawn(async move {
        loop {
            let channel = tokio::select! {
                _ = cancel.cancelled() => {
                    stats.stop_if_running();
                    break;
                }
                c = rx.recv() => match c {
                    Some(channel) => channel,
                    None => {
                        // 会话消亡连带 router 清空：转发随会话终结（Manager
                        // 会在 session_down 时先标 Error）。
                        stats.set_error("remote forward router closed (session gone)");
                        break;
                    }
                }
            };
            stats.conn_opened();
            let child = cancel.child_token();
            let host = target_host.clone();
            let st = Arc::clone(&stats);
            tokio::spawn(async move {
                // target 从本机视角解析（-R 语义：隧道回客户端侧）。
                match TcpStream::connect((host.as_str(), target_port)).await {
                    Ok(mut tcp) => {
                        let mut counted = CountedStream::new(channel.into_stream(), &st);
                        let _ = tokio::select! {
                            r = tokio::io::copy_bidirectional(&mut tcp, &mut counted) => r,
                            _ = child.cancelled() => Ok((0, 0)),
                        };
                    }
                    Err(_) => {
                        st.conn_failed();
                        // channel 侧随 drop 关闭：服务端感知连接失败（对应
                        // OpenSSH 的 "direct-tcpip: connect failed" 路径）。
                    }
                }
            });
        }
        // 收尾：注销路由 + best-effort 撤销服务端监听（会话已死时无害）。
        router.deregister(&live_key);
        if let Err(e) = session.cancel_tcpip_forward(&bind_addr, bound_port).await {
            eprintln!("[forward] cancel_tcpip_forward {bind_addr}:{bound_port}: {e}");
        }
    });
    Ok(ForwardRunning { bound_port, join })
}

/// 一条本地 TCP 连接 ↔ SSH channel 的双向泵（local/dynamic 的连接任务尾段；
/// remote 的镜像路径内联在 start_remote——方向相反，计数器同口径）。
/// channel 打开失败（目标不可达/会话已死）→ conn_failed 计数，连接关闭。
async fn pump_tcp_to_channel(
    mut tcp: TcpStream,
    channel: crate::Result<russh::ChannelStream<Msg>>,
    stats: Arc<ForwardStats>,
    cancel: CancellationToken,
) {
    let stream = match channel {
        Ok(stream) => stream,
        Err(e) => {
            stats.conn_failed();
            eprintln!("[forward] channel open failed: {e}");
            return;
        }
    };
    let mut counted = CountedStream::new(stream, &stats);
    let pumped = tokio::select! {
        r = tokio::io::copy_bidirectional(&mut tcp, &mut counted) => r,
        _ = cancel.cancelled() => Ok((0, 0)),
    };
    if let Err(e) = pumped {
        stats.conn_failed();
        eprintln!("[forward] pump ended with error: {e}");
    }
}

// ---------------------------------------------------------------------------
// SOCKS5（RFC1928 最小面：无认证 + CONNECT）
// ---------------------------------------------------------------------------

const SOCKS5_VER: u8 = 5;
const SOCKS5_METHOD_NO_AUTH: u8 = 0x00;
const SOCKS5_CMD_CONNECT: u8 = 1;
const SOCKS5_REP_SUCCESS: u8 = 0;
const SOCKS5_REP_GENERAL_FAILURE: u8 = 1;
const SOCKS5_REP_CMD_NOT_SUPPORTED: u8 = 7;
const SOCKS5_REP_ATYP_NOT_SUPPORTED: u8 = 8;

/// 完成一次 SOCKS5 握手（问候 + CONNECT 请求），返回目标 (host, port)。
/// 失败时已尽力写回失败应答（write 失败静默——连接随即关闭）。
async fn socks5_connect_request(tcp: &mut TcpStream) -> std::result::Result<(String, u16), ()> {
    let result = socks5_connect_request_inner(tcp).await;
    if result.is_err() {
        let _ = socks5_reply(tcp, SOCKS5_REP_GENERAL_FAILURE).await;
    }
    result
}

async fn socks5_connect_request_inner(
    tcp: &mut TcpStream,
) -> std::result::Result<(String, u16), ()> {
    // --- 问候：VER NMETHODS METHODS... ---
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await.map_err(|_| ())?;
    if head[0] != SOCKS5_VER {
        return Err(());
    }
    let n_methods = head[1] as usize;
    if n_methods == 0 || n_methods > 32 {
        return Err(());
    }
    let mut methods = vec![0u8; n_methods];
    tcp.read_exact(&mut methods).await.map_err(|_| ())?;
    if !methods.contains(&SOCKS5_METHOD_NO_AUTH) {
        // 客户端不接受无认证：回 0xFF（NO ACCEPTABLE METHODS）后关闭。
        let _ = tcp.write_all(&[SOCKS5_VER, 0xFF]).await;
        return Err(());
    }
    tcp.write_all(&[SOCKS5_VER, SOCKS5_METHOD_NO_AUTH])
        .await
        .map_err(|_| ())?;

    // --- 请求：VER CMD RSV ATYP DST.ADDR DST.PORT ---
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await.map_err(|_| ())?;
    if req[0] != SOCKS5_VER {
        return Err(());
    }
    if req[1] != SOCKS5_CMD_CONNECT {
        let _ = socks5_reply(tcp, SOCKS5_REP_CMD_NOT_SUPPORTED).await;
        return Err(());
    }
    let host: String = match req[3] {
        0x01 => {
            let mut octets = [0u8; 4];
            tcp.read_exact(&mut octets).await.map_err(|_| ())?;
            std::net::Ipv4Addr::from(octets).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await.map_err(|_| ())?;
            let len = len[0] as usize;
            if len == 0 {
                return Err(());
            }
            let mut name = vec![0u8; len];
            tcp.read_exact(&mut name).await.map_err(|_| ())?;
            // 域名原样透传给服务端解析（direct-tcpip 语义）；非 UTF-8 拒绝。
            String::from_utf8(name).map_err(|_| ())?
        }
        0x04 => {
            let mut octets = [0u8; 16];
            tcp.read_exact(&mut octets).await.map_err(|_| ())?;
            std::net::Ipv6Addr::from(octets).to_string()
        }
        _ => {
            let _ = socks5_reply(tcp, SOCKS5_REP_ATYP_NOT_SUPPORTED).await;
            return Err(());
        }
    };
    let mut port_bytes = [0u8; 2];
    tcp.read_exact(&mut port_bytes).await.map_err(|_| ())?;
    let port = u16::from_be_bytes(port_bytes);
    if port == 0 {
        return Err(());
    }
    Ok((host, port))
}

/// 写 CONNECT 应答（REP；BND.ADDR/PORT 恒 0.0.0.0:0——SOCKS5 允许，客户端
/// 只消费 REP）。
async fn socks5_reply(tcp: &mut TcpStream, rep: u8) -> std::result::Result<(), ()> {
    tcp.write_all(&[SOCKS5_VER, rep, 0, 0x01, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|_| ())
}

// ---------------------------------------------------------------------------
// 计数流：SSH channel 侧的字节账（CopyBidirectional 消费）
// ---------------------------------------------------------------------------

/// 包一层 SSH channel 流，poll_read/poll_write 处把字节计入共享计数器
/// （pump 处累加，简报口径）。内部 `Pin<Box<_>>` 抹平 Unpin 差异。
struct CountedStream<S> {
    inner: std::pin::Pin<Box<S>>,
    stats: Arc<ForwardStats>,
}

impl<S> CountedStream<S> {
    fn new(stream: S, stats: &Arc<ForwardStats>) -> Self {
        Self {
            inner: Box::pin(stream),
            stats: Arc::clone(stats),
        }
    }
}

impl<S: AsyncRead> AsyncRead for CountedStream<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        match self.inner.as_mut().poll_read(cx, buf) {
            std::task::Poll::Ready(Ok(())) => {
                let n = (buf.filled().len() - before) as u64;
                if n > 0 {
                    // 读 channel = 远端→客户端方向。
                    self.stats.rx(n);
                }
                std::task::Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<S: AsyncWrite> AsyncWrite for CountedStream<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.inner.as_mut().poll_write(cx, buf) {
            std::task::Poll::Ready(Ok(n)) => {
                if n > 0 {
                    // 写 channel = 客户端→远端方向。
                    self.stats.tx(n as u64);
                }
                std::task::Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.inner.as_mut().poll_shutdown(cx)
    }
}
