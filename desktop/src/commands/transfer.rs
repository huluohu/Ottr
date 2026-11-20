//! 传输命令域（Task 0 拆分，纯搬家）：SFTP 文件面板命令面 + 本地栏 + 传输队列
//! （journal 派生/清扫、进度节流、begin/progress/end 事件、取消）。
//! SFTP 通道复用既有会话（SessionEntry 持 Arc<SshSession>，见 sftp_for）。
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use super::state::{
    AppState, SFTP_CHUNKS, TRANSFER_PROGRESS_INTERVAL, TRANSFER_SEQ, TransferEntry, TransferMap,
};

// ---------------------------------------------------------------------------
// Task 10（A5）：SFTP 文件面板命令面 + 传输队列（进度/取消，事件驱动）
// ---------------------------------------------------------------------------
// 设计裁定（task-10 简报/协调者记录）：
//   * SFTP 通道**复用既有会话**：SessionEntry 持 Arc<SshSession>，从同一 russh
//     handle 开新 subsystem channel（sftp_for），绝不新建 SSH 连接；
//   * 远端文件操作走 SFTP 而非 exec（ottr_transfer::ops 模块文档裁定）；
//   * 传输 = 后台任务 + 全局事件（ottr://transfer-begin/progress/end，全局 emit
//     带 transfer_id）；取消 = chunk 边界协作令牌，journal 保留（重传即续传）；
//   * journal 路径按传输身份（mode|path|total）确定性派生到 app_cache_dir，
//     失败重试 / 应用重启后同身份重传自动断点续传。

/// 取会话的 SFTP 客户端（懒开 + 缓存；会话不存在/已死显式报错）。
/// pub(crate)：remote_edit 域（Phase 2 Task 3）复用同一条懒开通道。
/// **SFTP 专属**：FTP 会话（Phase 2 Task 5）与本地终端会话（2026-10-20）在此
/// 显式报错——远端编辑依赖 SFTP 的读写原语（open_remote_text/write_remote_text），
/// FTP 面板本期不提供编辑；本地会话的「编辑」由前端直接用系统默辑器打开
/// 本机文件（FilePanel 菜单按会话种类分流）。
pub(crate) async fn sftp_for(
    state: &AppState,
    id: &str,
) -> Result<Arc<ottr_transfer::SftpClient>, String> {
    if state.ftp_sessions.lock().unwrap().contains_key(id) {
        return Err(format!(
            "session {id} is an FTP/FTPS session: remote edit requires SSH (SFTP)"
        ));
    }
    if state.local_sessions.lock().unwrap().contains_key(id) {
        return Err(format!(
            "session {id} is a local terminal: open the file directly instead of remote edit"
        ));
    }
    // 会话取一次 Arc（sessions 表锁内只做查表）；slot 锁（tokio Mutex）
    // **持锁跨 await** 懒开：并发双开时第二路等锁后复用第一路的实例
    // （同会话单客户端）——std Mutex 形态下双开各自开 SFTP 子系统通道，
    // 输家整只客户端被静默 drop，远端 sftp-server 子进程无 CHANNEL_CLOSE
    // 残留到会话断开。
    let (session, slot) = {
        let sessions = state.sessions.lock().unwrap();
        let e = sessions
            .get(id)
            .ok_or_else(|| format!("no such session: {id}"))?;
        (Arc::clone(&e.session), Arc::clone(&e.sftp))
    };
    let mut guard = slot.lock().await;
    if let Some(c) = guard.as_ref() {
        return Ok(Arc::clone(c));
    }
    let client = Arc::new(
        ottr_transfer::SftpClient::open(&session)
            .await
            .map_err(|e| e.to_string())?,
    );
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// FilePanel 远端操作客户端的三态：SSH 会话 → SFTP，FTP/FTPS 会话 → FtpClient
/// （Phase 2 Task 5），本地终端会话 → 本机文件系统（2026-10-20：本地会话的
/// 「远端栏」就是这台机器，双栏同源可浏览/整理/复制）。命令面（sftp_* 命令名
/// 不变）按会话表分派，前端零感知。
pub(crate) enum FileClient {
    Sftp(Arc<ottr_transfer::SftpClient>),
    Ftp(Arc<ottr_transfer::FtpClient>),
    Local,
}

// ---------------------------------------------------------------------------
// SFTP 会话级客户端缓存的自愈（robustness 审计 P2：子系统通道死后文件面永久
// 报错——槽位只在懒开成功时写入、错误路径从不清理）
// ---------------------------------------------------------------------------

/// 擦除后的底层错误文本 → 是否通道/协议级（SFTP 客户端缓存槽位应清）。
///
/// ottr-transfer 的 `Error::Protocol` 在产生点把 russh-sftp 3.0.1 的
/// `client::error::Error` 类型擦除进 `source`（I-1 纪律：底层类型不出 crate，
/// desktop 不引 russh-sftp）——判据按其 Display 形态分层，逐一对照源码：
///
/// **清槽**（通道/协议级——子系统任务已死、应答通道断、协议失配、超时）：
/// * `"I/O: …"`（`Error::IO`，通道 IO 故障；低层 error::Error::IO 经
///   UnexpectedBehavior 包装后同形态）
/// * `"Timeout"`（`Error::Timeout`，应答超时）
/// * `"Unexpected packet"`（`Error::UnexpectedPacket`，协议失配）
/// * `"Bad message: …"`（`Status(BadMessage)` / 低层 `BadMessage`——协议级）
/// * `"No connection: …"` / `"Connection lost: …"`（客户端本地生成的伪
///   Status——RFC 明示 MUST NOT 由服务器返回，即连接已死）
/// * `"RecvError…"` / `"SendError…"`（UnexpectedBehavior 包装的 oneshot/mpsc
///   通道断——sftp 客户端应答任务已亡 = 子系统通道已死）
/// * `"Unexpected EOF on stream"` / `"Client error. (…)"`（低层解析/流错误）
///
/// **不清**（服务器正常应答的业务错误——通道健康，重开无益）：
/// * `"No such file: …"` / `"Permission denied: …"` / `"Failure: …"` /
///   `"Eof: …"` / `"Operation unsupported: …"` / `"Ok: …"`（`Status` 包）
/// * `"Limit exceeded: …"`（limits@openssh.com 扩展应答）
///
/// **缺省清**（未知形态 / source 缺失的应用层错误不走本函数）：误清的代价
/// 只是一次重开（几百 ms），wedged 不清 = 文件面永久报错——宁可偏保守。
pub(crate) fn sftp_slot_wedged_text(text: &str) -> bool {
    const TRANSPORT: [&str; 9] = [
        "I/O: ",
        "Timeout",
        "Unexpected packet",
        "Bad message",
        "No connection",
        "Connection lost",
        "RecvError",
        "SendError",
        "Unexpected EOF on stream",
    ];
    if TRANSPORT.iter().any(|m| text.contains(m)) {
        return true;
    }
    if text.contains("Client error.") {
        return true;
    }
    const SERVER_STATUS: [&str; 7] = [
        "No such file: ",
        "Permission denied: ",
        "Failure: ",
        "Eof: ",
        "Operation unsupported: ",
        "Ok: ",
        "Limit exceeded: ",
    ];
    // 服务器正常应答（StatusCode 2xx 语义 + limits 扩展）→ 通道健康，清了白白重开
    !SERVER_STATUS.iter().any(|m| text.contains(m))
}

/// typed 面：ottr_transfer 错误 → 判据。`Protocol { source: Some }` 才代表
/// 底层 SFTP 错误（source 缺失的应用层错误、本地 IO、取消都与通道健康无关，
/// 一律不清）。
pub(crate) fn sftp_slot_wedged(err: &ottr_transfer::Error) -> bool {
    match err {
        ottr_transfer::Error::Protocol {
            source: Some(src), ..
        } => sftp_slot_wedged_text(&src.to_string()),
        _ => false,
    }
}

/// 清会话的 SFTP 缓存槽（下次调用在 `sftp_for` 重开 subsystem 自愈）。
/// 只对 SSH 会话生效——id 必须在 SSH 表里（FTP/本地会话无槽，天然跳过）。
async fn clear_sftp_slot(state: &AppState, id: &str, why: &str) {
    let slot = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(id).map(|entry| Arc::clone(&entry.sftp))
    };
    if let Some(slot) = slot {
        *slot.lock().await = None;
        eprintln!("[sftp:{id}] cached client cleared ({why}); subsystem reopens on next use");
    }
}

