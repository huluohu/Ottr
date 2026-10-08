//! 凭据 CRUD 与明文单点出库（reveal）。纯搬家拆分（原 vault.rs 单文件）。

use tauri::State;

use ottr_vault::{CredentialInput, CredentialPatch, Credentials, SecretField};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- credentials -----------------------------------------------------------

#[specta::specta]
#[tauri::command]
pub fn credentials_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Credential>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn credentials_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Credential>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::get(&state.0, id))
}

#[specta::specta]
#[tauri::command]
pub fn credentials_create(
    state: State<'_, VaultState>,
    input: CredentialInput,
) -> CmdResult<ottr_vault::Credential> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::create(&state.0, &input))
}

#[specta::specta]
#[tauri::command]
pub fn credentials_update(
    state: State<'_, VaultState>,
    id: i64,
    patch: CredentialPatch,
) -> CmdResult<ottr_vault::Credential> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::update(&state.0, id, &patch))
}

#[specta::specta]
#[tauri::command]
pub fn credentials_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::delete(&state.0, id))
}

/// 明文单点出库（`field` 反序列化依赖 SecretField 的 serde snake_case 面，
/// Task 4 评审转交必办①）。
#[specta::specta]
#[tauri::command]
pub fn credentials_reveal(
    state: State<'_, VaultState>,
    id: i64,
    field: SecretField,
) -> CmdResult<Option<String>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::reveal(&state.0, id, field))
}
