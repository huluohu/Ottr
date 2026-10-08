//! 片段（snippets）存储面。纯搬家拆分（原 vault.rs 单文件）。

use tauri::State;

use ottr_vault::{SnippetInput, Snippets};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- snippets --------------------------------------------------------------

#[tauri::command]
pub fn snippets_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::list(&state.0))
}

#[tauri::command]
pub fn snippets_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::get(&state.0, id))
}

#[tauri::command]
pub fn snippets_search(
    state: State<'_, VaultState>,
    query: String,
) -> CmdResult<Vec<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::search(&state.0, &query))
}

#[tauri::command]
pub fn snippets_create(
    state: State<'_, VaultState>,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::create(&state.0, &input))
}

#[tauri::command]
pub fn snippets_update(
    state: State<'_, VaultState>,
    id: i64,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::update(&state.0, id, &input))
}

#[tauri::command]
pub fn snippets_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::delete(&state.0, id))
}
