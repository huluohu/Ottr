//! 传输命令域（Task 0 拆分，纯搬家）：SFTP 文件面板命令面 + 本地栏 + 传输队列
//! （journal 派生/清扫、进度节流、begin/progress/end 事件、取消）。
//! SFTP 通道复用既有会话（SessionEntry 持 Arc<SshSession>，见 sftp_for）。
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use super::state::{
    AppState, TransferEntry, TransferMap, SFTP_CHUNKS, TRANSFER_PROGRESS_INTERVAL, TRANSFER_SEQ,
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
async fn sftp_for(state: &AppState, id: &str) -> Result<Arc<ottr_transfer::SftpClient>, String> {
    let (session, cached) = {
        let sessions = state.sessions.lock().unwrap();
        let e = sessions
            .get(id)
            .ok_or_else(|| format!("no such session: {id}"))?;
        let session = Arc::clone(&e.session);
        let cached = e.sftp.lock().unwrap().as_ref().map(Arc::clone);
        (session, cached)
    };
    if let Some(c) = cached {
        return Ok(c);
    }
    let client = Arc::new(
        ottr_transfer::SftpClient::open(&session)
            .await
            .map_err(|e| e.to_string())?,
    );
    // 竞态兜底：两路并发懒开时后到者采用先到者的实例（同会话单客户端）。
    let sessions = state.sessions.lock().unwrap();
    let slot = sessions
        .get(id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    let mut guard = slot.sftp.lock().unwrap();
    if let Some(c) = guard.as_ref() {
        return Ok(Arc::clone(c));
    }
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

#[tauri::command]
pub(crate) async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<ottr_transfer::DirEntry>, String> {
    let client = sftp_for(&state, &id).await?;
    client.list_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn sftp_realpath(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let client = sftp_for(&state, &id).await?;
    client.realpath(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn sftp_mkdir(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let client = sftp_for(&state, &id).await?;
    client.mkdir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let client = sftp_for(&state, &id).await?;
    client.rename(&from, &to).await.map_err(|e| e.to_string())
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
    let client = sftp_for(&state, &id).await?;
    let r = if is_dir {
        client.remove_dir(&path).await
    } else {
        client.remove_file(&path).await
    };
    r.map_err(|e| e.to_string())
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
    let client = sftp_for(&state, &id).await?;
    client.chmod(&path, mode).await.map_err(|e| e.to_string())
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
        if status == "done" {
            if let Err(e) = std::fs::remove_file(&journal_path) {
                eprintln!(
                    "[transfer:{transfer_id}] journal cleanup failed ({}): {e}",
                    journal_path.display()
                );
            }
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
    let (session, endpoint) = {
        let sessions = state.sessions.lock().unwrap();
        let e = sessions
            .get(&id)
            .ok_or_else(|| format!("no such session: {id}"))?;
        (Arc::clone(&e.session), e.endpoint.clone())
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
    let total = sftp_for(&state, &id)
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
        session
            .download_parallel(
                &remote_fut,
                &local_fut,
                SFTP_CHUNKS,
                &journal_fut,
                &cancel_fut,
                Some(hook),
            )
            .await
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
    let session = {
        let sessions = state.sessions.lock().unwrap();
        Arc::clone(
            &sessions
                .get(&id)
                .ok_or_else(|| format!("no such session: {id}"))?
                .session,
        )
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
        session
            .upload_parallel(
                &local_fut,
                &remote_fut,
                SFTP_CHUNKS,
                &journal_fut,
                &cancel_fut,
                Some(hook),
            )
            .await
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
