//! 安全底座接线（Task 11，A7 收口）：自动锁定计时 + 剪贴板敏感复制自动清空 +
//! 安全配置校验。vault 层的锁定状态机在 ottr-vault（store.rs），本模块只做
//! Tauri 侧的触发与外设面：
//!
//! * **自动锁定**（主密码模式专属）：窗口失焦起计时，N 分钟后仍失焦 →
//!   `vault.lock()`（Master Key 出内存）+ `ottr://vault-locked` 事件（前端弹
//!   LockScreen）。重新聚焦即作废计时器（generation 计数，多轮失焦只认最新一轮）。
//!   配置读 settings `security.autolock_minutes`（默认 10，0 = 关），失焦时现读
//!   ——改配置即时生效，无需重启。
//! * **剪贴板清空**：`vault_copy_credential_secret` 在 Rust 侧解密凭据写剪贴板
//!   （明文不过前端，纪律同 attach），N 秒后清空（默认 30，0 = 关）。多次复制
//!   只认最新一次（同 generation 机制）——后复制的不被先复制的计时器清掉。
//! * **配置校验**：`validate_setting` 给 settings_set 命令挡越界值。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use zeroize::Zeroize;

use tauri::{AppHandle, Emitter, Manager, State};

use ottr_vault::{Credentials, KeyMode, SecretField, Settings};

use crate::vault::{VaultState, dev_unlock_enabled};

// --- settings 已知键注册表（T3 fix round 1 I-1 迁移）---------------------------
// 常量与已知键校验逻辑已**迁入 ottr-vault settings.rs**（单一事实源）：settings
// 有两个写入口——settings_set 命令与本批新增的 sync 分类导入（快照跨机来源，
// 已知键越界值不得经导入绕过范围检查）——注册表必须共享。此处 re-export 保持
// 既有引用路径（security::SETTING_* 等）全部不变。

pub use ottr_vault::settings::{
    AI_MAX_TOKENS_LIMIT, AUTOLOCK_DEFAULT_MINUTES, AUTOLOCK_MAX_MINUTES, CLIPBOARD_DEFAULT_SECS,
    CLIPBOARD_MAX_SECS, HOSTKEY_AUDIT_INTERVAL_DEFAULT_SECS, HOSTKEY_AUDIT_INTERVAL_MAX_SECS,
    HOSTKEY_AUDIT_INTERVAL_MIN_SECS, MONITOR_INTERVAL_DEFAULT_SECS, MONITOR_INTERVAL_MAX_SECS,
    SETTING_AUTOLOCK, SETTING_CLIPBOARD, SETTING_HOSTKEY_AUDIT, SETTING_HOSTKEY_AUDIT_INTERVAL,
    SETTING_MCP_ENABLED, SETTING_MONITOR_INTERVAL, SETTING_SHELL_INTEGRATION,
    SETTING_SUDO_AUTOFILL, validate_known_setting,
};

/// shell.integration 配置 → 是否注入。`None`/非布尔 = 缺省开（validate_setting
/// 挡住非布尔写入，读取侧收敛兜底——配置坏不断功能）。
pub fn shell_integration_enabled(raw: Option<&serde_json::Value>) -> bool {
    raw.and_then(|v| v.as_bool()).unwrap_or(true)
}

/// 监控采样间隔配置 → Duration。未配置 = 默认 5s；越界收敛
/// （下限 1s / 上限 1h——配置错误不断采样，同 *_from 收敛口径）。
pub fn monitor_interval_from(raw: Option<u64>) -> std::time::Duration {
    std::time::Duration::from_secs(
        raw.unwrap_or(MONITOR_INTERVAL_DEFAULT_SECS)
            .clamp(1, MONITOR_INTERVAL_MAX_SECS),
    )
}