/// sftp_* 命令统一收尾壳：客户端操作失败时按判据清 SFTP 缓存槽（wedged
/// 自愈），错误文本照旧上抛——行为兼容，只在协议级错误后多一次重开。
async fn sftp_op<T>(
    state: &AppState,
    id: &str,
    op: impl std::future::Future<Output = ottr_transfer::Result<T>>,
) -> Result<T, String> {
    match op.await {
        Ok(v) => Ok(v),
        Err(e) => {
            if sftp_slot_wedged(&e) {
                clear_sftp_slot(state, id, "protocol-level error").await;
            }
            Err(e.to_string())
        }
    }
}

/// 本机文件系统操作统一下 spawn_blocking（网络盘/大目录可能秒级阻塞，不得
/// 冻结 UI——与 local_list 同口径）；io 错误映射为传输层 `Error::Io`。
async fn local_fs<T: Send + 'static>(
    f: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> ottr_transfer::Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| ottr_transfer::Error::Protocol {
            message: format!("local fs join error: {e}"),
            source: None,
        })?
        .map_err(ottr_transfer::Error::Io)
}

/// 本机主目录（本地会话远端栏 `realpath(".")` 的落点；与 local_term 的 cwd
/// 同源：HOME，Windows 回落 USERPROFILE）。
fn local_home_dir() -> std::io::Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("home directory unavailable (HOME/USERPROFILE unset)"))
}

fn local_stat_sync(path: &str) -> std::io::Result<ottr_transfer::DirEntry> {
    let meta = std::fs::metadata(path)?;
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    Ok(dir_entry_from_meta(name, &meta))
}

fn dir_entry_from_meta(name: String, meta: &std::fs::Metadata) -> ottr_transfer::DirEntry {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or(0);
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode()
    };
    #[cfg(not(unix))]
    let mode = 0u32;
    ottr_transfer::DirEntry {
        name,
        is_dir: meta.is_dir(),
        size: meta.len(),
        mode,
        mtime,
    }
}

fn local_list_dir_sync(path: &str) -> std::io::Result<Vec<ottr_transfer::DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let Ok(entry) = entry else { continue }; // 竞态删除等瞬时错误跳过（目录列表容忍）
        let Ok(meta) = entry.metadata() else { continue };
        out.push(dir_entry_from_meta(
            entry.file_name().to_string_lossy().into_owned(),
            &meta,
        ));
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

fn local_chmod_sync(path: &str, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Err(std::io::Error::other(
            "chmod is not supported on this platform",
        ))
    }
}

