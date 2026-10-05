//! settings 表访问（T11：主题/语言从 localStorage 迁入 vault，安全配置同表）。
//!
//! 0001 迁移即建表（`value TEXT NOT NULL -- JSON`），此前无访问层——本模块补上。
//! **锁定可读**：settings 是明文面（不经 Cipher），锁定屏要读主题/语言/自动锁定
//! 配置，因此 `connection()` 的锁定不封本模块（锁定语义见 store.rs 模块文档）。
//!
//! 值一律 JSON 序列化落盘（spec §3：settings 存 JSON）；键名由调用方约定
//! （前端当前键面：`ui.theme` / `ui.language` / `security.autolock_minutes` /
//! `security.clipboard_clear_secs`——见 src/security 与 src-tauri security.rs）。

use rusqlite::OptionalExtension;

use crate::{Result, Vault};

pub struct Settings;

impl Settings {
    /// 读一个设置项（JSON 值；未设置 → `None`）。损坏 JSON 显式报错（同 meta 纪律，
    /// 不静默吞成 None——那会把配置错误伪装成「未配置」）。
    pub fn get(vault: &Vault, key: &str) -> Result<Option<serde_json::Value>> {
        let conn = vault.connection();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        match raw {
            None => Ok(None),
            Some(s) => serde_json::from_str(&s).map(Some).map_err(Into::into),
        }
    }

    /// 写一个设置项（JSON 值；upsert）。
    pub fn set(vault: &Vault, key: &str, value: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string(value)?;
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, json],
        )?;
        Ok(())
    }

    /// 字符串便捷读（JSON string 值；类型不符/未设置 → `None`）。
    pub fn get_str(vault: &Vault, key: &str) -> Result<Option<String>> {
        Ok(Self::get(vault, key)?.and_then(|v| v.as_str().map(Into::into)))
    }

    /// 字符串便捷写。
    pub fn set_str(vault: &Vault, key: &str, value: &str) -> Result<()> {
        Self::set(vault, key, &serde_json::Value::String(value.into()))
    }

    /// 数值便捷读（JSON number；类型不符/未设置 → `None`）。
    pub fn get_u64(vault: &Vault, key: &str) -> Result<Option<u64>> {
        Ok(Self::get(vault, key)?.and_then(|v| v.as_u64()))
    }

    /// 数值便捷写。
    pub fn set_u64(vault: &Vault, key: &str, value: u64) -> Result<()> {
        Self::set(vault, key, &serde_json::Value::from(value))
    }
}

// --- 已知 settings 键注册表 + 写入校验（单一事实源）-----------------------------
//
// Phase 5 T3 fix round 1（I-1）：校验逻辑自 src-tauri security.rs **迁入本 crate**
// ——settings 写入（settings_set）与**同步分类导入**（sync_snapshot，快照是
// 跨机/跨版本来源，已知键越界值不得经导入绕过范围检查）两个写入口必须共享
// 同一份注册表；src-tauri security.rs 的 validate_setting 现为薄委托（re-export
// 常量保持既有引用路径不变）。
//
// 注册纪律：新增已知键必须在本 match 登记——漏登 = 该键经 sync 导入绕过范围
// 校验（settings_set 有校验而导入无，防线单侧）。

/// 自动锁定默认分钟数（简报定值 10）。
pub const AUTOLOCK_DEFAULT_MINUTES: u64 = 10;
/// 自动锁定上限（1 天；防误输入把锁拖成装饰）。
pub const AUTOLOCK_MAX_MINUTES: u64 = 24 * 60;
/// 剪贴板清空默认秒数（简报定值 30）。
pub const CLIPBOARD_DEFAULT_SECS: u64 = 30;
/// 剪贴板清空上限（1 小时）。
pub const CLIPBOARD_MAX_SECS: u64 = 3600;

/// shell 集成自动注入开关（Task 15 fix 1/5，⌘R 历史入库的数据源）。
pub const SETTING_SHELL_INTEGRATION: &str = "shell.integration";
pub const SETTING_AUTOLOCK: &str = "security.autolock_minutes";
pub const SETTING_CLIPBOARD: &str = "security.clipboard_clear_secs";
/// 监控采样间隔（Phase 3 Task 1，B4）：默认 5s（简报定值），上限 1h；下限 1s。
pub const SETTING_MONITOR_INTERVAL: &str = "monitor.interval_secs";
pub const MONITOR_INTERVAL_DEFAULT_SECS: u64 = 5;
pub const MONITOR_INTERVAL_MAX_SECS: u64 = 3600;
/// 主机指纹巡检开关/间隔（Phase 3 Task 6，B9 收口）：默认关、间隔默认 24h。
pub const SETTING_HOSTKEY_AUDIT: &str = "security.hostkey_audit_enabled";
pub const SETTING_HOSTKEY_AUDIT_INTERVAL: &str = "security.hostkey_audit_interval_secs";
pub const HOSTKEY_AUDIT_INTERVAL_DEFAULT_SECS: u64 = 24 * 3600;
pub const HOSTKEY_AUDIT_INTERVAL_MIN_SECS: u64 = 60;
pub const HOSTKEY_AUDIT_INTERVAL_MAX_SECS: u64 = 7 * 24 * 3600;
/// sudo 密码自动填充开关（Phase 3 Task 6，B9）：默认关（安全敏感）。
pub const SETTING_SUDO_AUTOFILL: &str = "security.sudo_autofill";
/// MCP server 总开关（Phase 4 Task 3，C1）：默认关。
pub const SETTING_MCP_ENABLED: &str = "mcp.enabled";
/// ⌘R 历史保留行数上限（BL-205①）：滚动窗口按此值裁最旧；默认 =
/// [`crate::history::HISTORY_KEEP_ROWS`]（5 万）。写入范围 100..=1_000_000
/// （下限防 0/极小值把历史清成摆设，上限防误输入把库撑爆）。
pub const SETTING_HISTORY_LIMIT: &str = "history.limit";
pub const HISTORY_LIMIT_MIN: u64 = 100;
pub const HISTORY_LIMIT_MAX: u64 = 1_000_000;
/// AI 单请求 token 上限（Task 13 成本护栏）：写入侧上限 8192（缺省 1024）。
pub const AI_MAX_TOKENS_LIMIT: u64 = 8192;