/// 自动锁定分钟数配置 → `Some(分钟)`（0/关闭 = `None`）。
/// 未配置 = 默认 10；越界值收敛到上限（配置错误不断开保护）。
pub fn autolock_minutes_from(raw: Option<u64>) -> Option<u64> {
    match raw {
        None => Some(AUTOLOCK_DEFAULT_MINUTES),
        Some(0) => None,
        Some(n) => Some(n.min(AUTOLOCK_MAX_MINUTES)),
    }
}

/// 剪贴板清空秒数配置 → `Some(秒)`（0/关闭 = `None`）。同上收敛口径。
pub fn clipboard_clear_secs_from(raw: Option<u64>) -> Option<u64> {
    match raw {
        None => Some(CLIPBOARD_DEFAULT_SECS),
        Some(0) => None,
        Some(n) => Some(n.min(CLIPBOARD_MAX_SECS)),
    }
}

/// 巡检间隔配置 → Duration。未配置 = 默认 24h；越界收敛到上下界
/// （配置错误不断巡检——安全侧默认跑，错误配置不得静默关掉巡检）。
pub fn hostkey_audit_interval_from(raw: Option<u64>) -> Duration {
    Duration::from_secs(raw.unwrap_or(HOSTKEY_AUDIT_INTERVAL_DEFAULT_SECS).clamp(
        HOSTKEY_AUDIT_INTERVAL_MIN_SECS,
        HOSTKEY_AUDIT_INTERVAL_MAX_SECS,
    ))
}

/// sudo 自动填充开关配置 → bool。`None`/非布尔 = 缺省关（安全敏感——
/// 只有显式写入 true 才开；配置坏 = 关，安全侧）。
pub fn sudo_autofill_enabled(raw: Option<&serde_json::Value>) -> bool {
    raw.and_then(|v| v.as_bool()).unwrap_or(false)
}

/// settings_set 的已知安全键校验（薄委托）：逻辑在 ottr-vault
/// `settings::validate_known_setting`（单一事实源——settings_set 与 sync 分类
/// 导入两个写入口共享同一份注册表，T3 fix round 1 I-1）；本壳保持原签名与
/// 调用点不变。
pub fn validate_setting(key: &str, value: &serde_json::Value) -> Result<(), String> {
    validate_known_setting(key, value)
}

/// 自动锁定分钟数决策（纯函数，OTTR_DEV_UNLOCK 旁路的 autolock 侧 gate）：
/// * `dev_unlock_bypass` 命中 → `None`（**调度整体禁用**——失焦不起计时，
///   本地开发/验收仪表化，见 vault::dev_unlock_enabled）；
/// * 否则原语义：keyring 模式（无锁概念）/ 已锁定 → `None`；配置面同
///   [`autolock_minutes_from`]（未配置默认 10、0 = 关、越界收敛）。
///
/// 单测见本模块 `dev_unlock_bypass_disables_autolock_scheduling`（纯函数带参测，
/// 调用点传 env 结果，不读全局）。
fn autolock_minutes_resolved(
    dev_unlock_bypass: bool,
    is_password_mode: bool,
    locked: bool,
    raw: Option<u64>,
) -> Option<u64> {
    if dev_unlock_bypass {
        return None;
    }
    if !is_password_mode || locked {
        return None;
    }
    autolock_minutes_from(raw)
}

/// 失焦时刻现读自动锁定配置。`None` = 不计时（关闭 / keyring 模式无锁概念 /
/// 已锁定 / OTTR_DEV_UNLOCK 旁路 / settings 读取失败安全侧不断锁——读取失败
/// 按默认值走，见 *_from）。
fn autolock_minutes(app: &AppHandle) -> Option<u64> {
    // OTTR_DEV_UNLOCK 旁路最先判（本地开发/验收仪表化：计时调度整体禁用）。
    let bypass = dev_unlock_enabled(std::env::var_os("OTTR_DEV_UNLOCK").as_deref());
    let vault = app.try_state::<VaultState>()?;
    // settings 读 = 明文面（锁定可读，见 ottr-vault settings.rs），预读无害。
    let raw = Settings::get_u64(&vault.0, SETTING_AUTOLOCK).ok().flatten();
    autolock_minutes_resolved(
        bypass,
        vault.0.mode() == KeyMode::Password,
        vault.0.is_locked(),
        raw,
    )
}

