//! 共享状态核（Task 0 拆分，BL-004）：会话表 / 传输表 / 转发计数器 / 合批参数。
//!
//! 「会话表等共享状态」的单一持有面——命令域子模块（session/transfer/spike）
//! 一律经 `use super::state::*` 消费（选型：不改为参数层层下发， crates 间公共
//! 状态仍走 Tauri manage；本模块是 crate 内唯一状态定义点，lib.rs 只 re-export）。
//! 拆分为纯搬家：结构/字段/常量零逻辑改动，仅加 `pub(crate)` 可见性。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_ssh::SshSession;
use ottr_term::encoding::StreamDecoder;
use ottr_term::ring::RingBuffer;
use ottr_term::stripper::Stripper;
use tokio::sync::Notify;

// ---------------------------------------------------------------------------
// 合批器参数（Task 7 复用同一语义）
// ---------------------------------------------------------------------------

/// 合批窗口：首字节到达后最多等这么久（有字节即写、窗口为最长等待）。
/// 默认 4ms —— spike 实验（2026-09-29，100 字符 @20ms，详见 docs/phase0-report.md §2）：
/// 16ms 洁净复测同样达标（p95=23/29）；4ms 时 p50=8/p95=10–14ms（余量 3.5–5×）；
/// 0ms（到即写）p50=5/p95=13ms 但完全失去合并能力。4ms 以可忽略的延迟税保留突发合并。
/// 可用 `OTTR_BATCH_WINDOW_MS` 覆盖（Task 7 吞吐场景窗口实验沿用同一旋钮）。
pub(crate) const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// 合批上限：窗口内攒到 256KB 立即 flush，不等窗口到期。
/// 默认 256KB —— Task 7 实测定值（task-7-report.md §4）：64KB 无节流在 100MB
/// 洪流下触发 tauri Channel 静默停摆（~54MB 处整流冻结，wry#1644 同机制）；
/// 256KB 帧 + 16ms flush 间隔两跑账目零差、14 MiB/s、冻结 0。
/// 可用 `OTTR_BATCH_LIMIT_KB` 覆盖（实验/调试用）。
pub(crate) const BATCH_LIMIT: usize = 256 * 1024;

