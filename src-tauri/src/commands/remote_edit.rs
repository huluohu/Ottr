//! 远端文件本地编辑域（Phase 2 Task 3，B10 上半）：右键「编辑」的完整 Rust 侧
//! 生命周期——下载到 OS 临时目录 → 前端起系统编辑器 → 前端轮询驱动保存 →
//! 冲突检测/覆盖 → 清理（显式关闭 / 会话消失 / App 退出 / 24h 惰性清扫）。
//!
//! ## 状态管理（简报裁定：Rust 侧单表持有）
//!
//! [`EditMap`]：session id → (远端路径 → [`EditEntry`])，挂在 AppState 随应用
//! 生命周期。每条目持三份状态：
//! * `temp_path`：OS 临时目录下的本地副本（`$TMPDIR/ottr-edit/<sid>/<dirhash>/<name>`，
//!   保留扩展名——编辑器语法高亮依赖它；dirhash 隔离同目录同名歧义）；
//! * `snapshot`：下载时的远端 [`RemoteSnapshot`]（size+mtime）——回传前 stat
//!   比对，不一致即冲突（第三方改写），UI 提示覆盖；
//! * `saved_local`/`pending`：本地副本的 mtime+size 指纹。轮询防抖：**连续两次
//!   观察一致**才触发保存（编辑器写盘是多次 rename/截写的，单次观察即保存会
//!   读到半截内容）。
//!
//! ## 冲突语义
//!
//! * 轮询发现本地有改且远端与快照一致 → 静默自动回传，快照更新为**写后 stat**
//!   （绝不沿用旧快照，否则下次回传必自冲突）；
//! * 远端与快照不一致 → 返回 `conflict` 不回传，前端弹「远端已变更，覆盖？」；
//!   覆盖 = `remote_edit_save(force=true)`；保留本地 = `remote_edit_dismiss`
//!   （把当前本地状态记作已处理，下次本地再改动才重新武装）——否则轮询每 2s
//!   重复弹窗；
//! * 已知粒度边界：SFTP mtime 秒级，同秒内同 size 的第三方改写侦不出（协议
//!   固有，ottr-transfer RemoteSnapshot 文档同记）。
//!
//! ## 清理时机
//!
//! 显式关闭（`remote_edit_close`）/ 本地副本被删（轮询发现即自清）/ 会话消失
//! （poll 拿不到 SFTP 即整会话自清——重连换 rustId 后旧会话天然不可达）/
//! App 退出（lib.rs RunEvent::Exit → [`close_all_edits`]）/ 24h 惰性清扫
//! （open 时 best-effort，漏网残留兜底）。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ottr_transfer::ops::RemoteSnapshot;
use ottr_transfer::SftpClient;

use super::state::AppState;

// ---------------------------------------------------------------------------
// 状态与纯函数（单测面，无 SFTP / 无 Tauri 依赖）
// ---------------------------------------------------------------------------

/// 编辑会话表：session id → (远端路径 → 条目)。
pub type EditMap = Arc<Mutex<HashMap<String, HashMap<String, EditEntry>>>>;

/// 本地副本指纹（mtime 纳秒 + size）：mtime 用纳秒——秒级指纹会把「同一秒内
/// 的两次保存」误判为未变化；ns 指纹在 macOS/Linux 文件系统上都可得。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalStamp {
    pub mtime_ns: u64,
    pub size: u64,
}

impl LocalStamp {
    fn of(meta: &std::fs::Metadata) -> Self {
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        Self {
            mtime_ns,
            size: meta.len(),
        }
    }
}

/// 一条远端编辑会话（字段语义见模块注释）。
#[derive(Debug, Clone)]
pub struct EditEntry {
    pub(crate) temp_path: PathBuf,
    pub(crate) snapshot: RemoteSnapshot,
    pub(crate) saved_local: LocalStamp,
    pub(crate) pending: Option<LocalStamp>,
}