impl FileClient {
    /// stat 单路径（预 stat 总长 / 面板查询共用）。
    pub(crate) async fn stat(&self, path: &str) -> ottr_transfer::Result<ottr_transfer::DirEntry> {
        match self {
            FileClient::Sftp(c) => c.stat(path).await,
            FileClient::Ftp(c) => c.stat(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || local_stat_sync(&p)).await
            }
        }
    }

    /// 路径解析（FTP 仅 `.` 展开，见 ftp.rs 模块文档；本机 `.`/空 = 主目录，
    /// 其余 canonicalize）。
    pub(crate) async fn realpath(&self, path: &str) -> ottr_transfer::Result<String> {
        match self {
            FileClient::Sftp(c) => c.realpath(path).await,
            FileClient::Ftp(c) => c.realpath(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || {
                    let resolved = if p.is_empty() || p == "." {
                        local_home_dir()?
                    } else {
                        std::fs::canonicalize(&p)?
                    };
                    Ok(resolved.to_string_lossy().into_owned())
                })
                .await
            }
        }
    }

    /// 列目录。
    pub(crate) async fn list_dir(
        &self,
        path: &str,
    ) -> ottr_transfer::Result<Vec<ottr_transfer::DirEntry>> {
        match self {
            FileClient::Sftp(c) => c.list_dir(path).await,
            FileClient::Ftp(c) => c.list_dir(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || local_list_dir_sync(&p)).await
            }
        }
    }

    /// 新建目录。
    pub(crate) async fn mkdir(&self, path: &str) -> ottr_transfer::Result<()> {
        match self {
            FileClient::Sftp(c) => c.mkdir(path).await,
            FileClient::Ftp(c) => c.mkdir(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || std::fs::create_dir(&p)).await
            }
        }
    }

    /// 重命名。
    pub(crate) async fn rename(&self, from: &str, to: &str) -> ottr_transfer::Result<()> {
        match self {
            FileClient::Sftp(c) => c.rename(from, to).await,
            FileClient::Ftp(c) => c.rename(from, to).await,
            FileClient::Local => {
                let (f, t) = (from.to_string(), to.to_string());
                local_fs(move || std::fs::rename(&f, &t)).await
            }
        }
    }

    /// 删除文件。
    pub(crate) async fn remove_file(&self, path: &str) -> ottr_transfer::Result<()> {
        match self {
            FileClient::Sftp(c) => c.remove_file(path).await,
            FileClient::Ftp(c) => c.remove_file(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || std::fs::remove_file(&p)).await
            }
        }
    }

    /// 删除空目录（本机同 SFTP 语义：非空目录由 remove_dir 拒绝，显式失败优于误删）。
    pub(crate) async fn remove_dir(&self, path: &str) -> ottr_transfer::Result<()> {
        match self {
            FileClient::Sftp(c) => c.remove_dir(path).await,
            FileClient::Ftp(c) => c.remove_dir(path).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || std::fs::remove_dir(&p)).await
            }
        }
    }

    /// chmod（`mode` 为完整 POSIX 权限位；FTP 走 SITE CHMOD，仅 9 位语义；
    /// 本机仅 unix 支持，Windows 显式报错）。
    pub(crate) async fn chmod(&self, path: &str, mode: u32) -> ottr_transfer::Result<()> {
        match self {
            FileClient::Sftp(c) => c.chmod(path, mode).await,
            FileClient::Ftp(c) => c.chmod(path, mode & 0o777).await,
            FileClient::Local => {
                let p = path.to_string();
                local_fs(move || local_chmod_sync(&p, mode)).await
            }
        }
    }
}

/// 取会话的远端操作客户端（SSH 表 → 本地表 → FTP 表；都未命中显式报错）。
async fn file_client_for(state: &AppState, id: &str) -> Result<FileClient, String> {
    if state.sessions.lock().unwrap().contains_key(id) {
        return Ok(FileClient::Sftp(sftp_for(state, id).await?));
    }
    if state.local_sessions.lock().unwrap().contains_key(id) {
        return Ok(FileClient::Local);
    }
    super::ftp::ftp_for(state, id).await.map(FileClient::Ftp)
}

#[tauri::command]
pub(crate) async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<ottr_transfer::DirEntry>, String> {
    let client = file_client_for(&state, &id).await?;
    sftp_op(&state, &id, client.list_dir(&path)).await
}

#[tauri::command]
pub(crate) async fn sftp_realpath(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let client = file_client_for(&state, &id).await?;
    sftp_op(&state, &id, client.realpath(&path)).await
}

#[tauri::command]
pub(crate) async fn sftp_mkdir(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let client = file_client_for(&state, &id).await?;
    sftp_op(&state, &id, client.mkdir(&path)).await
}

/// 幂等建目录（递归上传用，2026-10-19）：已存在且是目录 → Ok（不报错）；
/// 不存在 → mkdir。单层语义（调用方逐级建），与 `sftp_mkdir` 的区别仅此。
#[tauri::command]
pub(crate) async fn sftp_mkdir_all(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let client = file_client_for(&state, &id).await?;
    if client.stat(&path).await.is_ok() {
        return Ok(()); // 已存在（目录或同名文件）：交给后续传输报同名文件错误
    }
    sftp_op(&state, &id, client.mkdir(&path)).await
}

#[tauri::command]
pub(crate) async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let client = file_client_for(&state, &id).await?;
    sftp_op(&state, &id, client.rename(&from, &to)).await
}

/// 删除远端文件或空目录（`is_dir` 选 remove/rmdir；递归删除不进 MVP——
/// 非空目录由服务器拒绝，显式失败优于误删）。
#[tauri::command]
pub(crate) async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let client = file_client_for(&state, &id).await?;
    if is_dir {
        sftp_op(&state, &id, client.remove_dir(&path)).await
    } else {
        sftp_op(&state, &id, client.remove_file(&path)).await
    }
}

/// chmod（`mode` 为完整 POSIX 权限位十进制值，如 0o644 = 420）。
/// Fix round 1 I-2：命令层校验 0..=0o777——非法值（负数进不来 u32，但超大值/
/// 类型位误传）显式报错，不透传给 SFTP setstat 静默产生怪权限。
#[tauri::command]
pub(crate) async fn sftp_chmod(
    state: State<'_, AppState>,
    id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    if mode > 0o777 {
        return Err(format!(
            "invalid mode {mode} (0o{mode:o}): must be within 0..=0o777"
        ));
    }
    let client = file_client_for(&state, &id).await?;
    sftp_op(&state, &id, client.chmod(&path, mode)).await
}

// --- 本地面（FilePanel 左栏） ------------------------------------------------

