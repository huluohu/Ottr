//! vault Tauri 命令接线（Task 5）——本次结构收敛拆为域子模块（纯代码搬移，零逻辑改动）：
//! * [`security`] —— 安全状态机（解锁/锁定/升降级/重置，锁定语义域）；
//! * [`settings`] —— settings 表 + secrets 密文 KV（AI BYOK）；
//! * [`hosts`] —— hosts / host_groups / known_hosts；
//! * [`credentials`] —— 凭据 CRUD 与明文单点出库；
//! * [`snippets`] —— 片段；
//! * [`history`] —— 命令历史 + 会话纪要；
//! * [`notify`] —— 通知中心 / 渠道 / 告警规则（B5 通知域）；
//! * [`import_export`] —— ssh-config/Xshell/Tabby 导入 + CSV 导出 + 同步快照。
//!
//! 约定（沿用原文件）：命令名 = api.ts invoke 名（snake_case）；顶层参数 camelCase
//! → snake_case 由 Tauri v2 自动转换；返回值 serde 直序列化；错误一律 `String`。
//! State：`VaultState(Arc<Vault>)` 由后台初始化线程打开后 manage（Task 16.5：钥匙链
//! SecItem 访问不进 setup 主线程，见 task-16x5-report）。

use std::sync::Arc;

use tauri::{Manager, State};

use ottr_vault::{Vault, VaultError};
/// 托管进 Tauri 的 vault 句柄（全局唯一实例）。
pub struct VaultState(pub Arc<Vault>);

/// setup 阶段打开 vault：目录 = Tauri app_data_dir（macOS
/// ~/Library/Application Support/<identifier>/）。`open_auto`：钥匙链可用走
/// 钥匙链模式（macOS/Windows 恒可用），Linux 无 Secret Service 自动落主密码
/// 模式（Phase 0 spec §3 fallback 承诺，见 ottr-vault store.rs）。
pub fn init(app: &tauri::AppHandle) -> Result<VaultState, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let vault = Vault::open_auto(&dir)?;
    Ok(VaultState(Arc::new(vault)))
}

// --- 后台初始化状态（Task 16.5，0×0 主窗 frame 修复）-------------------------
// vault::init（含钥匙链 SecItem 访问）已移出 setup 主线程。init 完成前
// `VaultState` 尚未 manage，vault 命令在 Tauri 的 State 抽取层即被拒（invoke
// promise reject："state not managed …"，进程不崩）。前端就绪门
// （frontend/security/VaultInitGate.ts）以下面的状态面为唯一放行依据：
//   * `vault_init_status` 命令——无 VaultState 依赖，初始化窗口期可安全调用；
//   * `ottr://vault-ready` / `ottr://vault-init-failed` 事件——就绪快路径。
//
// 竞态契约（happens-before）：后台线程 **先 `manage(VaultState)` 再置 Ready**，
// 且 Ready/Failed 置位先于事件发出——前端「先挂监听、后查命令」两端夹逼后，
// 见到 Ready 即 State 必已可解析，首批 vault 命令（hosts_list 等）永不踩
// "state not managed"。T11 安全语义不变：Ready 后前端照旧走
// vault_security_status → keyring 模式进主 UI / password 模式进 LockScreen。

/// vault 后台初始化状态（serde tag=status snake_case，前端
/// `VaultInitStatusPayload` 同构）。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum VaultInitStatus {
    /// 后台初始化进行中（app_data_dir + 钥匙链/SQLite 打开）。
    #[default]
    Initializing,
    /// 就绪（VaultState 已 manage，vault 命令面可用）。
    Ready,
    /// 初始化失败（error = 错误 Display）。语义等同旧的「setup 失败即启动
    /// 失败」，只是主窗已可见——前端渲染全屏错误面（含退出按钮）。
    Failed { error: String },
}

/// [`VaultInitStatus`] 的 Tauri 托管壳。Builder 启动即 manage（无钥匙链访问，
/// 零开销）；写入只发生在后台初始化线程。Arc 内壳便于线程持克隆。
#[derive(Clone, Default)]
pub struct VaultInit(pub Arc<std::sync::Mutex<VaultInitStatus>>);

impl VaultInit {
    /// 写入只在后台初始化线程发生（lib.rs vault-init 线程；crate 内私有——
    /// Ready 的 happens-before 契约不允许第三方写入点）。
    pub(crate) fn set(&self, status: VaultInitStatus) {
        *self.0.lock().unwrap() = status;
    }

    pub fn get(&self) -> VaultInitStatus {
        self.0.lock().unwrap().clone()
    }
}

/// vault 初始化状态查询（前端就绪门的取数面）。
#[tauri::command]
pub fn vault_init_status(init: State<'_, VaultInit>) -> VaultInitStatus {
    init.get()
}

/// vault 域命令的统一返回别名（Phase 2 起新命令域复用，pub(crate)）。
pub(crate) type CmdResult<T> = Result<T, String>;

fn cmd<T>(r: ottr_vault::Result<T>) -> CmdResult<T> {
    r.map_err(|e: VaultError| e.to_string())
}

/// 锁定门卫（T11）：实体命令统一在入口拒绝锁定态。vault 层只有密钥面操作
/// 硬性要求密钥（凭据 seal/open），这里把封锁面上收到全部实体读写——遮罩后的
/// UI 本不该发起这些调用，属防漏兵（settings/安全状态命令不过此门卫）。
/// pub(crate)：Phase 2 新命令域（commands/forward.rs）复用同一门卫。
pub(crate) fn ensure_unlocked(vault: &Vault) -> CmdResult<()> {
    vault.ensure_unlocked().map_err(|e| e.to_string())
}

mod credentials;
mod history;
mod hosts;
mod import_export;
mod notify;
mod security;
mod settings;
mod snippets;

// 域子模块的 pub 项（命令 fn 与载荷类型）整体再导出：lib.rs 的
// generate_handler 与消费方维持 `vault::<name>` 原路径（宏项随 glob 一并再导出）。
pub use credentials::*;
pub use history::*;
pub use hosts::*;
pub use import_export::*;
pub use notify::*;
pub use security::*;
pub use settings::*;
pub use snippets::*;

#[cfg(test)]
mod tests {
    use super::*;

    /// Task 16.5：vault_init_status 的 serde 面与前端 VaultInitStatusPayload
    /// 同构（tag=status snake_case）——字段名漂移会让前端就绪门永远停在 loading。
    #[test]
    fn vault_init_status_serde_matches_frontend_contract() {
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Initializing).unwrap(),
            serde_json::json!({ "status": "initializing" })
        );
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Ready).unwrap(),
            serde_json::json!({ "status": "ready" })
        );
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Failed {
                error: "boom".into()
            })
            .unwrap(),
            serde_json::json!({ "status": "failed", "error": "boom" })
        );
    }

    /// tracker 缺省 Initializing、set→get 终态可见（后台线程经此与前端共享
    /// 终态；Ready 置位由 lib.rs 保证严格晚于 VaultState manage）。
    #[test]
    fn vault_init_tracker_defaults_to_initializing_and_lands_terminal_state() {
        let tracker = VaultInit::default();
        assert!(matches!(tracker.get(), VaultInitStatus::Initializing));
        tracker.set(VaultInitStatus::Ready);
        assert!(matches!(tracker.get(), VaultInitStatus::Ready));
        tracker.set(VaultInitStatus::Failed { error: "x".into() });
        assert!(matches!(tracker.get(), VaultInitStatus::Failed { .. }));
    }
}