/// 轮询的本地侧判定（纯状态机；SFTP 动作由调用方按 `Ready` 执行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalDecision {
    /// 本地未变（或回到已保存状态）：清除 pending，无事发生。
    Unchanged,
    /// 本地有变但首次观察：记录 pending，等下一轮确认稳定（防抖）。
    Debounce,
    /// 本地有变且连续两次观察一致：可执行「冲突检查 + 回传」。
    Ready,
    /// 本地副本已消失（用户/编辑器删了临时件）：整条编辑会话应自清。
    TempGone,
}

/// 纯判定：`cur` = 当前本地指纹（None = 临时件没了）。返回判定与新的 pending。
pub fn poll_decision(
    saved_local: &LocalStamp,
    pending: &Option<LocalStamp>,
    cur: Option<LocalStamp>,
) -> (LocalDecision, Option<LocalStamp>) {
    match cur {
        None => (LocalDecision::TempGone, None),
        Some(cur) if cur == *saved_local => (LocalDecision::Unchanged, None),
        Some(cur) => match pending {
            Some(p) if *p == cur => (LocalDecision::Ready, Some(cur)),
            _ => (LocalDecision::Debounce, Some(cur)),
        },
    }
}

/// session id 的文件名消毒：只留字母数字与 `-_.`，其余折叠为 `_`（rustId 是
/// 自产格式 `pty-N`，消毒只是纵深防御——id 来自前端 invoke）。
pub fn sanitize_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    if s.is_empty() { "_".into() } else { s }
}

/// 编辑临时根：`$TMPDIR/ottr-edit`。
pub fn temp_root() -> PathBuf {
    std::env::temp_dir().join("ottr-edit")
}

/// 临时副本路径：`<root>/<sid>/<sha256(远端目录)前10hex>/<文件名>`。
/// 扩展名保留（编辑器高亮）；目录哈希隔离「不同远端目录同名文件」；
/// 同一远端路径派生稳定路径（重复 open 命中同一份本地副本）。
pub fn temp_path_for(id: &str, remote: &str) -> PathBuf {
    let name = remote.rsplit('/').next().unwrap_or(remote);
    let trimmed = remote.trim_end_matches('/');
    let dir = match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
        None => String::new(),
    };
    let dirhash = {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(dir.as_bytes());
        digest[..5].iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    temp_root()
        .join(sanitize_id(id))
        .join(dirhash)
        .join(name)
}

fn local_stamp(path: &Path) -> Option<LocalStamp> {
    std::fs::metadata(path).ok().map(|m| LocalStamp::of(&m))
}

// ---------------------------------------------------------------------------
// 生命周期核（消费方：下方 tauri 命令薄包装 + tests/remote_edit_fixture.rs）
// ---------------------------------------------------------------------------

/// 打开编辑会话：stat 快照 → 单通道下载 → 落临时副本 → 登记会话表。
/// **不起系统编辑器**（那是命令包装层的事，测试面不 spawn 真编辑器）。
/// 重复 open 同一远端文件：命中既有会话原样返回（保留未回传的本地修改；
/// 远端若已被第三方改，回传前快照检测兜底）。
pub async fn edit_open(
    edits: &EditMap,
    client: &SftpClient,
    id: &str,
    remote: &str,
) -> Result<PathBuf, String> {
    sweep_stale_edits(&temp_root(), Duration::from_secs(24 * 3600), SystemTime::now());
    if let Some(e) = edits.lock().unwrap().get(id).and_then(|m| m.get(remote)) {
        return Ok(e.temp_path.clone());
    }
    let stat = client.stat(remote).await.map_err(|e| e.to_string())?;
    let data = client.open_remote_text(remote).await.map_err(|e| e.to_string())?;
    let temp_path = temp_path_for(id, remote);
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all {parent:?}: {e}"))?;
    }
    std::fs::write(&temp_path, &data).map_err(|e| format!("write temp {temp_path:?}: {e}"))?;
    let saved_local = local_stamp(&temp_path)
        .ok_or_else(|| format!("temp file vanished right after write: {temp_path:?}"))?;
    edits.lock().unwrap().entry(id.to_string()).or_default().insert(
        remote.to_string(),
        EditEntry {
            temp_path: temp_path.clone(),
            snapshot: RemoteSnapshot::capture(&stat),
            saved_local,
            pending: None,
        },
    );
    Ok(temp_path)
}

