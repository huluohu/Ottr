//! vault Tauri 命令接线（Task 5）。
//!
//! Task 4 的 TS 层（src/vault/api.ts）文档化了 27 个命令名契约；本模块在
//! src-tauri 侧逐字落地（真后端此前未接线，api.test.ts 注释「真 Tauri 后端
//! 命令在 Task 5 接线」即此）。约定：
//!   * 命令名 = api.ts invoke 名（snake_case，generate_handler 注册同名）；
//!   * 顶层参数 camelCase → Rust snake_case 由 Tauri v2 自动转换（groupId →
//!     group_id）；载荷对象内部（HostInput 等）是 serde 反序列化面，snake_case；
//!   * 返回值 serde 直序列化（snake_case），与 TS 同构类型逐字对齐；
//!   * 错误一律 `String`（VaultError::Display 面向用户可读）。
//!
//! State：`VaultState(Arc<Vault>)` 在 setup 阶段打开（app_data_dir），单连接
//! Mutex 串行化见 ottr-vault store.rs 模块文档。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};

use ottr_vault::{
    CredentialInput, CredentialPatch, Credentials, Host, HostGroups, HostInput, Hosts, KnownHosts,
    SecretField, SnippetInput, Snippets, Vault, VaultError,
};

/// 托管进 Tauri 的 vault 句柄（全局唯一实例）。
pub struct VaultState(pub Arc<Vault>);

/// setup 阶段打开 vault：目录 = Tauri app_data_dir（macOS
/// ~/Library/Application Support/<identifier>/），Master Key 走系统钥匙链。
pub fn init(app: &tauri::AppHandle) -> Result<VaultState, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let vault = Vault::open(&dir)?;
    Ok(VaultState(Arc::new(vault)))
}

type CmdResult<T> = Result<T, String>;

fn cmd<T>(r: ottr_vault::Result<T>) -> CmdResult<T> {
    r.map_err(|e: VaultError| e.to_string())
}

// --- hosts -----------------------------------------------------------------

#[tauri::command]
pub fn hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<Host>> {
    cmd(Hosts::list(&state.0))
}

#[tauri::command]
pub fn hosts_get(state: State<'_, VaultState>, id: i64) -> CmdResult<Option<Host>> {
    cmd(Hosts::get(&state.0, id))
}

#[tauri::command]
pub fn hosts_create(state: State<'_, VaultState>, input: HostInput) -> CmdResult<Host> {
    cmd(Hosts::create(&state.0, input))
}

#[tauri::command]
pub fn hosts_update(state: State<'_, VaultState>, id: i64, input: HostInput) -> CmdResult<Host> {
    cmd(Hosts::update(&state.0, id, input))
}

#[tauri::command]
pub fn hosts_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    cmd(Hosts::delete(&state.0, id))
}

#[tauri::command]
pub fn hosts_list_by_group(
    state: State<'_, VaultState>,
    group_id: Option<i64>,
) -> CmdResult<Vec<Host>> {
    cmd(Hosts::list_by_group(&state.0, group_id))
}

#[tauri::command]
pub fn hosts_search(state: State<'_, VaultState>, query: String) -> CmdResult<Vec<Host>> {
    cmd(Hosts::search(&state.0, &query))
}

// --- credentials -----------------------------------------------------------

#[tauri::command]
pub fn credentials_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Credential>> {
    cmd(Credentials::list(&state.0))
}

#[tauri::command]
pub fn credentials_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Credential>> {
    cmd(Credentials::get(&state.0, id))
}

#[tauri::command]
pub fn credentials_create(
    state: State<'_, VaultState>,
    input: CredentialInput,
) -> CmdResult<ottr_vault::Credential> {
    cmd(Credentials::create(&state.0, &input))
}

#[tauri::command]
pub fn credentials_update(
    state: State<'_, VaultState>,
    id: i64,
    patch: CredentialPatch,
) -> CmdResult<ottr_vault::Credential> {
    cmd(Credentials::update(&state.0, id, &patch))
}

#[tauri::command]
pub fn credentials_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    cmd(Credentials::delete(&state.0, id))
}

/// 明文单点出库（`field` 反序列化依赖 SecretField 的 serde snake_case 面，
/// Task 4 评审转交必办①）。
#[tauri::command]
pub fn credentials_reveal(
    state: State<'_, VaultState>,
    id: i64,
    field: SecretField,
) -> CmdResult<Option<String>> {
    cmd(Credentials::reveal(&state.0, id, field))
}

