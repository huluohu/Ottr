//! settings 表（主题/语言/安全配置）+ secrets 密文 KV（Task 13 AI BYOK）。
//! 纯搬家拆分（原 vault.rs 单文件）。

use tauri::State;

use ottr_vault::{Secrets, Settings};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- settings（T11：theme/language 迁 vault + 安全配置）-----------------------

#[specta::specta]
#[tauri::command]
pub fn settings_get(
    state: State<'_, VaultState>,
    key: String,
) -> CmdResult<Option<serde_json::Value>> {
    // 明文面：锁定可读（锁定屏要读主题/自动锁定配置，见 ottr-vault settings.rs）。
    cmd(Settings::get(&state.0, &key))
}

/// 写设置项。已知安全键越界/类型错显式拒绝（security::validate_setting），
/// 未注册键放行（settings 表是通用配置面）。
#[specta::specta]
#[tauri::command]
pub fn settings_set(
    state: State<'_, VaultState>,
    key: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    crate::security::validate_setting(&key, &value)?;
    cmd(Settings::set(&state.0, &key, &value))
}

// --- secrets（Task 13，AI BYOK）密文 KV：provider api key 等 ------------------
// 与 settings 相对：**密文面**（AES-256-GCM 密封，AAD 绑定 rowid），锁定即拒
// （ensure_unlocked 门卫同实体命令）。key 逻辑名约定 `ai.apikey.<providerId>`；
// 明文只在 webview 组装请求头时短暂出现（前端经 credentials_reveal 同款单点
// 出库面 secret_get），永不落 settings/日志。

/// 写入/覆盖一个密文项（upsert）。
#[specta::specta]
#[tauri::command]
pub fn secret_set(state: State<'_, VaultState>, key: String, value: String) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::set(&state.0, &key, &value))
}

/// 读一个密文项（明文单点出库；未设置 → None）。
#[specta::specta]
#[tauri::command]
pub fn secret_get(state: State<'_, VaultState>, key: String) -> CmdResult<Option<String>> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::get(&state.0, &key))
}

/// 删除一个密文项（未知 key 显式报错——provider 已删而密文在即 bug，宁可响）。
#[specta::specta]
#[tauri::command]
pub fn secret_delete(state: State<'_, VaultState>, key: String) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::delete(&state.0, &key))
}

/// 密文项存在性（不派生明文——设置页「已保存 key」标记）。
#[specta::specta]
#[tauri::command]
pub fn secret_contains(state: State<'_, VaultState>, key: String) -> CmdResult<bool> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::contains(&state.0, &key))
}