#[derive(serde::Serialize)]
pub(crate) struct LocalEntry {
    name: String,
    is_dir: bool,
    size: u64,
    mode: u32,
    /// 秒级 Unix 时间（与远端 DirEntry.mtime 同口径）。
    mtime: i64,
}

/// Fix round 1 I-3：async 命令 + spawn_blocking——目录读（大目录/网络盘可能
/// 秒级阻塞）不得在主线程执行冻结整个 UI（含终端）。
#[tauri::command]
pub(crate) async fn local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir_sync(path))
        .await
        .map_err(|e| format!("local_list join error: {e}"))?
}

fn list_dir_sync(path: String) -> Result<Vec<LocalEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| format!("read_dir {path}: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 竞态删除等瞬时错误跳过（目录列表容忍）
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode()
        };
        #[cfg(not(unix))]
        let mode = 0u32;
        out.push(LocalEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mode,
            mtime,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// 用户主目录（本地栏初始位置）。
#[tauri::command]
pub(crate) fn local_home(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("home_dir: {e}"))
}

/// 下载目录（下载降级目标的默认位置；不存在时回退主目录）。
#[tauri::command]
pub(crate) fn local_downloads_dir(app: AppHandle) -> Result<String, String> {
    let home = local_home(app)?;
    let downloads = PathBuf::from(&home).join("Downloads");
    Ok(if downloads.is_dir() {
        downloads.to_string_lossy().into_owned()
    } else {
        home
    })
}

// --- 本地栏写操作（feat/file-panel-enhancements）：mkdir/删除/OS 拖拽落盘复制。
// 同步核心独立成 *_sync 供单测直驱；命令壳 spawn_blocking（删除大目录/复制大
// 文件可能秒级，不得冻结 UI——与 local_list 同口径）。

fn local_mkdir_sync(path: &str) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("mkdir {path}: already exists"),
        _ => format!("mkdir {path}: {e}"),
    })
}

fn local_remove_sync(path: &str, is_dir: bool) -> Result<(), String> {
    // 根/盘符/空路径一律拒绝——删除是危险动作，UI 确认对话框之外再兜一道。
    if path.trim().is_empty() || Path::new(path).parent().is_none() {
        return Err(format!("local_remove: refuse suspicious path {path:?}"));
    }
    if is_dir {
        std::fs::remove_dir_all(path).map_err(|e| format!("remove_dir {path}: {e}"))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("remove_file {path}: {e}"))
    }
}

fn local_copy_sync(from: &str, to_dir: &str) -> Result<(), String> {
    let name = Path::new(from)
        .file_name()
        .ok_or_else(|| format!("local_copy: no file name in {from:?}"))?;
    let dest = Path::new(to_dir).join(name);
    std::fs::copy(from, &dest).map_err(|e| format!("copy {from}: {e}"))?;
    Ok(())
}

/// 新建本地目录（本地栏「新建文件夹」）。单级 create_dir：已存在显式报错，
/// 不做 create_dir_all 的静默幂等——避免用户以为建到了别的层级。
#[tauri::command]
pub(crate) async fn local_mkdir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || local_mkdir_sync(&path))
        .await
        .map_err(|e| format!("local_mkdir join error: {e}"))?
}

/// 删除本地文件/目录（目录递归）。UI 侧有确认对话框把关，此处只兜根路径。
#[tauri::command]
pub(crate) async fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || local_remove_sync(&path, is_dir))
        .await
        .map_err(|e| format!("local_remove join error: {e}"))?
}

/// OS 拖拽落本地栏：把来源文件复制进目标目录（保留文件名，重名覆盖——
/// 与上传「重名覆盖」口径一致）。
#[tauri::command]
pub(crate) async fn local_copy(from: String, to_dir: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || local_copy_sync(&from, &to_dir))
        .await
        .map_err(|e| format!("local_copy join error: {e}"))?
}

// --- 传输队列（事件 + 取消） ---------------------------------------------------

#[derive(Clone, serde::Serialize)]
struct TransferBeginPayload {
    transfer_id: String,
    /// "download" | "upload"
    kind: &'static str,
    remote_path: String,
    local_path: String,
    /// 预 stat 的总字节（stat 失败 = 0，随后 progress 事件携带真实 total）。
    total: u64,
}

#[derive(Clone, serde::Serialize)]
struct TransferProgressPayload {
    transfer_id: String,
    transferred: u64,
    total: u64,
}

#[derive(Clone, serde::Serialize)]
struct TransferEndPayload {
    transfer_id: String,
    /// "done" | "failed" | "cancelled"
    status: &'static str,
    message: String,
}

#[derive(serde::Serialize)]
pub(crate) struct TransferStarted {
    transfer_id: String,
    local_path: String,
    remote_path: String,
    total: u64,
}

/// journal 确定性路径（Fix round 1 C-1）：app_cache_dir/transfers/{journal_file_name}.journal。
/// 文件名 = sha256(mode | **scope** | identity_path | total)：scope 掺传输作用域
/// 身份（下载 = host 端点、上传 = 本地源路径），同 path+total 跨身份不互通——
/// 修复「跨主机同路径同大小共享 journal → A 机内容写进 B 机文件」的静默损坏面。
/// 同身份的重试/重启重传天然命中同一 journal → 断点续传。
///
/// 残留收敛策略（C-1d，裁定）：**done 即删**（spawn_transfer 成功分支）为主——
/// journal 只为「未完成、可续传」存在；取消/失败保留供重试续传（合法长尾）；
/// 此处兜底清扫 30 天未动的陈旧 journal（用户放弃的取消/失败残留），best-effort
/// 不阻塞派生。两条路径叠加后 cache 目录自然收敛，无无限增长面。
fn journal_path_for(
    app: &AppHandle,
    mode: &str,
    scope: &str,
    identity_path: &str,
    total: u64,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?
        .join("transfers");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    sweep_stale_journals(&dir);
    Ok(dir.join(format!(
        "{}.journal",
        ottr_transfer::journal_file_name(mode, scope, identity_path, total)
    )))
}

