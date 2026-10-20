//! 本地终端（2026-10-20 用户新功能）：连接**本机** shell 的终端会话。
//!
//! 与 SSH 会话的关系：**独立注册表**（[`LocalTermMap`]，SSH [`SessionMap`]
//! 被 SFTP/转发/cron/批量执行深度耦合，塞本地会话要给一堆字段开 Option），
//! 但数据面命令**双表回退**——`write_session` / `session_stats` /
//! `session_tail` / `set_session_encoding` / `resize_session` /
//! `drop_session` 先查 SSH 表再查本地表，前端命令面零新增：标签、分屏、
//! 击键、fit、AI 诊断尾部、会话收尾事件全部复用。
//!
//! 实现：
//! * PTY = `portable-pty`（Unix openpty / Windows ConPTY），shell 选择 =
//!   `$SHELL` → `/bin/bash` → `/bin/sh`（Windows：PowerShell `-NoLogo`）；
//! * 读取 = 专用 OS 线程阻塞读 64KB 块 → mpsc；批量线程用
//!   `recv_timeout` 复刻 SSH 侧合批参数（[`batch_window`]/[`batch_limit`]），
//!   解码（会话编码）/TextTail/计数器与 `forward_pty_loop` 同一语义；
//! * 关闭 = `cancel` 标志 + `killer.kill()`（杀子进程让读线程 EOF），
//!   EOF 时按标志分派 `Cancelled`（主动关）或 `ShellExit`（用户敲 exit），
//!   载荷走同一个 `ottr://session-closed` 事件；
//! * 尺寸 = `resize_session` 直达 `master.resize`（无转发循环可挂，就地生效）；
//! * shell 集成：**bash/zsh 且 Unix** 时经 PTY 注入与 SSH 侧同一片段
//!   （⌘R 历史入库需要 C 边界；`__ottr_hc` 同时清掉注入自身的历史残留）。
//!   sh 系本地跳过（无 exec 通道落盘钩子文件）；fish/未知 shell 跳过不报错。
//!
//! 已知边界（如实）：录制（asciinema）与 ⌘J 目录锚点暂不覆盖本地会话
//! （录制器接线与 OSC7 依赖远端注入路径）；Windows ConPTY 输出编码跟随
//! 系统代码页，中文 Windows 的 PowerShell 输出可能需要手动切 GBK。

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use ottr_term::encoding::StreamDecoder;

use crate::commands::session::SessionCloseReason;
use crate::commands::state::{AppState, SessionCounters, TextTail, batch_limit, batch_window};

/// 本地终端会话表（id → 表项；`drop_session` / 循环收尾统一清收）。
pub(crate) type LocalTermMap = Arc<Mutex<HashMap<String, LocalSessionEntry>>>;

/// 本地终端会话表项（与 SSH [`crate::commands::state::SessionEntry`] 的共享面
/// 一一对应：writer/counters/decoder/text_tail/resize 供同名单命令双表回退；
/// SSH 专有字段——session/endpoint/sftp/forward_router——本地一概没有）。
pub(crate) struct LocalSessionEntry {
    /// PTY 写端（击键直写；`write_session` 消费）。
    pub(crate) writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    /// 子进程终止器（`drop_session`：先置 cancel 再 kill，读线程即 EOF）。
    pub(crate) killer: Arc<Mutex<Box<dyn portable_pty::ChildKiller + Send>>>,
    /// PTY 主端（`resize_session` 直达 `resize`；`&self` 即可，无锁争用面）。
    pub(crate) master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    pub(crate) counters: Arc<SessionCounters>,
    pub(crate) decoder: Arc<Mutex<StreamDecoder>>,
    pub(crate) text_tail: Arc<TextTail>,
    /// 录制器槽位（2026-10-20 录制接入本地会话；None = 未录制）。
    pub(crate) recorder: crate::commands::recording::RecorderSlot,
    /// PTY 初始尺寸（录制 header 消费；运行期 resize 直达 master）。
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    /// 取消标志：`drop_session` 置位 + kill；批量线程每次收尾按它分派
    /// Cancelled（主动关）vs ShellExit（用户敲 exit）。
    pub(crate) cancel: Arc<AtomicBool>,
}

