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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use zeroize::Zeroize;

use tauri::{AppHandle, Emitter, Manager, State};

use ottr_vault::{Credentials, KeyMode, SecretField, Settings};

use crate::vault::VaultState;

/// 自动锁定默认分钟数（简报定值 10）。
pub const AUTOLOCK_DEFAULT_MINUTES: u64 = 10;
/// 自动锁定上限（1 天；防误输入把锁拖成装饰）。
pub const AUTOLOCK_MAX_MINUTES: u64 = 24 * 60;
/// 剪贴板清空默认秒数（简报定值 30）。
pub const CLIPBOARD_DEFAULT_SECS: u64 = 30;
/// 剪贴板清空上限（1 小时）。
pub const CLIPBOARD_MAX_SECS: u64 = 3600;

/// shell 集成自动注入开关（Task 15 fix 1/5，⌘R 历史入库的数据源）。
/// 缺省开（None = 注入）；false = 关（attach 不探测不注入）。
pub const SETTING_SHELL_INTEGRATION: &str = "shell.integration";

/// shell.integration 配置 → 是否注入。`None`/非布尔 = 缺省开（validate_setting
/// 挡住非布尔写入，读取侧收敛兜底——配置坏不断功能）。
pub fn shell_integration_enabled(raw: Option<&serde_json::Value>) -> bool {
    raw.and_then(|v| v.as_bool()).unwrap_or(true)
}

pub const SETTING_AUTOLOCK: &str = "security.autolock_minutes";
pub const SETTING_CLIPBOARD: &str = "security.clipboard_clear_secs";

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

/// AI 单请求 token 上限（Task 13 成本护栏）：写入侧上限 8192（缺省 1024，
/// 前端读侧兜底）。
pub const AI_MAX_TOKENS_LIMIT: u64 = 8192;

/// settings_set 的已知安全键校验（越界/类型错显式拒绝，不静默收敛——写入侧
/// 拒绝比读取侧收敛更能暴露前端 bug；读取侧仍收敛兜底，见 *_from）。
pub fn validate_setting(key: &str, value: &serde_json::Value) -> Result<(), String> {
    fn u64_in_range(value: &serde_json::Value, max: u64) -> Result<(), String> {
        let n = value
            .as_u64()
            .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
        if n > max {
            return Err(format!("value {n} exceeds limit {max}"));
        }
        Ok(())
    }
    match key {
        SETTING_AUTOLOCK => u64_in_range(value, AUTOLOCK_MAX_MINUTES),
        SETTING_CLIPBOARD => u64_in_range(value, CLIPBOARD_MAX_SECS),
        // Task 13：AI 成本护栏（单请求 max_tokens 上限）与诊断自动触发开关
        SETTING_SHELL_INTEGRATION => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err("shell.integration expects a boolean".to_string())
            }
        }
        "ai.max_tokens" => u64_in_range(value, AI_MAX_TOKENS_LIMIT),
        "ai.enabled" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err("ai.enabled expects a boolean".to_string())
            }
        }
        "ui.theme" => {
            let s = value
                .as_str()
                .ok_or_else(|| "ui.theme expects a string".to_string())?;
            if matches!(s, "light" | "dark" | "system") {
                Ok(())
            } else {
                Err(format!("ui.theme must be light|dark|system, got {s:?}"))
            }
        }
        "ui.language" => {
            let s = value
                .as_str()
                .ok_or_else(|| "ui.language expects a string".to_string())?;
            if matches!(s, "zh-CN" | "en-US") {
                Ok(())
            } else {
                Err(format!("ui.language must be zh-CN|en-US, got {s:?}"))
            }
        }
        _ => Ok(()), // 未注册键放行（settings 表是通用配置面）
    }
}

/// 失焦时刻现读自动锁定配置。`None` = 不计时（关闭 / keyring 模式无锁概念 /
/// 已锁定 / settings 读取失败安全侧不断锁——读取失败按默认值走，见 *_from）。
fn autolock_minutes(app: &AppHandle) -> Option<u64> {
    let Some(vault) = app.try_state::<VaultState>() else {
        return None;
    };
    if vault.0.mode() != KeyMode::Password || vault.0.is_locked() {
        return None;
    }
    let raw = Settings::get_u64(&vault.0, SETTING_AUTOLOCK).ok().flatten();
    autolock_minutes_from(raw)
}

/// 到点复核（fix 1/5 I-1，纯函数）：自动锁定计时器到点是否真正落锁。
/// 四个条件缺一不可：
/// * `gen_snapshot == gen_current`——期间有过任何焦点事件（重聚焦/再失焦），
///   本计时器让位最新一轮（旧计时器绝不打新状态）；
/// * `!focused`——已重新聚焦即放弃（用户在场）；
/// * `!is_locked`——已锁定（手动/前一轮）不重复锁、不重发事件。
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
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
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
            if auto_lock_should_fire(gen, gen_current, focused, is_locked) {
                if let Some(vault) = app.try_state::<VaultState>() {
                    vault.0.lock();
                    let _ = app.emit("ottr://vault-locked", ());
                    eprintln!("[security] auto-locked after {minutes} min unfocused");
                }
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
    let gen = CLIPBOARD_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        if CLIPBOARD_GEN.load(Ordering::SeqCst) == gen {
            // 只清「本应用最后一次复制」：期间用户复制了别的（本应用再次复制
            // 也会自增 gen），计时器静默让位。外部程序的复制无法感知——已知
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
    }
}