/// 轮询一步（前端 2s 一次）：本地防抖判定 → Ready 时「远端快照比对 → 一致
/// 静默回传（快照更新为写后 stat）/ 不一致返回 conflict（不回传，等 UI 裁定）」。
/// 本地副本消失 → 自清并返回 gone。
pub async fn edit_poll(
    edits: &EditMap,
    client: &SftpClient,
    id: &str,
    remote: &str,
) -> Result<EditPollStatus, String> {
    let entry = {
        let map = edits.lock().unwrap();
        match map.get(id).and_then(|m| m.get(remote)) {
            Some(e) => e.clone(),
            None => return Ok(EditPollStatus::GONE),
        }
    };
    let (decision, new_pending) = poll_decision(&entry.saved_local, &entry.pending, local_stamp(&entry.temp_path));
    match decision {
        LocalDecision::TempGone => {
            edit_close(edits, id, remote);
            Ok(EditPollStatus::GONE)
        }
        LocalDecision::Unchanged => Ok(EditPollStatus::QUIET),
        LocalDecision::Debounce => {
            store_pending(edits, id, remote, new_pending);
            Ok(EditPollStatus::QUIET)
        }
        LocalDecision::Ready => {
            // 锁不跨 await：快照比对用克隆态，回传成功后才回写表（前端对同一
            // 文件串行轮询，竞态窗口无害；即便交错，回写值等价）。
            let stat = client.stat(remote).await.map_err(|e| e.to_string())?;
            if entry.snapshot.conflicts_with(&stat) {
                store_pending(edits, id, remote, new_pending);
                return Ok(EditPollStatus::CONFLICT);
            }
            do_save(edits, client, id, remote).await
        }
    }
}

/// 显式保存（冲突对话框「覆盖」路径，force=true 跳过快照比对；force=false
/// 供非冲突兜底调用，冲突时返回 conflict 不写）。
pub async fn edit_save(
    edits: &EditMap,
    client: &SftpClient,
    id: &str,
    remote: &str,
    force: bool,
) -> Result<EditPollStatus, String> {
    let entry = {
        let map = edits.lock().unwrap();
        map.get(id)
            .and_then(|m| m.get(remote))
            .cloned()
            .ok_or_else(|| format!("no such edit session: {id} {remote}"))?
    };
    if !force {
        let stat = client.stat(remote).await.map_err(|e| e.to_string())?;
        if entry.snapshot.conflicts_with(&stat) {
            return Ok(EditPollStatus::CONFLICT);
        }
    }
    do_save(edits, client, id, remote).await
}

/// 共享回传尾：读本地副本 → 单通道覆盖写 → 快照更新为写后 stat、指纹记账。
async fn do_save(
    edits: &EditMap,
    client: &SftpClient,
    id: &str,
    remote: &str,
) -> Result<EditPollStatus, String> {
    let temp_path = {
        let map = edits.lock().unwrap();
        map.get(id)
            .and_then(|m| m.get(remote))
            .map(|e| e.temp_path.clone())
            .ok_or_else(|| format!("no such edit session: {id} {remote}"))?
    };
    let data = std::fs::read(&temp_path).map_err(|e| format!("read temp {temp_path:?}: {e}"))?;
    let after = client
        .write_remote_text(remote, &data)
        .await
        .map_err(|e| e.to_string())?;
    let saved_local = local_stamp(&temp_path)
        .ok_or_else(|| format!("temp file vanished before save bookkeeping: {temp_path:?}"))?;
    {
        let mut map = edits.lock().unwrap();
        if let Some(e) = map.get_mut(id).and_then(|m| m.get_mut(remote)) {
            e.snapshot = RemoteSnapshot::capture(&after);
            e.saved_local = saved_local;
            e.pending = None;
        }
    }
    Ok(EditPollStatus::SAVED)
}

fn store_pending(edits: &EditMap, id: &str, remote: &str, pending: Option<LocalStamp>) {
    if let Some(e) = edits.lock().unwrap().get_mut(id).and_then(|m| m.get_mut(remote)) {
        e.pending = pending;
    }
}