/// 清扫 30 天未动的陈旧 journal（best-effort；单目录少量文件，开销可忽略）。
fn sweep_stale_journals(dir: &Path) {
    const STALE: Duration = Duration::from_secs(30 * 24 * 3600);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let age = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| Duration::from_secs(d.as_secs()));
        if age.is_some_and(|a| a > STALE) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 进度 hook：100ms 时间窗节流（首帧/末帧必发）转 `ottr://transfer-progress`。
/// chunk 粒度回调在本地链路可达每秒数百次，直接 emit 会把 IPC 打满。
fn progress_emitter(app: AppHandle, transfer_id: String) -> ottr_transfer::ProgressHook {
    let last = Arc::new(Mutex::new(None::<(Instant, u64)>));
    Arc::new(move |p: ottr_transfer::TransferProgress| {
        let mut guard = last.lock().unwrap();
        let is_final = p.chunks_done == p.chunks_total;
        let due = match guard.as_ref() {
            None => true, // 首帧必发
            Some((t, _)) => t.elapsed() >= TRANSFER_PROGRESS_INTERVAL,
        };
        let dedupe = matches!(guard.as_ref(), Some((_, b)) if *b == p.transferred);
        if due || is_final {
            if !dedupe {
                let _ = app.emit(
                    "ottr://transfer-progress",
                    TransferProgressPayload {
                        transfer_id: transfer_id.clone(),
                        transferred: p.transferred,
                        total: p.total,
                    },
                );
            }
            *guard = Some((Instant::now(), p.transferred));
        }
    })
}

/// 传输任务统一包装：begin/progress/end 事件 + transfers 表自清。
/// 进度 hook 由调用方在构造 fut 前注入（progress_emitter：100ms 节流）；
/// 取消（Error::Cancelled）与失败（其余 Err）分状态上报，前端状态机据此分派。
#[allow(clippy::too_many_arguments)]
fn spawn_transfer(
    transfers: TransferMap,
    app: AppHandle,
    transfer_id: String,
    kind: &'static str,
    remote_path: String,
    local_path: String,
    total: u64,
    journal_path: PathBuf,
    cancel: ottr_transfer::CancelToken,
    fut: impl std::future::Future<Output = ottr_transfer::Result<ottr_transfer::TransferStats>>
    + Send
    + 'static,
) {
    transfers.lock().unwrap().insert(
        transfer_id.clone(),
        TransferEntry {
            cancel: cancel.clone(),
        },
    );
    tauri::async_runtime::spawn(async move {
        let _ = app.emit(
            "ottr://transfer-begin",
            TransferBeginPayload {
                transfer_id: transfer_id.clone(),
                kind,
                remote_path: remote_path.clone(),
                local_path: local_path.clone(),
                // Fix round 1 M-2：命令面预 stat 的 total 随 begin 下发，
                // 进度条起点即有分母（stat 失败 = 0，由 progress 首帧校正）。
                total,
            },
        );
        let result = fut.await;
        let (status, message): (&'static str, String) = match &result {
            Ok(_) => ("done", String::new()),
            Err(ottr_transfer::Error::Cancelled) => ("cancelled", String::new()),
            Err(e) => ("failed", e.to_string()),
        };
        // Fix round 1 C-1a：**done 即删 journal**——journal 只为「未完成、可续传」
        // 存在；完成后保留会让同身份重传全命中（0 chunk + 稀疏全零文件/远端旧
        // 内容）并报 done，即静默数据损坏。取消/失败保留（续传语义）。
        // NotFound 不记错：本机复制（本地终端会话）不写 journal，文件本就不存在。
        if status == "done"
            && let Err(e) = std::fs::remove_file(&journal_path)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!(
                "[transfer:{transfer_id}] journal cleanup failed ({}): {e}",
                journal_path.display()
            );
        }
        let _ = app.emit(
            "ottr://transfer-end",
            TransferEndPayload {
                transfer_id: transfer_id.clone(),
                status,
                message,
            },
        );
        transfers.lock().unwrap().remove(&transfer_id);
        if let Err(e) = result {
            eprintln!("[transfer:{transfer_id}] {kind} ended: {e}");
        }
    });
}

/// 本地会话的「传输」= 本机文件复制（2026-10-20）：下载/上传在本地终端的
/// 文件面板里都是同一台机器的两个目录之间搬文件。无 journal；分块复制（
/// 1MiB/块）中途查取消令牌——此前 std::fs::copy 一次到底，取消钮只在开始前
/// 检查一次，大文件复制中点取消无效。完成后发一帧满进度让进度条收口。
/// **同文件守卫**：源与目标 canonicalize 相等时拒绝——复制到自身会先截断再
/// 读，等于清空该文件。
async fn local_copy_transfer(
    from: PathBuf,
    to: PathBuf,
    cancel: ottr_transfer::CancelToken,
    hook: ottr_transfer::ProgressHook,
) -> ottr_transfer::Result<ottr_transfer::TransferStats> {
    if cancel.is_cancelled() {
        return Err(ottr_transfer::Error::Cancelled);
    }
    let started = Instant::now();
    let outcome = local_fs(move || -> std::io::Result<Option<u64>> {
        let src = std::fs::canonicalize(&from)?;
        if src.is_dir() {
            return Err(std::io::Error::other(format!(
                "{} is a directory (directory copy walks files one by one)",
                from.display()
            )));
        }
        if let Ok(dst) = std::fs::canonicalize(&to)
            && dst == src
        {
            return Err(std::io::Error::other(format!(
                "source and destination are the same file: {}",
                src.display()
            )));
        }
        let existed = to.exists();
        let mut reader = std::fs::File::open(&src)?;
        let total = reader.metadata()?.len();
        // 分块复制：块间查取消（取消 = 半成品文件删除，不留「看似成功」的
        // 截断文件——目标此前不存在时）。
        const CHUNK: usize = 1024 * 1024;
        let mut writer = std::fs::File::create(&to)?;
        let mut copied: u64 = 0;
        let mut chunk = vec![0u8; CHUNK];
        loop {
            if cancel.is_cancelled() {
                drop(writer);
                if !existed {
                    let _ = std::fs::remove_file(&to);
                }
                return Ok(None);
            }
            let n = std::io::Read::read(&mut reader, &mut chunk)?;
            if n == 0 {
                break;
            }
            writer.write_all(&chunk[..n])?;
            copied += n as u64;
            if copied >= total {
                break;
            }
        }
        writer.flush()?;
        drop(writer);
        if copied < total {
            return Err(std::io::Error::other(format!(
                "copy truncated: {copied}/{total} bytes"
            )));
        }
        Ok(Some(copied))
    });
    let copied = match outcome.await? {
        Some(copied) => copied,
        None => return Err(ottr_transfer::Error::Cancelled),
    };
    hook(ottr_transfer::TransferProgress {
        transferred: copied,
        total: copied,
        chunks_done: 1,
        chunks_total: 1,
    });
    Ok(ottr_transfer::TransferStats {
        total_bytes: copied,
        chunks_total: 1,
        chunks_resumed: 0,
        elapsed: started.elapsed(),
    })
}