/// 登录参数（`-l`）白名单：bash/zsh/sh 系读 profile；其余（含测试假身
/// `cat`、fish 等不支持或语义不同的）不加——`cat -l` 是非法选项。
fn takes_login_flag(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    matches!(base, "bash" | "zsh" | "sh" | "ash" | "dash" | "ksh")
}

/// shell 选择（可测纯函数）：basename 识别 bash/zsh（注入目标）；其余 None。
fn shell_kind(path: &str) -> Option<&'static str> {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base {
        "bash" => Some("bash"),
        "zsh" => Some("zsh"),
        _ => None,
    }
}

/// 本地登录 shell 路径：`$SHELL` → `/bin/bash` → `/bin/sh`（按存在性兜底）。
fn pick_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL")
        && !shell.trim().is_empty()
    {
        return shell;
    }
    for candidate in ["/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// 打开本地终端：spawn 本机 shell 进 PTY，注册会话表，起批量转发线程。
/// 返回会话 id（前端存 rustId；后续 write/resize/tail/drop 同名单命令直用）。
#[tauri::command]
pub(crate) fn local_term_open(
    state: State<'_, AppState>,
    app: AppHandle,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    local_term_open_with(
        Arc::clone(&state.local_sessions),
        Some(app),
        None,
        cols,
        rows,
        on_data,
    )
}

/// 打开内部实现（可测面：注册表/shell/事件句柄全部参数化——测试传 None
/// app（不发 closed 事件）与指定 shell，不依赖 Tauri 运行实例）。
pub(crate) fn local_term_open_with(
    local_sessions: LocalTermMap,
    app: Option<AppHandle>,
    shell_override: Option<&str>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let cols = cols.clamp(2, 500) as u16;
    let rows = rows.clamp(2, 200) as u16;

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("local pty openpty: {e}"))?;

    let shell = shell_override
        .map(str::to_string)
        .unwrap_or_else(pick_shell);
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        cmd.cwd(home);
    }
    // TERM 缺失会让 ncurses 程序退化（vim/htop 无色）；256 色 = xterm.js 渲染
    // 能力下限口径。其余环境继承当前进程（CommandBuilder 默认行为）。
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    #[cfg(target_os = "windows")]
    cmd.arg("-NoLogo");
    #[cfg(not(target_os = "windows"))]
    if takes_login_flag(&shell) {
        // 登录 shell：读 profile（PATH/别名/homebrew 等）——本地终端的预期语义。
        cmd.arg("-l");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("local shell spawn: {e}"))?;
    // killer 从 child 克隆（ChildKiller trait 在 Child 上；MasterPty 没有）——
    // drop_session 用它独立终止子进程，主 child 句柄留给收尾 wait。
    let killer = child.clone_killer();
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("local pty writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("local pty reader: {e}"))?;

    let id = format!(
        "local-{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    let writer = Arc::new(Mutex::new(writer));
    let master = Arc::new(Mutex::new(pair.master));
    let counters = Arc::new(SessionCounters::default());
    let decoder = Arc::new(Mutex::new(StreamDecoder::new(
        ottr_term::encoding::Encoding::Utf8,
    )));
    let text_tail = Arc::new(TextTail::new());
    let cancel = Arc::new(AtomicBool::new(false));
    let recorder_slot: crate::commands::recording::RecorderSlot = Arc::new(Mutex::new(None));
    local_sessions.lock().unwrap().insert(
        id.clone(),
        LocalSessionEntry {
            writer: Arc::clone(&writer),
            killer: Arc::new(Mutex::new(killer)),
            master: Arc::clone(&master),
            counters: Arc::clone(&counters),
            decoder: Arc::clone(&decoder),
            text_tail: Arc::clone(&text_tail),
            recorder: Arc::clone(&recorder_slot),
            cols,
            rows,
            cancel: Arc::clone(&cancel),
        },
    );
    // 注入（bash/zsh 且 Unix）：与 SSH 侧同一片段（历史清理自带），独立线程
    // 免阻塞 open 命令返回。时序 = stty 行 → 等哨兵落地 → 钩子行；zsh 为
    // 三行历史编排（无 stty 步）。写失败静默——注入是增强面。
    #[cfg(not(target_os = "windows"))]
    {
        let kind = shell_kind(&shell);
        let inject_writer = Arc::clone(&writer);
        let inject_tail = Arc::clone(&text_tail);
        let inject_cancel = Arc::clone(&cancel);
        std::thread::spawn(move || {
            use ottr_ssh::shell_integration as si;
            use std::io::Write;
            let write_line = |line: &str| -> bool {
                if inject_cancel.load(Ordering::Relaxed) {
                    return false;
                }
                let mut w = inject_writer.lock().unwrap();
                w.write_all(line.as_bytes()).is_ok()
                    && w.write_all(b"\r").is_ok()
                    && w.flush().is_ok()
            };
            // 前置稳定窗（SSH 侧 wait_initial_output 同语义）：登录 shell 要
            // 读 profile——行纪律的回显发生在**写入瞬间**，而 `stty -echo` 要等
            // shell 读到该行才生效。不等首提示符就注入 = 注入行全部被回显
            // （首跑实测踩中）。输出静默 400ms + 至少观察 500ms、封顶 6s。
            let mut last_len = inject_tail.raw_head_len();
            let mut stable_since: Option<Instant> = None;
            let start = Instant::now();
            loop {
                if inject_cancel.load(Ordering::Relaxed) || start.elapsed() > Duration::from_secs(6)
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
                let len = inject_tail.raw_head_len();
                if len != last_len {
                    last_len = len;
                    stable_since = None;
                    continue;
                }
                let stable_for = stable_since.get_or_insert_with(Instant::now).elapsed();
                if start.elapsed() >= Duration::from_millis(500)
                    && stable_for >= Duration::from_millis(400)
                {
                    break;
                }
            }

            match kind {
                Some("bash") => {
                    if !write_line(si::ECHO_OFF_LINE) {
                        return;
                    }
                    // 等回显关闭生效（哨兵上屏）；100ms×15 兜底超时 = 可见退化
                    for _ in 0..15 {
                        if inject_tail.raw_head_contains(si::ECHO_OFF_MARKER) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    // 沉降：等 bash 执行完行 1 并重绘提示符——擦行（行 2 尾的
                    // printf）落在提示符行才擦得干净（首跑实测差这一步留一行残迹）
                    std::thread::sleep(Duration::from_millis(300));
                    let _ = write_line(&format!(
                        "{}; stty echo 2>/dev/null; printf '\\e[2K\\r\\e[1A\\e[2K'",
                        si::BASH_SNIPPET
                    ));
                }
                Some("zsh") => {
                    for line in si::zsh_inject_lines() {
                        if !write_line(&line) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(120));
                    }
                }
                _ => {}
            }
        });
    }

    // 读取线程（阻塞 64KB 块）→ mpsc；批量线程 recv_timeout 复刻 SSH 合批。
    // 线程边界理由：portable-pty 的 reader 是阻塞 std Read，无法 select；
    // recv_timeout 提供合批窗口需要的超时语义（std-only，不借 tokio）。
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let read_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子进程退出（exit 或被 kill）
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // 批量线程已收尾（IPC 失败/取消）
                    }
                }
                Err(e) => {
                    eprintln!("[{read_id}] local pty read error: {e}");
                    break;
                }
            }
        }
    });

    // 批量线程（收尾归它：child 收尸 + 录制自动落账 + 表项移除 + 关闭事件）
    let loop_id = id.clone();
    let recorder_slot = Arc::clone(&recorder_slot);
    std::thread::spawn(move || {
        let reason = local_forward_loop(
            &rx,
            &on_data,
            &counters,
            &decoder,
            &text_tail,
            &loop_id,
            &cancel,
            &recorder_slot,
        );
        // 收尾：child 收尸（子进程已死 wait 立即返回）+ 录制自动落账（敲 exit
        // 也要 finalize 入库；host_id None = 本地）+ 清表 + 关闭事件
        let _ = child.wait();
        let recording = recorder_slot.lock().unwrap().take();
        local_sessions.lock().unwrap().remove(&loop_id);
        if let Some(app) = &app {
            if let Some(handle) = recording {
                use tauri::Manager;
                if let Some(vault_state) = app.try_state::<crate::vault::VaultState>() {
                    let _ = crate::commands::recording::insert_finalized(&vault_state.0, handle);
                } else {
                    eprintln!("[local-term:{loop_id}] vault gone; recording lost");
                }
            }
            let _ = app.emit(
                "ottr://session-closed",
                SessionClosedEvent {
                    id: loop_id,
                    reason,
                },
            );
        }
    });

    Ok(id)
}