/// 到点复核（fix 1/5 I-1，纯函数）：自动锁定计时器到点是否真正落锁。
/// 四个条件缺一不可：
/// * `gen_snapshot == gen_current`——期间有过任何焦点事件（重聚焦/再失焦），
///   本计时器让位最新一轮（旧计时器绝不打新状态）；
/// * `!focused`——已重新聚焦即放弃（用户在场）；
/// * `!is_locked`——已锁定（手动/前一轮）不重复锁、不重发事件。
///
/// 单测见本模块 `auto_lock_fire_matrix`。
pub fn auto_lock_should_fire(
    gen_snapshot: u64,
    gen_current: u64,
    focused: bool,
    is_locked: bool,
) -> bool {
    gen_snapshot == gen_current && !focused && !is_locked
}

/// 自动锁定计时状态（Tauri 托管）。generation：每次焦点变化自增——
/// 计时器到点后只有 generation 未变（期间无新焦点事件）才真正落锁，
/// 一条原子计数即实现「重新聚焦作废计时器 + 多轮失焦只认最新」。
#[derive(Default)]
pub struct AutoLockState {
    generation: AtomicU64,
    focused: AtomicBool,
}

impl AutoLockState {
    /// 焦点变化入口（lib.rs setup 的 WindowEvent::Focused 接线）。
    pub fn on_focus_changed(self: &Arc<Self>, app: &AppHandle, focused: bool) {
        self.focused.store(focused, Ordering::SeqCst);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if focused {
            return; // 聚焦 = 作废既有计时器（generation 已自增）
        }
        let Some(minutes) = autolock_minutes(app) else {
            return;
        };
        let state = Arc::clone(self);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(minutes * 60)).await;
            // 到点复核（auto_lock_should_fire，纯函数单测覆盖）：期间有任何
            // 焦点事件让位最新一轮；已重新聚焦 / 已锁定（手动或前一轮）不重复。
            let gen_current = state.generation.load(Ordering::SeqCst);
            let focused = state.focused.load(Ordering::SeqCst);
            let is_locked = app
                .try_state::<VaultState>()
                .is_some_and(|v| v.0.is_locked());
            if auto_lock_should_fire(generation, gen_current, focused, is_locked)
                && let Some(vault) = app.try_state::<VaultState>()
            {
                vault.0.lock();
                let _ = app.emit("ottr://vault-locked", ());
                eprintln!("[security] auto-locked after {minutes} min unfocused");
            }
        });
    }
}

// ---------------------------------------------------------------------------
// 剪贴板敏感复制 + 自动清空
// ---------------------------------------------------------------------------

/// 剪贴板 generation：每次复制自增，清空计时器到点只认最新一次复制
/// （先复制 30s 计时器不得清掉后复制的密文）。
static CLIPBOARD_GEN: AtomicU64 = AtomicU64::new(0);

/// 写剪贴板并按配置调度清空。明文 String 在 `set_text` 后就地 zeroize
/// （进程内副本不滞留；剪贴板内内容由清空计时器收尾）。
/// `secs` 为 None = 不清空（配置关闭）。失败只影响本次复制（返回 Err）。
pub fn clipboard_copy_with_autoclear(
    app: &AppHandle,
    text: String,
    secs: Option<u64>,
) -> Result<(), String> {
    let mut text = text;
    let copy_result = (|| -> Result<(), String> {
        let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard open: {e}"))?;
        cb.set_text(text.as_str())
            .map_err(|e| format!("clipboard write: {e}"))
    })();
    text.zeroize();
    copy_result?;

    let Some(secs) = secs else {
        return Ok(());
    };
    let generation = CLIPBOARD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        if CLIPBOARD_GEN.load(Ordering::SeqCst) == generation {
            // 只清「本应用最后一次复制」：期间用户复制了别的（本应用再次复制
            // 也会自增 generation），计时器静默让位。外部程序的复制无法感知——已知
            // 取舍，见 task-11-report。
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.clear();
                let _ = app.emit("ottr://clipboard-cleared", ());
                eprintln!("[security] clipboard cleared after {secs}s");
            }
        }
    });
    Ok(())
}