/// 冲突「保留本地」裁定：把当前本地指纹记作已处理（下次本地再改动才重新
/// 武装）——否则轮询每 2s 重弹同一冲突。
pub fn edit_dismiss(edits: &EditMap, id: &str, remote: &str) -> Result<(), String> {
    let mut map = edits.lock().unwrap();
    let entry = map
        .get_mut(id)
        .and_then(|m| m.get_mut(remote))
        .ok_or_else(|| format!("no such edit session: {id} {remote}"))?;
    entry.saved_local = local_stamp(&entry.temp_path)
        .ok_or_else(|| format!("temp file gone: {:?}", entry.temp_path))?;
    entry.pending = None;
    Ok(())
}

/// 显式关闭：删临时副本 + 摘表 + 顺手清空了的哈希/会话目录（只清 temp_root
/// 内的路径，越界路径只删文件不动目录）。返回是否摘到了条目。
pub fn edit_close(edits: &EditMap, id: &str, remote: &str) -> bool {
    let entry = edits
        .lock()
        .unwrap()
        .get_mut(id)
        .and_then(|m| m.remove(remote));
    let Some(entry) = entry else {
        return false;
    };
    let _ = std::fs::remove_file(&entry.temp_path);
    cleanup_empty_dirs(&entry.temp_path);
    true
}

/// 会话级清理（会话消失 / App 退出路径的单元）：删该会话全部临时副本并摘表。
pub fn edit_close_session(edits: &EditMap, id: &str) -> usize {
    let dir_entries = edits.lock().unwrap().remove(id);
    let Some(map) = dir_entries else {
        return 0;
    };
    let n = map.len();
    for (_, entry) in map {
        let _ = std::fs::remove_file(&entry.temp_path);
        cleanup_empty_dirs(&entry.temp_path);
    }
    n
}

/// 全量清理（App 退出，lib.rs RunEvent::Exit 挂点）。
pub fn close_all_edits(edits: &EditMap) -> usize {
    let ids: Vec<String> = edits.lock().unwrap().keys().cloned().collect();
    ids.iter().map(|id| edit_close_session(edits, id)).sum()
}

/// 从临时文件路径向上清空了的哈希/会话目录（严格限 temp_root 内）。
fn cleanup_empty_dirs(temp_path: &Path) {
    let root = temp_root();
    let mut dir = temp_path.parent();
    while let Some(d) = dir {
        if !d.starts_with(&root) || d == root {
            break;
        }
        if std::fs::remove_dir(d).is_err() {
            break; // 非空/已消失：停止上爬
        }
        dir = d.parent();
    }
}

/// 24h 惰性清扫：temp_root 下 mtime 早于 max_age 的会话目录整树删除
/// （best-effort，返回删除数；挂账路径——正常关闭已即时清，这里只兜漏网）。
pub fn sweep_stale_edits(root: &Path, max_age: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if stale && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// tauri 命令面（薄包装：State 提取 + sftp_for；核心逻辑全在上方可测函数）
// ---------------------------------------------------------------------------

/// 轮询/保存结果（serde 直出前端）。`gone` = 编辑会话已不存在（前端停轮询）。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct EditPollStatus {
    pub status: &'static str,
}

impl EditPollStatus {
    pub const QUIET: EditPollStatus = EditPollStatus { status: "quiet" };
    pub const SAVED: EditPollStatus = EditPollStatus { status: "saved" };
    pub const CONFLICT: EditPollStatus = EditPollStatus { status: "conflict" };
    pub const GONE: EditPollStatus = EditPollStatus { status: "gone" };
}

#[derive(serde::Serialize)]
pub struct EditOpened {
    pub local_path: String,
}