/// 下载（远端 → 本地）。`local` 缺省 = 下载目录/远端文件名（MVP 降级裁定：
/// 「拖出到 Finder」不可行，以「下载到下载目录」+ 提示替代）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn sftp_download(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    remote: String,
    local: Option<String>,
) -> Result<TransferStarted, String> {
    // 传输后端分派（Phase 2 Task 5）：SSH 会话 → SshSession（SFTP 并行分块），
    // FTP 会话 → FtpClient（线性 + REST），本地终端会话 → 本机复制。端点为
    // journal scope 身份（跨主机不共享续传；本机复制不写 journal）。
    enum Backend {
        Ssh(Arc<ottr_ssh::SshSession>),
        Ftp(Arc<ottr_transfer::FtpClient>),
        Local,
    }
    let ssh_lookup = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|e| (Arc::clone(&e.session), e.endpoint.clone()));
    let is_local = state.local_sessions.lock().unwrap().contains_key(&id);
    // FTP 传输闸门（robustness 审计 P1）：下载整程持有客户端互斥锁——把闸门
    // 交给传输任务，心跳在此期间跳过探测（否则等锁撞探测限时误杀活会话）。
    let mut ftp_gate = None;
    let (backend, endpoint) = match ssh_lookup {
        Some((session, endpoint)) => (Backend::Ssh(session), endpoint),
        None if is_local => (Backend::Local, "local".to_string()),
        None => {
            let gate = super::ftp::ftp_transfer_gate(&state, &id).await?;
            ftp_gate = Some(Arc::clone(&gate));
            (
                Backend::Ftp(super::ftp::ftp_for(&state, &id).await?),
                super::ftp::ftp_endpoint(&state, &id)?,
            )
        }
    };
    let local = match local {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = local_downloads_dir(app.clone())?;
            let name = remote
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or("download.bin");
            PathBuf::from(dir).join(name)
        }
    };
    // 预 stat 总长（begin 载荷 + journal 身份）；失败不阻塞——传输内部会再 stat
    // 并以同一错误失败，保持单一错误路径。
    let total = file_client_for(&state, &id)
        .await?
        .stat(&remote)
        .await
        .map(|d| d.size)
        .unwrap_or(0);
    // Fix round 1 C-1b：scope = host 端点——同路径同大小跨主机不共享 journal。
    let journal = journal_path_for(&app, "down", &endpoint, &remote, total)?;
    let transfer_id = format!("xfer-{}", TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed));
    let cancel = ottr_transfer::CancelToken::new();
    let local_str = local.to_string_lossy().into_owned();
    let started = TransferStarted {
        transfer_id: transfer_id.clone(),
        local_path: local_str.clone(),
        remote_path: remote.clone(),
        total,
    };
    use ottr_transfer::FileTransfer;
    let hook = progress_emitter(app.clone(), transfer_id.clone());
    let (remote_fut, local_fut, cancel_fut, journal_fut) = (
        remote.clone(),
        local.clone(),
        cancel.clone(),
        journal.clone(),
    );
    let fut = async move {
        match &backend {
            Backend::Ssh(session) => {
                session
                    .download(
                        &remote_fut,
                        &local_fut,
                        SFTP_CHUNKS,
                        &journal_fut,
                        &cancel_fut,
                        Some(hook),
                    )
                    .await
            }
            Backend::Ftp(client) => {
                // 整传输持闸门（拿不到 = 传输在途 → 心跳跳过探测，见
                // FtpSessionEntry.transfer_gate 文档）。
                let _gate = match ftp_gate.as_ref() {
                    Some(gate) => Some(gate.lock().await),
                    None => None,
                };
                client
                    .download(
                        &remote_fut,
                        &local_fut,
                        SFTP_CHUNKS,
                        &journal_fut,
                        &cancel_fut,
                        Some(hook),
                    )
                    .await
            }
            Backend::Local => {
                local_copy_transfer(PathBuf::from(remote_fut), local_fut, cancel_fut, hook).await
            }
        }
    };
    spawn_transfer(
        state.transfers.clone(),
        app,
        transfer_id,
        "download",
        remote,
        local_str,
        total,
        journal,
        cancel,
        fut,
    );
    Ok(started)
}