/// 运行时生效窗口（`OTTR_BATCH_WINDOW_MS` 覆盖；0 = 每条消息到即 flush）。
pub(crate) fn batch_window() -> Duration {
    std::env::var("OTTR_BATCH_WINDOW_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(BATCH_WINDOW)
}

/// 运行时生效合批上限（`OTTR_BATCH_LIMIT_KB` 覆盖，向下取整到字节）。
pub(crate) fn batch_limit() -> usize {
    std::env::var("OTTR_BATCH_LIMIT_KB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kb| (kb as usize) * 1024)
        .filter(|v| *v > 0)
        .unwrap_or(BATCH_LIMIT)
}

/// flush 节流：两次 flush 之间的最小间隔。**默认 16ms**（`OTTR_FLUSH_MIN_INTERVAL_MS`
/// 覆盖；显式设 0 = 关闭节流）。
///
/// 默认值来源（Task 7 实测，task-7-report.md §4）：tauri `Channel::send` 是入队即
/// 返回语义、无反压信号，无节流时 webview 取数管线在洪流下静默停摆（一次丢帧 =
/// 全流冻结，wry#1644 同机制）；16ms（≈16MB/s @256KB 帧）是实测通过边界之下、
/// 32MB/s（必停滞）之上的保守验证值——E6/E6b 账目零差、冻结 0、100MB 全量 8.6s。
/// 交互场景不受影响：击键间隔 ≥16ms 时节流永不生效（Task 4 延迟红线复测无回归）。
pub(crate) fn flush_min_interval() -> Option<Duration> {
    match std::env::var("OTTR_FLUSH_MIN_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(0) => None,
        Some(ms) => Some(Duration::from_millis(ms)),
        None => Some(Duration::from_millis(16)),
    }
}

// ---------------------------------------------------------------------------
// 会话表与计数器（Task 7 字节计数预埋）
// ---------------------------------------------------------------------------

/// 转发计数（驱动脚本/example 直驱 `forward_pty_loop` 时也要传入，故 pub；
/// 字段私有，读数走 `session_stats` 命令）。
#[derive(Default)]
pub struct SessionCounters {
    /// PTY 原始读出字节（合批前）。
    pub(crate) pty_read_bytes: AtomicU64,
    /// 合批+解码后向前端转发的字节（= 各 Raw 帧长度之和，**解码后的 UTF-8
    /// 文本字节数**，Task 9 起解码在 IPC 前完成）。解码有损（替换符变长、
    /// GBK 对 2B→汉字 3B）且批尾残字节（≤3B）滞留会话 Decoder 随下批转发，
    /// 故与 pty_read_bytes 不再严格逐批恒等；字节永不丢弃由 Decoder 残字
    /// 结算（set_encoding 返回值 / finish）保证。
    pub(crate) forwarded_bytes: AtomicU64,
    /// 向前端发送的帧数（合批次数）。
    pub(crate) frames: AtomicU64,
    /// 前端写向 PTY 的字节（击键级）。
    pub(crate) input_bytes: AtomicU64,
    /// write_session 调用次数。
    pub(crate) writes: AtomicU64,
    /// 【M-2 失败策略】on_data.send 失败而**丢弃**的帧数（不计入 forwarded/frames）。
    pub(crate) send_failed_frames: AtomicU64,
    /// 【M-2 失败策略】on_data.send 失败而**丢弃**的字节数。
    /// 解码前口径的失败字节（Task 9 起转发以解码后文本计，见 forwarded_bytes）。
    pub(crate) send_failed_bytes: AtomicU64,
    /// 【M-2 失败策略】会话级失败标志：任何 send 失败后置位，session_stats 可读。
    pub(crate) failed: AtomicBool,
}

pub(crate) struct SessionEntry {
    /// 既有 SSH 会话（Task 10）：SFTP 子系统/传输在**同一连接**上开新 channel，
    /// 不新建 SSH 连接。与转发循环共享同一 Arc（循环退出即 disconnect，SFTP
    /// 与传输随会话生命周期消亡）。链式会话（Phase 2 Task 2）时这里是
    /// **target** 会话（PTY/SFTP/转发全部开在它上面，消费面与直连同一形状）；
    /// 全链（每跳 + target）的 JumpSession 由注册阶段的转发循环任务独占持有
    /// （生命周期与循环严格同界：注册即持有、循环退出即全链显式拆除——与
    /// 直连路径「循环退出即 disconnect」同一收尾点，不需要第二份引用）。
    pub(crate) session: Arc<SshSession>,
    /// host 端点（`address:port`，Fix round 1 C-1）：下载 journal 的 scope 身份——
    /// 同路径同大小的远端文件在不同主机各用各的 journal，绝不跨主机续传。
    pub(crate) endpoint: String,
    /// PTY 写端（russh `make_writer()`，与读循环共享同一通道）。
    pub(crate) writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>,
    pub(crate) counters: Arc<SessionCounters>,
    /// 会话流式解码器（Task 9，A9）：合批 flush 后、IPC 前解码；
    /// `set_session_encoding` 即切即生效（残字节按旧编码结算回传前端）。
    pub(crate) decoder: Arc<Mutex<StreamDecoder>>,
    /// 会话文本尾缓冲（Task 13 AI 诊断）：转发循环解码后的文本剥 ANSI 入环，
    /// `session_tail` 命令按字节取尾（输出尾部 8KB 喂 AI）。
    pub(crate) text_tail: Arc<TextTail>,
    /// 取消信号：`drop_session` 触发，转发循环 select 到即就地退出（进程端任务取消）。
    pub(crate) cancel: Arc<Notify>,
    /// FilePanel 复用的 SFTP 客户端（Task 10，懒开 + 缓存；表项移除即消亡）。
    pub(crate) sftp: SftpSlot,
    /// remote(-R) 转发的入站路由（Phase 2 Task 1）：连接建立时随 Handler 挂进
    /// 连接（connect_with_keepalive 的 forward_router 参数），转发命令域按会话
    /// 取用。克隆零成本（内部 Arc）。
    pub(crate) forward_router: ottr_ssh::RemoteForwardRouter,
    /// 会话录制器槽位（Phase 3 Task 5，B3）：None = 未录制；recording_start
    /// 放入 handle、转发循环 flush_batch tee 副本、stop/循环退出 finalize。
    pub(crate) recorder: super::recording::RecorderSlot,
    /// PTY 初始尺寸（录制 header 的 width/height 面；运行期 resize 不追踪——
    /// asciinema "r" 事件挂账，见 task-5-report）。
    pub(crate) cols: u16,
    pub(crate) rows: u16,
}

/// 会话文本缓冲（Task 13 尾环 + fix 1/5 头部原始探针）：
/// * 尾缓冲（AI 诊断）：Stripper（剥 ANSI，跨 chunk 状态）→ RingBuffer
///   （默认 10_000 行）。`session_tail` 按字节取尾（spec §6 输出尾部 8KB）。
/// * 头部原始探针（fix 1/5 shell 集成注入）：截留会话**开头**的解码原文
///   （剥 ANSI 前，OSC 133 标记完整保留），供注入任务判断「用户已自带
///   133 集成」（幂等探测，防双标记双入库）。上限 [`RAW_HEAD_CAP`] 字节
///   （banner + 首提示符绰绰有余），截满即停。
pub struct TextTail {
    stripper: Mutex<Stripper>,
    ring: Mutex<RingBuffer>,
    raw_head: Mutex<String>,
}

/// 头部原始探针上限（字节；字符串按字符截断，CJK 下字节数略低，无碍判断面）。
pub const RAW_HEAD_CAP: usize = 16 * 1024;

impl Default for TextTail {
    fn default() -> Self {
        Self::new()
    }
}

impl TextTail {
    /// pub = example/驱动脚本直驱面（与 forward_pty_loop 同一约定）。
    pub fn new() -> Self {
        TextTail {
            stripper: Mutex::new(Stripper::new()),
            ring: Mutex::new(RingBuffer::new()),
            raw_head: Mutex::new(String::new()),
        }
    }

    /// 喂入一段解码后的终端文本（合批 flush 的剥离副本入尾环；原文副本入头部探针）。
    pub(crate) fn push(&self, text: &[u8]) {
        self.note_raw(&String::from_utf8_lossy(text));
        let mut ring = self.ring.lock().unwrap();
        self.stripper.lock().unwrap().feed(text, &mut *ring);
    }

    /// 头部原始探针追加（截满即停：会话开头定性，无需滚动）。
    fn note_raw(&self, text: &str) {
        let mut head = self.raw_head.lock().unwrap();
        if head.len() >= RAW_HEAD_CAP {
            return;
        }
        let remaining = RAW_HEAD_CAP - head.len();
        if text.len() <= remaining {
            head.push_str(text);
            return;
        }
        // 按字符边界截断（String::get 对非边界返回 None，手动走 char_indices）
        let mut end = 0;
        for (i, _) in text.char_indices() {
            if i > remaining {
                break;
            }
            end = i;
        }
        head.push_str(&text[..end]);
    }

    /// 首输出是否已见 OSC 133 标记（用户自带集成的幂等判定面）。
    pub fn raw_head_has_133(&self) -> bool {
        self.raw_head.lock().unwrap().contains("\x1b]133;")
    }

    /// 头部原始探针当前长度（注入任务等待「输出稳定」的观察面）。
    pub fn raw_head_len(&self) -> usize {
        self.raw_head.lock().unwrap().len()
    }

    /// 取最后 `limit` 字节（完整行对齐；UTF-8 校验由入环前的 Stripper 保证，
    /// 此处 lossy 仅作纵深防御）。
    pub(crate) fn tail(&self, limit: usize) -> String {
        let bytes = self.ring.lock().unwrap().tail_bytes(limit);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// 每会话缓存的 [`SftpClient`]（懒开）。
pub(crate) type SftpSlot = Arc<Mutex<Option<Arc<ottr_transfer::SftpClient>>>>;

/// FTP/FTPS 文件会话表项（Phase 2 Task 5）：客户端句柄 + 端点身份。
/// FTP 会话无 PTY/终端（纯文件面），与 SSH 会话表平行、按 id 前缀区分。
pub(crate) struct FtpSessionEntry {
    pub(crate) client: Arc<ottr_transfer::FtpClient>,
    /// `host:port`（下载 journal 的 scope 身份，与 SSH 端点同语义）。
    pub(crate) endpoint: String,
}

/// FTP/FTPS 会话表（id → 表项；drop_session / disconnect_all 统一清收）。
pub(crate) type FtpSessionMap = Arc<Mutex<HashMap<String, FtpSessionEntry>>>;

/// 会话表（Arc 共享：命令面与转发循环收尾任务都要增删）。
pub(crate) type SessionMap = Arc<Mutex<HashMap<String, SessionEntry>>>;

/// 注册生命周期共享入参（Phase 2 Task 2，commands/session.rs 拆分面）：
/// 直连 [`crate::commands::session::open_and_register`] 与链式 attach 共用。
pub(crate) struct RegisterArgs {
    pub(crate) sessions: SessionMap,
    pub(crate) close_event: Option<tauri::AppHandle>,
    /// PTY 所在会话（链式连接时 = target 会话，消费面与直连同一形状）。
    pub(crate) session: Arc<SshSession>,
    /// 跳板链 owner（None = 直连）。收尾断开必须经它拆全链（只断 session
    /// 会留下悬挂跳板连接——russh Handle::drop 不关连接）。
    pub(crate) chain: Option<Arc<ottr_ssh::JumpSession>>,
    pub(crate) forward_router: ottr_ssh::RemoteForwardRouter,
    pub(crate) endpoint: String,
    pub(crate) cols: u32,
    pub(crate) rows: u32,
    pub(crate) on_data: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    pub(crate) initial_encoding: ottr_term::encoding::Encoding,
    pub(crate) ui_face: bool,
    pub(crate) shell_integration: bool,
}

/// 挂起中的 host key 问询（TOFU 确认框交互）。
/// key = `"{host_id}:{fingerprint}"`；value = 裁定回传端（`host_key_decision` 发送）。
/// TOFU 策略回调在 russh 连接专属任务内 `recv_timeout(60s)` 阻塞等待——
/// russh 的握手运行在 `connect_stream` spawn 的独立任务里（见 russh 0.63 源码），
/// 阻塞只挂起该连接自己的握手，这正是「connect 挂起等前端 confirm」的语义；
/// 60s 无裁定即按拒绝处理（超时安全侧）。
pub(crate) type HostKeyAsks = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>>;

/// 在途传输（Task 10）：取消令牌句柄表。键 = transfer_id；任务结束时自清
/// （cancel 后令牌仍在表里直到任务退出——重复 cancel 幂等无害）。
pub(crate) struct TransferEntry {
    pub(crate) cancel: ottr_transfer::CancelToken,
}

pub(crate) type TransferMap = Arc<Mutex<HashMap<String, TransferEntry>>>;

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) sessions: SessionMap,
    /// FTP/FTPS 文件会话表（Phase 2 Task 5，commands/ftp.rs 注册）。
    pub(crate) ftp_sessions: FtpSessionMap,
    pub(crate) host_key_asks: HostKeyAsks,
    /// 在途传输的取消令牌（Task 10）：键 = transfer_id；传输结束由任务自清。
    pub(crate) transfers: TransferMap,
    /// 端口转发生命周期 owner（Phase 2 Task 1，commands/forward.rs）：
    /// port_forward 行 id → 运行实例（取消令牌 + 状态快照 + 归属会话）。
    /// Arc 化：attach 成功的 on_session_up 挂钩要 spawn 脱离借用的事务
    /// （'static async），Manager 需可克隆的共享句柄。
    pub(crate) forwards: Arc<super::forward::ForwardManager>,
    /// 远端文件本地编辑会话表（Phase 2 Task 3，commands/remote_edit.rs）：
    /// session id → (远端路径 → 临时副本/远端快照/本地指纹)。
    pub(crate) edits: super::remote_edit::EditMap,
    /// 监控采样任务生命周期 owner（Phase 3 Task 1，commands/monitor.rs）：
    /// session id → 采样任务取消令牌（guard Drop 即停）。
    pub(crate) monitors: super::monitor::MonitorManager,
    /// 批量执行批次注册表（Phase 3 Task 4，commands/batch.rs）：
    /// batch_id → 取消令牌（batch_cancel 入口；池收尾自摘）。
    pub(crate) batches: super::batch::BatchManager,
}

pub(crate) static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);
pub(crate) static TRANSFER_SEQ: AtomicU64 = AtomicU64::new(0);

/// 传输并发 worker 数（Task 8 spike 验证过的默认 4）。
pub(crate) const SFTP_CHUNKS: usize = 4;
/// 进度事件节流间隔（Task 10）：chunk 粒度回调 → 事件面按时间窗合并，
/// 首帧与末帧必发（进度条起点/终点不丢）。
pub(crate) const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// attach_host_session 的传输层 keepalive 间隔（简报定值 60s）。
/// russh `Config::keepalive_interval`：每间隔发传输层 keepalive 全局请求
/// （**不进 channel 数据流**，不污染终端）；`keepalive_max`（默认 3）个周期
/// 收不到对端任何数据即 KeepaliveTimeout 断连 → 转发循环退出 → 前端重连状态机。
/// 对端 RST/FIN（容器被 kill 等）不依赖 keepalive，读循环立即感知。
pub(crate) const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

/// host key 问询超时（简报定值）：前端确认框挂起 connect 的最长等待。
pub(crate) const HOST_KEY_ASK_TIMEOUT: Duration = Duration::from_secs(60);

/// LANG 探测命令/超时（Task 9 detect_hint：连接建立后独立 exec 通道跑一次，
/// 不进 PTY 数据流、不阻塞 attach 返回；失败/超时 = 不提示，安全侧）。
pub(crate) const LANG_PROBE_CMD: &str = "echo $LANG";
pub(crate) const LANG_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(serde::Serialize)]
pub struct SessionStats {
    pub pty_read_bytes: u64,
    pub forwarded_bytes: u64,
    pub frames: u64,
    pub input_bytes: u64,
    pub writes: u64,
    pub send_failed_frames: u64,
    pub send_failed_bytes: u64,
    pub failed: bool,
}

/// 计数器读数（`session_stats` 命令消费）。pub = 夹具集成测试直驱面
/// （tests/recording_fixture.rs 的 tee 字节账比对；run_batch 同惯例）。
pub fn snapshot(counters: &SessionCounters) -> SessionStats {
    SessionStats {
        pty_read_bytes: counters.pty_read_bytes.load(Ordering::Relaxed),
        forwarded_bytes: counters.forwarded_bytes.load(Ordering::Relaxed),
        frames: counters.frames.load(Ordering::Relaxed),
        input_bytes: counters.input_bytes.load(Ordering::Relaxed),
        writes: counters.writes.load(Ordering::Relaxed),
        send_failed_frames: counters.send_failed_frames.load(Ordering::Relaxed),
        send_failed_bytes: counters.send_failed_bytes.load(Ordering::Relaxed),
        failed: counters.failed.load(Ordering::Relaxed),
    }
}