#[tauri::command]
pub(crate) async fn remote_edit_open(
    state: tauri::State<'_, AppState>,
    id: String,
    remote: String,
) -> Result<EditOpened, String> {
    let client = super::transfer::sftp_for(&state, &id).await?;
    let temp_path = edit_open(&state.edits, &client, &id, &remote).await?;
    open_in_editor(&temp_path)?;
    Ok(EditOpened {
        local_path: temp_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) async fn remote_edit_poll(
    state: tauri::State<'_, AppState>,
    id: String,
    remote: String,
) -> Result<EditPollStatus, String> {
    // 会话拿不到（断连/重连换 id）：整会话自清 + gone（前端停轮询）。
    let client = match super::transfer::sftp_for(&state, &id).await {
        Ok(c) => c,
        Err(_) => {
            edit_close_session(&state.edits, &id);
            return Ok(EditPollStatus::GONE);
        }
    };
    edit_poll(&state.edits, &client, &id, &remote).await
}

#[tauri::command]
pub(crate) async fn remote_edit_save(
    state: tauri::State<'_, AppState>,
    id: String,
    remote: String,
    force: bool,
) -> Result<EditPollStatus, String> {
    let client = super::transfer::sftp_for(&state, &id).await?;
    edit_save(&state.edits, &client, &id, &remote, force).await
}

#[tauri::command]
pub(crate) fn remote_edit_dismiss(
    state: tauri::State<'_, AppState>,
    id: String,
    remote: String,
) -> Result<(), String> {
    edit_dismiss(&state.edits, &id, &remote)
}

#[tauri::command]
pub(crate) fn remote_edit_close(
    state: tauri::State<'_, AppState>,
    id: String,
    remote: String,
) -> Result<bool, String> {
    Ok(edit_close(&state.edits, &id, &remote))
}

/// 起系统默认编辑器（不等退出——编辑器是常驻进程，等了会挂死命令）。
/// macOS `open` / Linux `xdg-open` / Windows `cmd /C start`。
fn open_in_editor(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c.arg(path);
        c
    };
    cmd.spawn().map_err(|e| format!("spawn editor for {path:?}: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 单测（临时目录；无 SFTP / 无 Tauri——夹具端到端在 tests/remote_edit_fixture.rs）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// temp_path_for 契约：消毒、扩展名保留、目录哈希隔离、同路径稳定派生。
    #[test]
    fn temp_path_layout() {
        let root = temp_root();
        let a = temp_path_for("pty-0", "/home/spike/notes.txt");
        assert_eq!(
            a,
            root.join("pty-0").join(a.parent().unwrap().file_name().unwrap()).join("notes.txt"),
            "extension must survive for editor syntax highlighting"
        );
        assert_eq!(temp_path_for("pty-0", "/home/spike/notes.txt"), a, "stable derivation");

        // 同名不同目录：哈希段不同（不得共享临时件）
        let b = temp_path_for("pty-0", "/var/www/notes.txt");
        assert_ne!(a.parent(), b.parent());

        // 同目录同路径不同会话：哈希段相同（同远端目录）、会话段不同
        let c = temp_path_for("pty-1", "/home/spike/notes.txt");
        assert_ne!(a, c);
        assert_eq!(
            a.parent().unwrap().file_name(),
            c.parent().unwrap().file_name(),
            "same remote dir must derive the same dirhash segment"
        );
        assert_ne!(
            a.parent().unwrap().parent(),
            c.parent().unwrap().parent(),
            "session segment must differ per session id"
        );

        // 恶意 id 消毒：路径分隔符折叠为 _，不逃出 ottr-edit
        let evil = temp_path_for("../../etc", "/x/f.txt");
        let evil_s = evil.to_string_lossy();
        assert!(!evil_s.contains("../"), "sanitized id must not traverse: {evil_s}");
        assert!(evil.starts_with(&root));

        // 根路径与无斜杠路径不 panic
        let _ = temp_path_for("pty-0", "/");
        let _ = temp_path_for("pty-0", "file.txt");
    }

    /// 轮询防抖状态机（TDD 核心）：未变 / 首见防抖 / 稳定就绪 / 临时件消失。
    #[test]
    fn poll_decision_state_machine() {
        let saved = LocalStamp { mtime_ns: 100, size: 5 };
        // 未变：Unchanged 且清 pending
        let cur = saved.clone();
        assert_eq!(
            poll_decision(&saved, &None, Some(cur.clone())),
            (LocalDecision::Unchanged, None)
        );
        // 首见变化：Debounce + 记 pending
        let v2 = LocalStamp { mtime_ns: 200, size: 6 };
        assert_eq!(
            poll_decision(&saved, &None, Some(v2.clone())),
            (LocalDecision::Debounce, Some(v2.clone()))
        );
        // 编辑器写盘中（mtime 抖动）：重置回 Debounce，绝不保存半截内容
        let v3 = LocalStamp { mtime_ns: 300, size: 9 };
        assert_eq!(
            poll_decision(&saved, &Some(v2.clone()), Some(v3.clone())),
            (LocalDecision::Debounce, Some(v3.clone()))
        );
        // 稳定（连续两轮一致）：Ready
        assert_eq!(
            poll_decision(&saved, &Some(v3.clone()), Some(v3.clone())),
            (LocalDecision::Ready, Some(v3))
        );
        // 临时件消失：TempGone（自清信号）
        assert_eq!(poll_decision(&saved, &None, None), (LocalDecision::TempGone, None));
    }

    /// edit_close：删临时副本 + 摘表 + 清空了的目录链；重复 close 幂等 false。
    #[test]
    fn close_removes_temp_file_and_dirs() {
        let edits: EditMap = Arc::default();
        let id = format!("ut-close-{}", std::process::id());
        let temp = temp_path_for(&id, "/home/spike/ut.txt");
        std::fs::create_dir_all(temp.parent().unwrap()).unwrap();
        std::fs::write(&temp, b"data").unwrap();
        edits.lock().unwrap().entry(id.clone()).or_default().insert(
            "/home/spike/ut.txt".into(),
            EditEntry {
                temp_path: temp.clone(),
                snapshot: RemoteSnapshot { size: 4, mtime: 1 },
                saved_local: LocalStamp { mtime_ns: 1, size: 4 },
                pending: None,
            },
        );
        let session_dir = temp_root().join(&id);
        assert!(temp.is_file());
        assert!(edit_close(&edits, &id, "/home/spike/ut.txt"));
        assert!(!temp.exists(), "temp file must be removed");
        assert!(!session_dir.exists(), "emptied session dir must be removed");
        assert!(!edit_close(&edits, &id, "/home/spike/ut.txt"), "second close is a no-op");
    }

    /// edit_close_session / close_all_edits：整会话清理（跨多文件）。
    #[test]
    fn close_session_cleans_everything() {
        let edits: EditMap = Arc::default();
        let id = format!("ut-close-all-{}", std::process::id());
        for name in ["/a/x.txt", "/b/y.log"] {
            let temp = temp_path_for(&id, name);
            std::fs::create_dir_all(temp.parent().unwrap()).unwrap();
            std::fs::write(&temp, b"x").unwrap();
            edits
                .lock()
                .unwrap()
                .entry(id.clone())
                .or_default()
                .insert(name.to_string(), EditEntry {
                    temp_path: temp,
                    snapshot: RemoteSnapshot { size: 1, mtime: 1 },
                    saved_local: LocalStamp { mtime_ns: 1, size: 1 },
                    pending: None,
                });
        }
        assert_eq!(edit_close_session(&edits, &id), 2);
        assert!(!temp_root().join(&id).exists(), "session dir must be gone");
        assert_eq!(edit_close_session(&edits, &id), 0, "idempotent");
        assert_eq!(close_all_edits(&edits), 0);
    }

    /// 24h 惰性清扫：老目录整树删、新目录保留（mtime 用 touch -t 钉旧）。
    #[test]
    fn sweep_removes_only_stale_session_dirs() {
        let root = temp_root().join(format!("ut-sweep-{}", std::process::id()));
        let old = root.join("old-sid");
        let fresh = root.join("fresh-sid");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(old.join("f.txt"), b"old").unwrap();
        // BSD/GNU touch 都支持 -t；钉到 2020-01-01（远早于 24h）
        let touched = std::process::Command::new("touch")
            .args(["-t", "202001010000"])
            .arg(&old)
            .status()
            .expect("run touch");
        assert!(touched.success(), "touch -t must work on this platform");

        let removed = sweep_stale_edits(&root, Duration::from_secs(24 * 3600), SystemTime::now());
        assert_eq!(removed, 1, "exactly the stale dir is removed");
        assert!(!old.exists());
        assert!(fresh.exists(), "fresh dir must survive");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
