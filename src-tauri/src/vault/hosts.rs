//! hosts / host_groups / known_hosts 存储面（0004 迁移起 known_hosts 按
//! host 端点记账）。纯搬家拆分（原 vault.rs 单文件）。

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

#[tauri::command]
pub fn host_groups_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::HostGroup>> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::list(&state.0))
}

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
