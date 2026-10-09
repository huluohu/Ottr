//! 数据进出面：ssh-config / Xshell / Tabby 导入 + 主机 CSV 导出 + 同步分类
//! 快照（Phase 5 Task 3）。纯搬家拆分（原 vault.rs 单文件）。

use std::path::PathBuf;

use tauri::Manager;
use tauri::State;

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- 导入 / 导出（Task 5 Step 3）-------------------------------------------

/// 导入 ~/.ssh/config（`path` 缺省时用 `~/.ssh/config`；前端 MVP 无文件选择器，
/// 传 None 即默认路径——留参数位给后续文件选择对话框）。
/// 解析与去重规则见 ssh_config 模块文档；报告（新增/跳过/错误行）由前端对话框展示。
#[specta::specta]
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(crate::ssh_config::default_ssh_config_path)
        .ok_or_else(|| "cannot resolve home directory".to_string())?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let outcome = crate::ssh_config::parse_config(&content);
    cmd(crate::ssh_config::import_entries(&state.0, outcome))
}

/// 导入 Xshell 会话（Phase 2 Task 10，B3）。`path` = 会话目录或单个 .xsh；
/// 缺省回落 Windows 惯例会话目录（不存在即报错——mac/Linux 无默认位置）。
/// 解析规则与去重见 importers::xshell 模块文档；报告同构 ssh-config 导入。
#[specta::specta]
#[tauri::command]
pub fn import_xshell_sessions(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(crate::importers::xshell::default_sessions_dir)
        .ok_or_else(|| "cannot resolve Xshell sessions directory; pick a folder".to_string())?;
    cmd(crate::importers::xshell::import_path(&state.0, &path))
}

/// 导入 Tabby 配置（Phase 2 Task 10，B3）。`path` 必传（配置 JSON 无跨平台
/// 惯例位置——前端经文件对话框选定）。解析规则见 importers::tabby 模块文档。
#[specta::specta]
#[tauri::command]
pub fn import_tabby_config(
    state: State<'_, VaultState>,
    path: String,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    cmd(crate::importers::tabby::import_path(
        &state.0,
        &PathBuf::from(path),
    ))
}

/// CSV 导出主机清单。`path` 缺省写到系统下载目录 `ottr-hosts.csv`；返回落盘路径。
/// CSV 组装（RFC4180 转义 + 实体 join）在 ottr-vault `hosts_csv`（BL-206：随
/// 实体同库可独立单测）；本命令只保留路径解析与落盘。
#[specta::specta]
#[tauri::command]
pub fn export_hosts_csv(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<String> {
    ensure_unlocked(&state.0)?;
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
    let csv = ottr_vault::hosts_csv(&state.0).map_err(|e| e.to_string())?;
    std::fs::write(&target, csv).map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

// --- 同步分类快照（Phase 5 Task 3；ottr-vault sync_snapshot 模块）-------------
// 分类快照导出/导入 = 同步编排（frontend/sync/SyncStore.ts）的数据面。两者都开封/
// 重密封凭据与渠道密文（双层加密语义：信封口令保护传输面、本机主密码保护落盘
// 面，见 task-3-report）——过 ensure_unlocked 门卫，与凭据 CRUD 同一锁定语义。
// 命令名即简报裁定面：sync_export_categories(cats) / sync_import_categories(cats,
// data, mode)；顶层参数 camelCase（cats/data/mode 无歧义不转）。

/// 导出所选分类为快照 JSON（确定性输出；含解密后的凭据/渠道明文——返回值只进
/// 信封加密，前端不得落盘/落日志）。
#[specta::specta]
#[tauri::command]
pub fn sync_export_categories(
    state: State<'_, VaultState>,
    cats: Vec<String>,
) -> CmdResult<serde_json::Value> {
    ensure_unlocked(&state.0)?;
    cmd(ottr_vault::sync_snapshot::export_categories(
        &state.0, &cats,
    ))
}

/// 全量替换式导入所选分类（单事务原子；返回逐分类落库/跳过计数）。
#[specta::specta]
#[tauri::command]
pub fn sync_import_categories(
    state: State<'_, VaultState>,
    cats: Vec<String>,
    data: serde_json::Value,
    mode: ottr_vault::SyncImportMode,
) -> CmdResult<ottr_vault::SyncImportReport> {
    ensure_unlocked(&state.0)?;
    cmd(ottr_vault::sync_snapshot::import_categories(
        &state.0, &cats, &data, mode,
    ))
}