/// `ottr://session-closed` 载荷（前端 types.ts SessionClosedPayload 同构）。
#[derive(Clone, serde::Serialize)]
struct SessionClosedEvent {
    id: String,
    reason: SessionCloseReason,
}

/// 本地批量转发循环（语义对齐 `forward_pty_loop`：合批窗口/上限、解码、
/// TextTail、M-2 失败策略）。取消/EOF 的判定面 = mpsc 断开 + cancel 标志。
#[allow(clippy::too_many_arguments)] // recorder_slot 加入后 8 参（SSH 侧 flush 同款豁免）
fn local_forward_loop(
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
    session_id: &str,
    cancel: &AtomicBool,
    recorder_slot: &crate::commands::recording::RecorderSlot,
) -> SessionCloseReason {
    let limit = batch_limit();
    let window = batch_window();
    let mut buf: Vec<u8> = Vec::with_capacity(limit);
    let mut deadline: Option<Instant> = None;

    // EOF/收尾路径：Decoder 残字结算（不完整序列 → 替换符，字节永不静默丢弃）
    // 并入批尾后 flush；返回按 cancel 分派 Cancelled vs ShellExit。
    let finish_eof = |buf: &mut Vec<u8>, deadline: &mut Option<Instant>| -> SessionCloseReason {
        let tail = decoder.lock().unwrap().finish();
        if !tail.is_empty() {
            let mut merged = tail.into_bytes();
            merged.extend_from_slice(buf);
            *buf = merged;
        }
        flush_batch(
            buf,
            deadline,
            on_data,
            counters,
            decoder,
            text_tail,
            session_id,
            recorder_slot,
        );
        if cancel.load(Ordering::Relaxed) {
            eprintln!("[local-term:{session_id}] session dropped");
            SessionCloseReason::Cancelled
        } else {
            SessionCloseReason::ShellExit
        }
    };

    loop {
        if cancel.load(Ordering::Relaxed) {
            eprintln!("[local-term:{session_id}] session dropped");
            return SessionCloseReason::Cancelled;
        }
        // 空批阻塞等首块；非空批按合批窗口限时（窗口到点即刷，平滑小读）
        let chunk = match &deadline {
            Some(d) => match rx.recv_timeout(d.saturating_duration_since(Instant::now())) {
                Ok(bytes) => Some(bytes),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return finish_eof(&mut buf, &mut deadline);
                }
            },
            None => match rx.recv() {
                Ok(bytes) => Some(bytes),
                Err(_) => return finish_eof(&mut buf, &mut deadline),
            },
        };

        match chunk {
            Some(bytes) => {
                counters
                    .pty_read_bytes
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                if buf.is_empty() {
                    deadline = Some(Instant::now() + window);
                }
                buf.extend_from_slice(&bytes);
                if buf.len() >= limit
                    && !flush_batch(
                        &mut buf,
                        &mut deadline,
                        on_data,
                        counters,
                        decoder,
                        text_tail,
                        session_id,
                        recorder_slot,
                    )
                {
                    return SessionCloseReason::IpcFailed;
                }
            }
            None => {
                if !flush_batch(
                    &mut buf,
                    &mut deadline,
                    on_data,
                    counters,
                    decoder,
                    text_tail,
                    session_id,
                    recorder_slot,
                ) {
                    return SessionCloseReason::IpcFailed;
                }
            }
        }
    }
}

