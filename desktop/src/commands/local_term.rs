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
use std::time::Instant;

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
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    matches!(base, "bash" | "zsh" | "sh" | "ash" | "dash" | "ksh")
}

/// shell 选择（可测纯函数）：basename 识别 bash/zsh（注入目标）；其余 None。
/// zsh 启动目录（ZDOTDIR 注入）：四个启动文件都先还原用户 ZDOTDIR 再原样
/// 加载用户同名文件，`.zshrc` 末尾追加集成钩子（覆盖用户自定义 precmd/preexec
/// ——与远端注入同语义）。用户未设 ZDOTDIR 时回落 `$HOME`。
fn write_zsh_startup_dir() -> Option<std::path::PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ottr-zsh-{:x}-{:x}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).ok()?;
    let restore = |name: &str| {
        let head = "# Ottr 本地终端集成（生成文件，勿手改）：还原用户启动文件链\n";
        let branch = r#"case "$OTTR_USER_ZDOTDIR" in "") rc_dir="$HOME" ;; *) rc_dir="$OTTR_USER_ZDOTDIR" ;; esac
"#;
        let line = format!(
            r#"[ -f "$rc_dir/{name}" ] && . "$rc_dir/{name}"
"#,
            name = name
        );
        format!("{head}{branch}{line}")
    };
    for name in [".zshenv", ".zprofile", ".zlogin"] {
        std::fs::write(dir.join(name), restore(name)).ok()?;
    }
    let mut zshrc = restore(".zshrc");
    // 链式钩子体（2026-10-29）：用户原有的 precmd/preexec 保留，不再覆盖。
    zshrc.push_str(&format!(
        "{}\n",
        ottr_ssh::shell_integration::zsh_hook_body()
    ));
    std::fs::write(dir.join(".zshrc"), zshrc).ok()?;
    Some(dir)
}

/// bash 启动文件（--rcfile 注入）：bash 以**非 login 交互**启动时读 rcfile
/// 代替 ~/.bashrc。生成文件复刻 bash 自身的 login 文件优先序（bash_profile →
/// bash_login → profile；全缺才回落 .bashrc），末尾追加集成钩子——PATH/别名
/// 等登录语义不丢，且全程零敲入。
fn write_bash_rcfile() -> Option<std::path::PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "ottr-bash-{:x}-{:x}/rcfile",
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(path.parent()?).ok()?;
    let head = "# Ottr 本地终端集成（生成文件，勿手改）：复刻 login 文件链\n";
    let chain = concat!(
        "if [ -f \"$HOME/.bash_profile\" ]; then . \"$HOME/.bash_profile\";\n",
        "elif [ -f \"$HOME/.bash_login\" ]; then . \"$HOME/.bash_login\";\n",
        "elif [ -f \"$HOME/.profile\" ]; then . \"$HOME/.profile\";\n",
        "elif [ -f \"$HOME/.bashrc\" ]; then . \"$HOME/.bashrc\"; fi\n"
    );
    let content = format!(
        "{head}{chain}{}\n",
        // 链式钩子体（2026-10-29）：用户原有的 PROMPT_COMMAND / DEBUG trap
        // 保留，不再覆盖；退出码原样传给用户钩子。
        ottr_ssh::shell_integration::bash_hook_body(&path.to_string_lossy())
    );
    std::fs::write(&path, content).ok()?;
    Some(path)
}

/// sh 系（dash/ash/bash-as-sh）ENV 钩子文件：先 source 用户原 $ENV（非空且
/// 存在时），再追加 PS1 包装片段（片段自带 `133;D` 幂等护栏）。dash/ash 对
/// 交互式 shell 读 $ENV——不敲一字节即得 OSC 133。
fn write_sh_env_file() -> Option<std::path::PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path =
        std::env::temp_dir().join(format!("ottr-sh-{:x}-{:x}/env", std::process::id(), nanos));
    std::fs::create_dir_all(path.parent()?).ok()?;
    let head = "# Ottr 本地终端集成（生成文件，勿手改）\n";
    let chain = r#"[ -n "$OTTR_USER_ENV" ] && [ -f "$OTTR_USER_ENV" ] && . "$OTTR_USER_ENV"
"#;
    let content = format!("{head}{chain}{}\n", ottr_ssh::shell_integration::SH_SNIPPET);
    std::fs::write(&path, content).ok()?;
    Some(path)
}

fn shell_kind(path: &str) -> Option<&'static str> {
    // Windows 路径（C:\...\powershell.exe）同样按 \ 切 basename
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match base {
        "bash" => Some("bash"),
        "zsh" => Some("zsh"),
        _ => None,
    }
}