/// 上传（本地 → 远端目录）。`remote_dir` 缺省 = 远端当前目录由前端传；
/// 目标名 = 本地文件名（重名覆盖——SFTP CREATE|TRUNCATE 语义，UI 不做冲突
/// 对话框，MVP 记录为已知取舍）。
#[tauri::command]
pub(crate) async fn sftp_upload(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    local: String,
    remote_dir: String,
) -> Result<TransferStarted, String> {
    // 传输后端分派（与 sftp_download 同款）：SSH → SshSession，FTP → FtpClient，
    // 本地终端 → 本机复制。
    enum Backend {
        Ssh(Arc<ottr_ssh::SshSession>),
        Ftp(Arc<ottr_transfer::FtpClient>),
        Local,
    }
    let ssh_lookup = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|e| Arc::clone(&e.session));
    let is_local = state.local_sessions.lock().unwrap().contains_key(&id);
    // FTP 传输闸门（sftp_download 同款：上传整程持客户端互斥锁，心跳跳过探测）
    let mut ftp_gate = None;
    let backend = match ssh_lookup {
        Some(session) => Backend::Ssh(session),
        None if is_local => Backend::Local,
        None => {
            let gate = super::ftp::ftp_transfer_gate(&state, &id).await?;
            ftp_gate = Some(Arc::clone(&gate));
            Backend::Ftp(super::ftp::ftp_for(&state, &id).await?)
        }
    };
    let local_path = PathBuf::from(&local);
    let total = std::fs::metadata(&local_path)
        .map_err(|e| format!("stat {local}: {e}"))?
        .len();
    let name = local_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("not a file: {local}"))?;
    let trimmed = remote_dir.trim_end_matches('/');
    let remote = if trimmed.is_empty() {
        format!("/{name}")
    } else {
        format!("{trimmed}/{name}")
    };
    // Fix round 1 C-1b：scope = 本地源路径——同一远端目标从不同本地源上传
    // 各用各的 journal（换源即换身份，绝不按旧源 offset 跳过）。
    let journal = journal_path_for(&app, "up", &local, &remote, total)?;
    let transfer_id = format!("xfer-{}", TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed));
    let cancel = ottr_transfer::CancelToken::new();
    let started = TransferStarted {
        transfer_id: transfer_id.clone(),
        local_path: local.clone(),
        remote_path: remote.clone(),
        total,
    };
    use ottr_transfer::FileTransfer;
    let hook = progress_emitter(app.clone(), transfer_id.clone());
    let (remote_fut, local_fut, cancel_fut, journal_fut) = (
        remote.clone(),
        local_path.clone(),
        cancel.clone(),
        journal.clone(),
    );
    let fut = async move {
        match &backend {
            Backend::Ssh(session) => {
                session
                    .upload(
                        &local_fut,
                        &remote_fut,
                        SFTP_CHUNKS,
                        &journal_fut,
                        &cancel_fut,
                        Some(hook),
                    )
                    .await
            }
            Backend::Ftp(client) => {
                // 整传输持闸门（sftp_download 同款，见 FtpSessionEntry 文档）。
                let _gate = match ftp_gate.as_ref() {
                    Some(gate) => Some(gate.lock().await),
                    None => None,
                };
                client
                    .upload(
                        &local_fut,
                        &remote_fut,
                        SFTP_CHUNKS,
                        &journal_fut,
                        &cancel_fut,
                        Some(hook),
                    )
                    .await
            }
            Backend::Local => {
                local_copy_transfer(local_fut, PathBuf::from(remote_fut), cancel_fut, hook).await
            }
        }
    };
    spawn_transfer(
        state.transfers.clone(),
        app,
        transfer_id,
        "upload",
        remote,
        local,
        total,
        journal,
        cancel,
        fut,
    );
    Ok(started)
}