/// flush 一批到前端（M-2 失败策略同 `forward_pty_loop::flush_batch`：send 失败
/// 计显式账 + 置 failed 标志，调用方终止循环）。录制 tee 对齐 SSH 侧语义
/// （2026-10-20 录制接入本地会话，v1 的「本地无录制器」边界就此消除）。
#[allow(clippy::too_many_arguments)] // 同 SSH 侧 flush_batch 的既有豁免口径
fn flush_batch(
    buf: &mut Vec<u8>,
    deadline: &mut Option<Instant>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
    session_id: &str,
    recorder_slot: &crate::commands::recording::RecorderSlot,
) -> bool {
    *deadline = None;
    if buf.is_empty() {
        return true;
    }
    let raw = std::mem::replace(buf, Vec::with_capacity(64 * 1024));
    let text = decoder.lock().unwrap().decode_chunk(&raw);
    if text.is_empty() {
        return true; // 全部为批尾残字，滞留待下批（不丢，不发空帧）
    }
    text_tail.push(text.as_bytes());
    // 录制 tee：try_send 非阻塞，满/停即丢（转发热路径零等待）
    if let Some(handle) = recorder_slot.lock().unwrap().as_ref() {
        handle.send(text.as_bytes());
    }
    let n = text.len();
    match on_data.send(InvokeResponseBody::Raw(text.into_bytes())) {
        Ok(()) => {
            counters
                .forwarded_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            true
        }
        Err(e) => {
            counters
                .send_failed_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.send_failed_frames.fetch_add(1, Ordering::Relaxed);
            counters.failed.store(true, Ordering::Relaxed);
            eprintln!("[local-term:{session_id}] ipc send failed ({n} bytes lost): {e}");
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// 真实 PTY 往返（Unix）：open（`cat` 作受控回声假身）→ 击键写入 →
    /// 批量线程转出 on_data → drop（cancel+killer，与 drop_session 同款两步）
    /// → 表项被收尾清掉。Channel 用 tauri::ipc 原生构造（sh_inject_spike
    /// 同款，无需运行实例）；注册表直造（Default），不发 closed 事件
    /// （app = None——事件观察面属真机 e2e）。
    #[test]
    fn local_term_roundtrip_echo_and_drop() {
        let local_sessions: LocalTermMap = Default::default();
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&captured);
        let on_data = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });

        let id = local_term_open_with(
            Arc::clone(&local_sessions),
            None,
            Some("cat"),
            80,
            24,
            on_data,
        )
        .expect("open local term (cat)");
        assert!(
            local_sessions.lock().unwrap().contains_key(&id),
            "会话必须在册"
        );

        // 击键 → cat 回声 → 批量转出（轮询窗口 5s）
        let (writer, killer, cancel) = {
            let m = local_sessions.lock().unwrap();
            let e = m.get(&id).expect("entry");
            (
                Arc::clone(&e.writer),
                Arc::clone(&e.killer),
                Arc::clone(&e.cancel),
            )
        };
        {
            let mut w = writer.lock().unwrap();
            w.write_all(b"echo ottr-local-marker\n").expect("write");
            w.flush().expect("flush");
        }
        let marker = b"ottr-local-marker".to_vec();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let out = captured.lock().unwrap();
                if out.windows(marker.len()).any(|w| w == marker) {
                    break;
                }
            }
            assert!(Instant::now() < deadline, "echo not observed in time");
            std::thread::sleep(Duration::from_millis(50));
        }

        // drop 路径（与 drop_session 本地分支同款两步）→ 批量线程收尾清表
        cancel.store(true, Ordering::Relaxed);
        let _ = killer.lock().unwrap().kill();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if !local_sessions.lock().unwrap().contains_key(&id) {
                break;
            }
            assert!(Instant::now() < deadline, "entry not reaped after drop");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// shell 判定面：-l 白名单与注入目标识别（`cat` 两者皆否——测试假身
    /// 不被误加参数/误注入）。
    #[test]
    fn shell_tables_gate_login_flag_and_injection() {
        assert!(takes_login_flag("/bin/bash"));
        assert!(takes_login_flag("/usr/bin/zsh"));
        assert!(takes_login_flag("/bin/sh"));
        assert!(!takes_login_flag("cat"));
        assert!(!takes_login_flag("/usr/bin/fish"));
        assert_eq!(shell_kind("/bin/bash"), Some("bash"));
        assert_eq!(shell_kind("/bin/zsh"), Some("zsh"));
        assert_eq!(shell_kind("cat"), None);
    }
}