/// `vault_copy_credential_secret`：凭据密文复制命令（Rust 侧解密 → 剪贴板，
/// 明文不过前端）。清空秒数在服务端现读配置（前端无需知道，也改不了语义）。
#[tauri::command]
pub fn vault_copy_credential_secret(
    state: State<'_, VaultState>,
    app: AppHandle,
    id: i64,
    field: SecretField,
) -> Result<(), String> {
    state.0.ensure_unlocked().map_err(|e| e.to_string())?;
    let plain = Credentials::reveal(&state.0, id, field).map_err(|e| e.to_string())?;
    let Some(text) = plain else {
        return Err(format!("credential id={id} has no secret in {field:?}"));
    };
    let raw = Settings::get_u64(&state.0, SETTING_CLIPBOARD)
        .ok()
        .flatten();
    clipboard_copy_with_autoclear(&app, text, clipboard_clear_secs_from(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autolock_minutes_config_table() {
        assert_eq!(
            autolock_minutes_from(None),
            Some(10),
            "未配置 = 默认 10 分钟"
        );
        assert_eq!(autolock_minutes_from(Some(0)), None, "0 = 关闭");
        assert_eq!(autolock_minutes_from(Some(1)), Some(1));
        assert_eq!(autolock_minutes_from(Some(10)), Some(10));
        assert_eq!(
            autolock_minutes_from(Some(u64::MAX)),
            Some(AUTOLOCK_MAX_MINUTES),
            "越界收敛到上限（保护不断开）"
        );
    }

    #[test]
    fn clipboard_secs_config_table() {
        assert_eq!(
            clipboard_clear_secs_from(None),
            Some(30),
            "未配置 = 默认 30s"
        );
        assert_eq!(clipboard_clear_secs_from(Some(0)), None, "0 = 关闭");
        assert_eq!(clipboard_clear_secs_from(Some(30)), Some(30));
        assert_eq!(
            clipboard_clear_secs_from(Some(99_999)),
            Some(CLIPBOARD_MAX_SECS),
            "越界收敛到上限"
        );
    }

    #[test]
    fn shell_integration_enabled_defaults_on() {
        assert!(shell_integration_enabled(None), "未配置 = 缺省开");
        assert!(shell_integration_enabled(Some(&serde_json::json!(true))));
        assert!(!shell_integration_enabled(Some(&serde_json::json!(false))));
        assert!(
            shell_integration_enabled(Some(&serde_json::json!("yes"))),
            "非布尔收敛默认开"
        );
    }

    #[test]
    fn auto_lock_fire_matrix() {
        // 四条件齐备 → 落锁
        assert!(auto_lock_should_fire(1, 1, false, false));
        // generation 变化（期间重聚焦/再失焦过）→ 旧计时器让位，不打锁
        assert!(!auto_lock_should_fire(1, 2, false, false));
        // 未到点形态不存在于本函数；但失焦态是前提：已聚焦不锁
        assert!(!auto_lock_should_fire(1, 1, true, false));
        // 已锁定（手动/前一轮）不重复锁
        assert!(!auto_lock_should_fire(1, 1, false, true));
        // 竞态组合：generation 变了且已聚焦 / 已锁定，一律不打
        assert!(!auto_lock_should_fire(3, 4, true, true));
        assert!(!auto_lock_should_fire(3, 4, false, true));
    }

    /// OTTR_DEV_UNLOCK 旁路 gate（autolock 侧）：命中 = 自动锁定调度整体禁用
    /// （None——失焦不起计时）；未命中 = 原语义矩阵逐格不变。纯函数带参测
    /// （调用点 autolock_minutes 传 std::env::var_os 结果，不读全局 env）。
    #[test]
    fn dev_unlock_bypass_disables_autolock_scheduling() {
        // 旁路命中：无论模式/锁定/配置，一律 None。
        assert_eq!(
            autolock_minutes_resolved(true, true, false, Some(10)),
            None,
            "旁路命中 = 计时整体禁用"
        );
        assert_eq!(autolock_minutes_resolved(true, false, false, None), None);
        assert_eq!(autolock_minutes_resolved(true, true, true, Some(0)), None);
        // 未命中：原语义矩阵不变。
        assert_eq!(
            autolock_minutes_resolved(false, true, false, Some(10)),
            Some(10),
            "password 模式未锁定 = 按配置计时"
        );
        assert_eq!(
            autolock_minutes_resolved(false, true, false, None),
            Some(10),
            "未配置 = 默认 10 分钟"
        );
        assert_eq!(
            autolock_minutes_resolved(false, true, false, Some(0)),
            None,
            "配置 0 = 关"
        );
        assert_eq!(
            autolock_minutes_resolved(false, false, false, Some(10)),
            None,
            "keyring 模式无锁概念"
        );
        assert_eq!(
            autolock_minutes_resolved(false, true, true, Some(10)),
            None,
            "已锁定不重复计时"
        );
    }

    #[test]
    fn validate_setting_rejects_out_of_range_and_type_errors() {
        // 合法值放行。
        assert_eq!(
            validate_setting(SETTING_AUTOLOCK, &serde_json::json!(10)),
            Ok(())
        );
        assert_eq!(
            validate_setting(SETTING_AUTOLOCK, &serde_json::json!(0)),
            Ok(())
        );
        assert_eq!(
            validate_setting(SETTING_CLIPBOARD, &serde_json::json!(30)),
            Ok(())
        );
        assert_eq!(
            validate_setting("ui.theme", &serde_json::json!("dark")),
            Ok(())
        );
        assert_eq!(
            validate_setting("ui.language", &serde_json::json!("zh-CN")),
            Ok(())
        );
        assert_eq!(
            validate_setting("unknown.key", &serde_json::json!(1)),
            Ok(())
        );
        // Task 15 fix 1/5：shell.integration 布尔校验注册
        assert_eq!(
            validate_setting(SETTING_SHELL_INTEGRATION, &serde_json::json!(false)),
            Ok(())
        );
        assert!(validate_setting(SETTING_SHELL_INTEGRATION, &serde_json::json!("on")).is_err());
        // 越界拒绝（写入侧显式失败）。
        assert!(validate_setting(SETTING_AUTOLOCK, &serde_json::json!(100_000)).is_err());
        assert!(validate_setting(SETTING_CLIPBOARD, &serde_json::json!(100_000)).is_err());
        // 类型错拒绝。
        assert!(validate_setting(SETTING_AUTOLOCK, &serde_json::json!(-1)).is_err());
        assert!(validate_setting(SETTING_AUTOLOCK, &serde_json::json!("10")).is_err());
        assert!(validate_setting("ui.theme", &serde_json::json!("solarized")).is_err());
        assert!(validate_setting("ui.theme", &serde_json::json!(1)).is_err());
        assert!(validate_setting("ui.language", &serde_json::json!("fr-FR")).is_err());
        // Phase 3 Task 1：监控采样间隔（1-3600）写入侧校验
        assert_eq!(
            validate_setting(SETTING_MONITOR_INTERVAL, &serde_json::json!(5)),
            Ok(())
        );
        assert!(validate_setting(SETTING_MONITOR_INTERVAL, &serde_json::json!(0)).is_err());
        assert!(validate_setting(SETTING_MONITOR_INTERVAL, &serde_json::json!(3601)).is_err());
        assert!(validate_setting(SETTING_MONITOR_INTERVAL, &serde_json::json!("5s")).is_err());
    }

    #[test]
    fn monitor_interval_defaults_and_clamps() {
        use std::time::Duration;
        assert_eq!(
            monitor_interval_from(None),
            Duration::from_secs(MONITOR_INTERVAL_DEFAULT_SECS),
            "未配置 = 默认 5s"
        );
        assert_eq!(monitor_interval_from(Some(10)), Duration::from_secs(10));
        assert_eq!(
            monitor_interval_from(Some(0)),
            Duration::from_secs(1),
            "0 收敛到下限（不断采样）"
        );
        assert_eq!(
            monitor_interval_from(Some(99_999)),
            Duration::from_secs(MONITOR_INTERVAL_MAX_SECS),
            "越界收敛到上限"
        );
    }

    #[test]
    fn hostkey_audit_interval_defaults_and_clamps() {
        use std::time::Duration;
        assert_eq!(
            hostkey_audit_interval_from(None),
            Duration::from_secs(HOSTKEY_AUDIT_INTERVAL_DEFAULT_SECS),
            "未配置 = 默认 24h"
        );
        assert_eq!(
            hostkey_audit_interval_from(Some(3600)),
            Duration::from_secs(3600)
        );
        assert_eq!(
            hostkey_audit_interval_from(Some(1)),
            Duration::from_secs(HOSTKEY_AUDIT_INTERVAL_MIN_SECS),
            "过短收敛到下限 60s（防把 keyscan 轮转打满）"
        );
        assert_eq!(
            hostkey_audit_interval_from(Some(u64::MAX)),
            Duration::from_secs(HOSTKEY_AUDIT_INTERVAL_MAX_SECS),
            "越界收敛到上限 7 天"
        );
    }

    #[test]
    fn sudo_autofill_defaults_off() {
        assert!(!sudo_autofill_enabled(None), "未配置 = 缺省关（安全敏感）");
        assert!(!sudo_autofill_enabled(Some(&serde_json::json!(false))));
        assert!(sudo_autofill_enabled(Some(&serde_json::json!(true))));
        assert!(
            !sudo_autofill_enabled(Some(&serde_json::json!("yes"))),
            "非布尔收敛默认关（安全侧）"
        );
    }

    #[test]
    fn validate_setting_b9_keys() {
        use serde_json::json;
        assert_eq!(
            validate_setting(SETTING_HOSTKEY_AUDIT, &json!(true)),
            Ok(())
        );
        assert!(validate_setting(SETTING_HOSTKEY_AUDIT, &json!("on")).is_err());
        assert_eq!(
            validate_setting(SETTING_HOSTKEY_AUDIT_INTERVAL, &json!(86_400)),
            Ok(())
        );
        // 写入侧显式拒绝越界（读取侧才收敛，见 hostkey_audit_interval_from）。
        assert!(validate_setting(SETTING_HOSTKEY_AUDIT_INTERVAL, &json!(59)).is_err());
        assert!(validate_setting(SETTING_HOSTKEY_AUDIT_INTERVAL, &json!(604_801)).is_err());
        assert!(validate_setting(SETTING_HOSTKEY_AUDIT_INTERVAL, &json!("1d")).is_err());
        assert_eq!(
            validate_setting(SETTING_SUDO_AUTOFILL, &json!(false)),
            Ok(())
        );
        assert!(validate_setting(SETTING_SUDO_AUTOFILL, &json!(1)).is_err());
        // C1：mcp.enabled 布尔校验（默认关是存储缺省，写入侧只挡类型错）。
        assert_eq!(validate_setting(SETTING_MCP_ENABLED, &json!(true)), Ok(()));
        assert!(validate_setting(SETTING_MCP_ENABLED, &json!("on")).is_err());
        assert!(validate_setting(SETTING_MCP_ENABLED, &json!(1)).is_err());
    }
}