/// 取消在途传输（chunk 边界协作退出；journal 保留——重试即续传）。
#[tauri::command]
pub(crate) fn transfer_cancel(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<(), String> {
    let cancel = {
        let transfers = state.transfers.lock().unwrap();
        transfers
            .get(&transfer_id)
            .ok_or_else(|| format!("no such transfer: {transfer_id}"))?
            .cancel
            .clone()
    };
    cancel.cancel();
    Ok(())
}

// ---------------------------------------------------------------------------
// SFTP 槽位失效判据单测（robustness 审计 P2 回归）：判据按 russh-sftp 3.0.1
// client::error::Error 的 Display 形态分层（见 sftp_slot_wedged_text 文档）。
// desktop 不引 russh-sftp 类型（I-1 依赖纪律），测试用 Display 等价的桩错误
// 类型钉住判据行为：服务器正常应答不清槽，通道/协议级一律清槽（自愈）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod sftp_slot_criterion_tests {
    use super::{sftp_slot_wedged, sftp_slot_wedged_text};

    /// Display 等价桩：模拟被擦除进 source 的 russh-sftp 错误 Display 文本。
    #[derive(Debug)]
    struct FakeSftpError(&'static str);

    impl std::fmt::Display for FakeSftpError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for FakeSftpError {}

    fn protocol_with(source_display: &'static str) -> ottr_transfer::Error {
        ottr_transfer::Error::Protocol {
            message: format!("stat /x: {source_display}"),
            source: Some(Box::new(FakeSftpError(source_display))),
        }
    }

    #[test]
    fn server_status_responses_keep_slot() {
        // 服务器正常应答（StatusCode 2xx 语义 + limits 扩展）：通道健康，清了
        // 白白重开。Status Display = "{StatusCode}: {error_message}"。
        for status in [
            "No such file: /a/b does not exist",
            "Permission denied: permission denied",
            "Failure: failure",
            "Eof: eof",
            "Operation unsupported: operation unsupported",
            "Ok: ok",
            "Limit exceeded: write request exceeds max packet size",
        ] {
            assert!(
                !sftp_slot_wedged(&protocol_with(status)),
                "服务器应答 {status:?} 不得清槽"
            );
            assert!(!sftp_slot_wedged_text(status));
        }
    }

    #[test]
    fn transport_level_errors_clear_slot() {
        // 通道/协议级：子系统任务死（RecvError/SendError）、应答超时、协议
        // 失配、本地伪 Status、流断——下次调用必须重开 subsystem 自愈。
        for transport in [
            "I/O: channel closed",
            "Timeout",
            "Unexpected packet",
            "Bad message: short packet",
            "No connection: generated locally",
            "Connection lost: generated locally",
            "RecvError: receiving on an empty channel",
            "SendError: channel closed",
            "Unexpected EOF on stream",
            "Client error. (unexpected packet)",
            // 未知形态也清（缺省自愈——宁可多开一次，不永久 wedged）
            "something entirely unknown",
        ] {
            assert!(
                sftp_slot_wedged(&protocol_with(transport)),
                "通道/协议级 {transport:?} 必须清槽"
            );
            assert!(sftp_slot_wedged_text(transport));
        }
    }

    #[test]
    fn transport_markers_win_over_status_markers() {
        // 判据顺序：传输级特征优先——服务器错误消息里含路径（如
        // "No such file: /Timeout …"）不得把真超时误判成健康。
        assert!(sftp_slot_wedged_text("stat /x: Timeout"));
        assert!(sftp_slot_wedged_text(
            "mlst /No such file dir: I/O: stream closed"
        ));
    }

    #[test]
    fn non_protocol_errors_keep_slot() {
        // source 缺失（应用层错误）、本地 IO、取消：与 SFTP 通道健康无关。
        let plain = ottr_transfer::Error::Protocol {
            message: "journal identity mismatch".into(),
            source: None,
        };
        assert!(!sftp_slot_wedged(&plain));
        assert!(!sftp_slot_wedged(&ottr_transfer::Error::Io(
            std::io::Error::other("disk full")
        )));
        assert!(!sftp_slot_wedged(&ottr_transfer::Error::Cancelled));
    }
}

// ---------------------------------------------------------------------------
// 本地栏写操作单测（feat/file-panel-enhancements）：*_sync 纯 std::fs 核心，
// tempdir 隔离，不依赖 tauri 运行时。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod local_write_tests {
    use super::{local_copy_sync, local_mkdir_sync, local_remove_sync};

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ottr-local-write-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn mkdir_creates_dir_and_rejects_duplicate() {
        let tmp = TempDir::new("mkdir");
        let dir = tmp.0.join("新建文件夹");
        local_mkdir_sync(dir.to_str().unwrap()).unwrap();
        assert!(dir.is_dir());
        // 已存在显式报错（不静默幂等——避免用户以为建到了别处）
        let err = local_mkdir_sync(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn remove_file_and_dir_recursively() {
        let tmp = TempDir::new("remove");
        let file = tmp.0.join("a.log");
        std::fs::write(&file, b"x").unwrap();
        local_remove_sync(file.to_str().unwrap(), false).unwrap();
        assert!(!file.exists());
        let nested = tmp.0.join("dir/nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("b.bin"), b"y").unwrap();
        local_remove_sync(tmp.0.join("dir").to_str().unwrap(), true).unwrap();
        assert!(!tmp.0.join("dir").exists());
    }

    #[test]
    fn remove_refuses_root_and_empty_paths() {
        assert!(local_remove_sync("", false).is_err());
        assert!(local_remove_sync("/", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remove_refuses_symlink_target_outside() {
        // 删除入口拿到符号链接时按链接本身处理：is_dir=false 走 remove_file，
        // 绝不追出目标目录——软链指向外部文件时只断链、不伤原文件。
        let tmp = TempDir::new("symlink");
        let outside = TempDir::new("symlink-out");
        let target = outside.0.join("precious.txt");
        std::fs::write(&target, b"keep").unwrap();
        let link = tmp.0.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        local_remove_sync(link.to_str().unwrap(), false).unwrap();
        assert!(!link.exists());
        assert!(target.exists(), "软链删除不得波及目标文件");
    }

    #[test]
    fn copy_keeps_name_and_overwrites() {
        let tmp = TempDir::new("copy");
        let src_dir = tmp.0.join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("pkg.deb");
        std::fs::write(&src, b"v1").unwrap();
        let dest_dir = tmp.0.join("dest");
        std::fs::create_dir_all(&dest_dir).unwrap();
        local_copy_sync(src.to_str().unwrap(), dest_dir.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(dest_dir.join("pkg.deb")).unwrap(), b"v1");
        // 重名覆盖口径与上传一致
        std::fs::write(&src, b"v2-longer").unwrap();
        local_copy_sync(src.to_str().unwrap(), dest_dir.to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read(dest_dir.join("pkg.deb")).unwrap(),
            b"v2-longer"
        );
    }
}

/// 本地会话远端栏（FileClient::Local）的同步核单测：stat/list 往返、chmod
/// unix 权限位。async 壳（local_fs）不在此测——tauri 异步运行时不在单测面。
#[cfg(test)]
mod local_file_client_tests {
    use super::{local_chmod_sync, local_list_dir_sync, local_stat_sync};

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ottr-local-fc-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stat_and_list_roundtrip_dirs_first() {
        let tmp = TempDir::new("roundtrip");
        let sub = tmp.0.join("子目录");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(tmp.0.join("a.txt"), b"12345").unwrap();

        let st = local_stat_sync(sub.to_str().unwrap()).unwrap();
        assert_eq!(st.name, "子目录");
        assert!(st.is_dir);

        let rows = local_list_dir_sync(tmp.0.to_str().unwrap()).unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["子目录", "a.txt"], "目录在前，其余按名排序");
        let file = rows.iter().find(|r| r.name == "a.txt").unwrap();
        assert!(!file.is_dir);
        assert_eq!(file.size, 5);
    }

    #[cfg(unix)]
    #[test]
    fn chmod_sets_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("chmod");
        let f = tmp.0.join("script.sh");
        std::fs::write(&f, b"#!/bin/sh\n").unwrap();
        local_chmod_sync(f.to_str().unwrap(), 0o755).unwrap();
        let mode = std::fs::metadata(&f).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }
}