/// 本地登录 shell 路径：`$SHELL` → `/bin/bash` → `/bin/sh`（按存在性兜底）。
/// Windows：`$SHELL`（git-bash 等用户自设）→ `powershell.exe`（系统盘固定
/// 位置，Windows 必有）→ `ComSpec`（cmd.exe）——此前的实现会落到不存在的
/// `/bin/sh`，Windows 本地终端根本起不来（2026-10-21 评估发现）。
#[cfg(target_os = "windows")]
fn pick_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL")
        && !shell.trim().is_empty()
        && std::path::Path::new(shell.trim()).exists()
    {
        return shell.trim().to_string();
    }
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let powershell = format!("{system_root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if std::path::Path::new(&powershell).exists() {
        return powershell;
    }
    std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into())
}

#[cfg(not(target_os = "windows"))]
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
    vault: State<'_, crate::vault::VaultState>,
    app: AppHandle,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    // shell 集成开关（settings `shell.integration`，与 SSH 注入同一设置同一
    // 收敛语义：缺省开、读取失败兜底开——attach.rs 同款现读）。
    let integration = crate::security::shell_integration_enabled(
        ottr_vault::Settings::get(&vault.0, crate::security::SETTING_SHELL_INTEGRATION)
            .unwrap_or(None)
            .as_ref(),
    );
    local_term_open_with(
        Arc::clone(&state.local_sessions),
        Some(app),
        None,
        integration,
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
    integration_enabled: bool,
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
    // -NoLogo 是 PowerShell 旗标（powershell/pwsh 均支持）；cmd/git-bash 不加
    #[cfg(target_os = "windows")]
    if shell.to_ascii_lowercase().contains("powershell") {
        cmd.arg("-NoLogo");
    }
    // 启动文件注入（Unix，2026-10-20 敲入全面改型）：不往 PTY 写任何字节——
    // zsh 用 ZDOTDIR 指向生成目录（四启动文件先原样加载用户同名文件、.zshrc
    // 末尾追加集成钩子），sh 系用 ENV 钩子文件（先 source 用户 $ENV 再追加
    // 片段），bash 用 --rcfile（生成文件复刻 login 文件链 bash_profile →
    // bash_login → profile、无则 .bashrc，末尾追加钩子）。敲入法的根治面：
    // 无回显竞速、零终端残留、不进历史、不吃 .zshrc 慢初始化（VS Code 终端
    // 同法）。bash 在 rcfile 模式**不吃 -l**（login 调用会忽略 --rcfile），
    // 登录语义由生成文件自己复刻。文件落系统临时目录，由 OS 临时目录策略回收。
    #[cfg(not(target_os = "windows"))]
    let bash_rcfile: Option<std::path::PathBuf> = if integration_enabled {
        match shell_kind(&shell) {
            Some("zsh") => {
                if let Some(dir) = write_zsh_startup_dir() {
                    cmd.env(
                        "OTTR_USER_ZDOTDIR",
                        std::env::var_os("ZDOTDIR").unwrap_or_default(),
                    );
                    cmd.env("ZDOTDIR", dir);
                }
                None
            }
            Some("sh") => {
                if let Some(env_file) = write_sh_env_file() {
                    cmd.env("OTTR_USER_ENV", std::env::var_os("ENV").unwrap_or_default());
                    cmd.env("ENV", env_file);
                }
                None
            }
            Some("bash") => {
                let rc = write_bash_rcfile();
                if let Some(path) = &rc {
                    cmd.arg("--rcfile");
                    cmd.arg(path);
                }
                rc
            }
            _ => None,
        }
    } else {
        None
    };

    #[cfg(target_os = "windows")]
    let _ = integration_enabled;
    #[cfg(not(target_os = "windows"))]
    if takes_login_flag(&shell) && bash_rcfile.is_none() {
        // 登录 shell：读 profile（PATH/别名/homebrew 等）——本地终端的预期语义。
        // bash rcfile 模式除外（见上：login 会忽略 --rcfile）。
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
            use tauri::Manager;
            if let Some(handle) = recording {
                if let Some(vault_state) = app.try_state::<crate::vault::VaultState>() {
                    let _ = crate::commands::recording::insert_finalized(&vault_state.0, handle);
                } else {
                    eprintln!("[local-term:{loop_id}] vault gone; recording lost");
                }
            }
            // 监控采样随会话消亡停表（SSH 路径 register.rs 的 session_down 钩子同款）
            app.state::<crate::commands::state::AppState>()
                .monitors
                .session_down(&loop_id);
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
    use std::time::Duration;

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
            false,
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

    /// 真机 zsh 注入改型验收（2026-10-20 截图四回归）：本地 zsh 首屏必须
    /// **零敲入残留**（raw 输出里不得出现注入文本）且出现 OSC 133;A（ZDOTDIR
    /// 启动文件链生效）。无 zsh 的环境（部分 CI）跳过。用户真实 ~/.zshrc 会
    /// 被加载——测试只读 PTY 输出、不写任何字节，退出即清表。
    #[test]
    fn local_zsh_injects_via_startup_files_without_typing() {
        if std::process::Command::new("zsh")
            .arg("-f")
            .arg("-c")
            .arg(":")
            .output()
            .is_err()
        {
            eprintln!("skipped: zsh unavailable");
            return;
        }
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
            Some("zsh"),
            true,
            100,
            30,
            on_data,
        )
        .expect("open local zsh");
        let marker = b"\x1b]133;A".to_vec();
        let noise = b"precmd(){".to_vec();
        let mut saw_133a = false;
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            {
                let out = captured.lock().unwrap();
                saw_133a = out.windows(marker.len()).any(|w| w == marker);
                if saw_133a {
                    assert!(
                        !out.windows(noise.len()).any(|w| w == noise),
                        "注入文本出现在 PTY 输出 = 敲入残留（启动文件链未生效）"
                    );
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let (_writer, killer, cancel) = {
            let m = local_sessions.lock().unwrap();
            let e = m.get(&id).expect("entry");
            (
                Arc::clone(&e.writer),
                Arc::clone(&e.killer),
                Arc::clone(&e.cancel),
            )
        };
        cancel.store(true, Ordering::Relaxed);
        let _ = killer.lock().unwrap().kill();
        assert!(
            saw_133a,
            "15s 内未见 OSC 133;A（ZDOTDIR 集成未生效；本机 zsh 环境请人工复核）"
        );
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

/// 启动文件注入生成面单测：zsh 四启动文件齐 + `.zshrc` 末尾带钩子、还原链
/// 指向 $HOME（未设 OTTR_USER_ZDOTDIR）；sh ENV 文件含幂等片段 + 用户链。
#[cfg(test)]
mod startup_file_tests {
    use super::{write_sh_env_file, write_zsh_startup_dir};

    #[test]
    fn zsh_startup_dir_writes_four_files_with_snippet_last() {
        let dir = write_zsh_startup_dir().expect("startup dir");
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let p = dir.join(name);
            assert!(p.is_file(), "{name} 缺失");
            let text = std::fs::read_to_string(&p).unwrap();
            assert!(text.contains("OTTR_USER_ZDOTDIR"), "{name} 缺用户链还原");
            assert!(text.contains("rc_dir"), "{name} 缺 HOME 回落");
        }
        let zshrc = std::fs::read_to_string(dir.join(".zshrc")).unwrap();
        // 链式钩子体（2026-10-29）：用户 precmd/preexec 保留，不再覆盖
        let body = ottr_ssh::shell_integration::zsh_hook_body();
        assert!(
            zshrc
                .rfind(&body)
                .is_some_and(|pos| pos > zshrc.find(".zshrc").unwrap()),
            "集成钩子必须加载在用户 .zshrc 之后（链接用户 precmd 才生效）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sh_env_file_chains_user_env_and_snippet() {
        let path = write_sh_env_file().expect("env file");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("OTTR_USER_ENV"), "缺用户 $ENV 链");
        assert!(
            text.contains(ottr_ssh::shell_integration::SH_SNIPPET),
            "缺 PS1 包装片段"
        );
        let _ = std::fs::remove_file(&path);
    }
}

/// bash --rcfile 注入验收（2026-10-20 真机：stty 敲入路径残留一行可见——
/// 敲入法整体退役后的回归防线）：零敲入残留（无 stty/PROMPT_COMMAND 字面）
/// 且出现 OSC 133;A。
#[cfg(test)]
mod bash_acceptance_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn local_bash_injects_via_rcfile_without_typing() {
        let bash = if std::path::Path::new("/bin/bash").exists() {
            "/bin/bash"
        } else {
            "bash"
        };
        if std::process::Command::new(bash)
            .arg("--norc")
            .arg("-c")
            .arg(":")
            .output()
            .is_err()
        {
            eprintln!("skipped: bash unavailable");
            return;
        }
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
            Some(bash),
            true,
            100,
            30,
            on_data,
        )
        .expect("open local bash");
        let marker = b"\x1b]133;A".to_vec();
        let mut saw_133a = false;
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            {
                let out = captured.lock().unwrap();
                saw_133a = out.windows(marker.len()).any(|w| w == marker);
                if saw_133a {
                    for noise in [b"stty -echo".as_slice(), b"PROMPT_COMMAND=".as_slice()] {
                        assert!(
                            !out.windows(noise.len()).any(|w| w == noise),
                            "敲入残留出现在 PTY 输出：{:?}",
                            String::from_utf8_lossy(noise)
                        );
                    }
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let (_writer, killer, cancel) = {
            let m = local_sessions.lock().unwrap();
            let e = m.get(&id).expect("entry");
            (
                Arc::clone(&e.writer),
                Arc::clone(&e.killer),
                Arc::clone(&e.cancel),
            )
        };
        cancel.store(true, Ordering::Relaxed);
        let _ = killer.lock().unwrap().kill();
        assert!(saw_133a, "15s 内未见 OSC 133;A（bash rcfile 集成未生效）");
    }
}