/// 已知 settings 键的写入校验（越界/类型错显式拒绝，不静默收敛——写入侧拒绝
/// 比读取侧收敛更能暴露 bug；读取侧仍收敛兜底，见 src-tauri security.rs *_from）。
/// 未注册键放行（settings 表是通用配置面，未知键无法校验也不挡）。
pub fn validate_known_setting(
    key: &str,
    value: &serde_json::Value,
) -> std::result::Result<(), String> {
    fn u64_in_range(value: &serde_json::Value, max: u64) -> std::result::Result<(), String> {
        let n = value
            .as_u64()
            .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
        if n > max {
            return Err(format!("value {n} exceeds limit {max}"));
        }
        Ok(())
    }
    fn bool_value(key: &str, value: &serde_json::Value) -> std::result::Result<(), String> {
        if value.is_boolean() {
            Ok(())
        } else {
            Err(format!("{key} expects a boolean"))
        }
    }
    match key {
        SETTING_AUTOLOCK => u64_in_range(value, AUTOLOCK_MAX_MINUTES),
        SETTING_CLIPBOARD => u64_in_range(value, CLIPBOARD_MAX_SECS),
        // Phase 3 Task 1：监控采样间隔（1-3600s）
        SETTING_MONITOR_INTERVAL => {
            let n = value
                .as_u64()
                .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
            if n == 0 || n > MONITOR_INTERVAL_MAX_SECS {
                return Err(format!(
                    "monitor.interval_secs must be 1-{MONITOR_INTERVAL_MAX_SECS}, got {n}"
                ));
            }
            Ok(())
        }
        SETTING_SHELL_INTEGRATION => bool_value(key, value),
        // B9（Phase 3 Task 6）：指纹巡检开关/间隔 + sudo 自动填充开关
        SETTING_HOSTKEY_AUDIT => bool_value(key, value),
        SETTING_HOSTKEY_AUDIT_INTERVAL => {
            let n = value
                .as_u64()
                .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
            if !(HOSTKEY_AUDIT_INTERVAL_MIN_SECS..=HOSTKEY_AUDIT_INTERVAL_MAX_SECS).contains(&n) {
                return Err(format!(
                    "security.hostkey_audit_interval_secs must be {}-{}, got {n}",
                    HOSTKEY_AUDIT_INTERVAL_MIN_SECS, HOSTKEY_AUDIT_INTERVAL_MAX_SECS
                ));
            }
            Ok(())
        }
        SETTING_SUDO_AUTOFILL => bool_value(key, value),
        // C1（Phase 4 Task 3）：MCP server 总开关（布尔；默认关）
        SETTING_MCP_ENABLED => bool_value(key, value),
        // BL-205①：⌘R 历史保留行数上限（100..=1_000_000，见常量处注释）
        SETTING_HISTORY_LIMIT => {
            let n = value
                .as_u64()
                .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
            if !(HISTORY_LIMIT_MIN..=HISTORY_LIMIT_MAX).contains(&n) {
                return Err(format!(
                    "{SETTING_HISTORY_LIMIT} must be {HISTORY_LIMIT_MIN}-{HISTORY_LIMIT_MAX}, got {n}"
                ));
            }
            Ok(())
        }
        // Task 13：AI 成本护栏（单请求 max_tokens 上限）与诊断自动触发开关
        "ai.max_tokens" => u64_in_range(value, AI_MAX_TOKENS_LIMIT),
        "ai.enabled" => bool_value(key, value),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// BL-205①（TDD 红）：history.limit 写入侧校验——范围内放行，越界/类型错
    /// 显式拒绝（settings_set 与 sync 分类导入共享本注册表，导入侧不得绕过）。
    #[test]
    fn history_limit_write_side_validation() {
        let key = SETTING_HISTORY_LIMIT;
        assert!(
            validate_known_setting(key, &serde_json::json!(HISTORY_LIMIT_MIN)).is_ok(),
            "下限边界放行"
        );
        assert!(validate_known_setting(key, &serde_json::json!(50_000)).is_ok());
        assert!(
            validate_known_setting(key, &serde_json::json!(HISTORY_LIMIT_MAX)).is_ok(),
            "上限边界放行"
        );
        assert!(
            validate_known_setting(key, &serde_json::json!(0)).is_err(),
            "低于下限拒绝（0/极小值把历史清成摆设）"
        );
        assert!(
            validate_known_setting(key, &serde_json::json!(HISTORY_LIMIT_MAX + 1)).is_err(),
            "超上限拒绝（防误输入把库撑爆）"
        );
        assert!(
            validate_known_setting(key, &serde_json::json!(-1)).is_err(),
            "负数拒绝（非非负整数）"
        );
        assert!(
            validate_known_setting(key, &serde_json::json!("many")).is_err(),
            "类型错拒绝"
        );
    }
}