// --- host_groups -----------------------------------------------------------

#[tauri::command]
pub fn host_groups_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::HostGroup>> {
    cmd(HostGroups::list(&state.0))
}

#[tauri::command]
pub fn host_groups_create(
    state: State<'_, VaultState>,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
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
    cmd(HostGroups::delete(&state.0, id))
}

// --- snippets --------------------------------------------------------------

#[tauri::command]
pub fn snippets_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Snippet>> {
    cmd(Snippets::list(&state.0))
}

#[tauri::command]
pub fn snippets_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Snippet>> {
    cmd(Snippets::get(&state.0, id))
}

#[tauri::command]
pub fn snippets_search(
    state: State<'_, VaultState>,
    query: String,
) -> CmdResult<Vec<ottr_vault::Snippet>> {
    cmd(Snippets::search(&state.0, &query))
}

#[tauri::command]
pub fn snippets_create(
    state: State<'_, VaultState>,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    cmd(Snippets::create(&state.0, &input))
}

#[tauri::command]
pub fn snippets_update(
    state: State<'_, VaultState>,
    id: i64,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    cmd(Snippets::update(&state.0, id, &input))
}

#[tauri::command]
pub fn snippets_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    cmd(Snippets::delete(&state.0, id))
}

// --- known_hosts -----------------------------------------------------------
// 0004 迁移（Task 8 义务①）起按 host 端点记账：host_key = "address:port"
// （ottr_vault::host_endpoint_key 构造），fingerprint 列 = 当前信任锚。

#[tauri::command]
pub fn known_hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::KnownHost>> {
    cmd(KnownHosts::list(&state.0))
}

#[tauri::command]
pub fn known_hosts_upsert(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    cmd(KnownHosts::upsert(&state.0, &host_key, &fingerprint))
}

#[tauri::command]
pub fn known_hosts_verify(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    cmd(KnownHosts::verify(&state.0, &host_key, &fingerprint))
}

#[tauri::command]
pub fn known_hosts_mark_changed(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    cmd(KnownHosts::mark_changed(&state.0, &host_key, &fingerprint))
}

// --- 导入 / 导出（Task 5 Step 3）-------------------------------------------

/// 导入 ~/.ssh/config（`path` 缺省时用 `~/.ssh/config`；前端 MVP 无文件选择器，
/// 传 None 即默认路径——留参数位给后续文件选择对话框）。
/// 解析与去重规则见 ssh_config 模块文档；报告（新增/跳过/错误行）由前端对话框展示。
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<crate::ssh_config::ImportReport> {
    let path = path
        .map(PathBuf::from)
        .or_else(crate::ssh_config::default_ssh_config_path)
        .ok_or_else(|| "cannot resolve home directory".to_string())?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let outcome = crate::ssh_config::parse_config(&content);
    cmd(crate::ssh_config::import_entries(&state.0, outcome))
}

/// CSV 导出主机清单。`path` 缺省写到系统下载目录 `ottr-hosts.csv`；返回落盘路径。
#[tauri::command]
pub fn export_hosts_csv(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = app
                .path()
                .download_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| format!("resolve export dir: {e}"))?;
            dir.join("ottr-hosts.csv")
        }
    };
    let csv = build_hosts_csv(&state.0).map_err(|e| e.to_string())?;
    std::fs::write(&target, csv).map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 主机清单 CSV（RFC4180：含逗号/引号/换行的字段加引号、引号翻倍）。
fn build_hosts_csv(vault: &Vault) -> ottr_vault::Result<String> {
    let groups: std::collections::HashMap<i64, String> = HostGroups::list(vault)?
        .into_iter()
        .map(|g| (g.id, g.name))
        .collect();
    let mut out = String::from("name,username,address,port,group,tags,encoding,notes\n");
    for h in Hosts::list(vault)? {
        let group = h
            .group_id
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
        let row: Vec<String> = vec![
            h.name.clone(),
            h.username.clone().unwrap_or_default(),
            h.address.clone(),
            h.port.to_string(),
            group.to_string(),
            h.tags.join("|"),
            h.encoding_override.clone().unwrap_or_default(),
            h.notes.clone().unwrap_or_default(),
        ];
        let cells: Vec<String> = row.iter().map(|c| csv_field(c)).collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// 单字段转义：危险字符（`,` `"` CR LF）任一出现即整体加引号、内部引号翻倍。
fn csv_field(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_field_quotes_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }
}
