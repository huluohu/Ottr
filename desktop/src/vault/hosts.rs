//! hosts / host_groups / known_hosts 存储面（0004 迁移起 known_hosts 按
//! host 端点记账）。纯搬家拆分（原 vault.rs 单文件）。

use std::path::PathBuf;

use tauri::State;

use ottr_vault::{Host, HostGroups, HostInput, Hosts, KnownHosts};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- hosts -----------------------------------------------------------------

#[specta::specta]
#[tauri::command]
pub fn hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_get(state: State<'_, VaultState>, id: i64) -> CmdResult<Option<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::get(&state.0, id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_create(state: State<'_, VaultState>, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::create(&state.0, input))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_update(state: State<'_, VaultState>, id: i64, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::update(&state.0, id, input))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::delete(&state.0, id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_list_by_group(
    state: State<'_, VaultState>,
    group_id: Option<i64>,
) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list_by_group(&state.0, group_id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_search(state: State<'_, VaultState>, query: String) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::search(&state.0, &query))
}

// --- host_groups -----------------------------------------------------------

#[specta::specta]
#[tauri::command]
pub fn host_groups_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::HostGroup>> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_create(
    state: State<'_, VaultState>,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::create(
        &state.0,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_update(
    state: State<'_, VaultState>,
    id: i64,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::update(
        &state.0,
        id,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::delete(&state.0, id))
}

// --- known_hosts -----------------------------------------------------------
// 0004 迁移（Task 8 义务①）起按 host 端点记账：host_key = "address:port"
// （ottr_vault::host_endpoint_key 构造），fingerprint 列 = 当前信任锚。

#[specta::specta]
#[tauri::command]
pub fn known_hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::KnownHost>> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn known_hosts_upsert(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::upsert(&state.0, &host_key, &fingerprint))
}

#[specta::specta]
#[tauri::command]
pub fn known_hosts_verify(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::verify(&state.0, &host_key, &fingerprint))
}

#[specta::specta]
#[tauri::command]
pub fn known_hosts_mark_changed(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::mark_changed(&state.0, &host_key, &fingerprint))
}

/// 删除 = 忘记该端点（B9 管理页，Task 6 Phase 3）：行消失后下次连接重走
/// TOFU（首见 pending）。返回是否有行被删（幂等面）。
#[specta::specta]
#[tauri::command]
pub fn known_hosts_delete(state: State<'_, VaultState>, host_key: String) -> CmdResult<bool> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::delete(&state.0, &host_key))
}

/// known_hosts 文件不存在时的错误码前缀（前端据此展示「未找到文件」提示，
/// 不把路径/文案硬编码进前端）。格式：`"<code>: <path>"`。
pub const KNOWN_HOSTS_FILE_NOT_FOUND: &str = "known_hosts_file_not_found";

/// 默认 known_hosts 路径：`~/.ssh/known_hosts`（HOME / USERPROFILE 均兼顾三端；
/// 与 `ssh_config::default_ssh_config_path` 同款兼容写法）。
fn default_known_hosts_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let home = PathBuf::from(home);
    if home.as_os_str().is_empty() {
        return None;
    }
    Some(home.join(".ssh").join("known_hosts"))
}

/// 导入本地 known_hosts（`path=None` → 默认路径 `~/.ssh/known_hosts`；
/// Windows 用 `%USERPROFILE%\.ssh\known_hosts`）。报告含 added /
/// skipped_duplicate / skipped_conflict / errors。
///
/// 语义（见 `ottr_vault::KnownHosts::import`）：导入走 **verify 语义**
/// （state=ok / verified=1）——否则首次连接照样弹 TOFU 确认框，导入白做；
/// 同端点已存在的**一律不覆盖**（相同指纹 = 跳过重复，不同指纹 = 跳过冲突）。
///
/// 文件不存在**不报错**（用户没这个文件是常态）：返回全零报告 + 一条说明性
/// errors 文案（[`KNOWN_HOSTS_FILE_NOT_FOUND`] 前缀），前端展示「未找到文件」。
#[specta::specta]
#[tauri::command]
pub async fn known_hosts_import(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<ottr_vault::KnownHostsImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(default_known_hosts_path)
        .ok_or_else(|| "cannot resolve home directory".to_string())?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 用户没这个文件是常态——不报错，报「未找到」让前端展示。
            return Ok(ottr_vault::KnownHostsImportReport {
                added: 0,
                skipped_duplicate: 0,
                skipped_conflict: 0,
                errors: vec![format!("{KNOWN_HOSTS_FILE_NOT_FOUND}: {}", path.display())],
            });
        }
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let entries = ottr_ssh::known_hosts::parse_known_hosts_file(&content);
    // 择一（同端点多密钥型 → 优先 ed25519，OpenSSH 语义在 ottr-ssh 层）。
    let selected = ottr_ssh::known_hosts::select_by_endpoint(&entries);
    let import_entries: Vec<ottr_vault::KnownHostImportEntry> = selected
        .into_iter()
        .map(|s| ottr_vault::KnownHostImportEntry {
            host: s.host,
            port: s.port,
            fingerprint: s.fingerprint,
            candidates: s.candidates,
        })
        .collect();
    Ok(ottr_vault::KnownHosts::import(&state.0, &import_entries))
}
