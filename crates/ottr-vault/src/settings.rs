//! settings 表访问（T11：主题/语言从 localStorage 迁入 vault，安全配置同表）。
//!
//! 0001 迁移即建表（`value TEXT NOT NULL -- JSON`），此前无访问层——本模块补上。
//! **锁定可读**：settings 是明文面（不经 Cipher），锁定屏要读主题/语言/自动锁定
//! 配置，因此 `connection()` 的锁定不封本模块（锁定语义见 store.rs 模块文档）。
//!
//! 值一律 JSON 序列化落盘（spec §3：settings 存 JSON）；键名由调用方约定
//! （前端当前键面：`ui.theme` / `ui.language` / `security.autolock_minutes` /
//! `security.clipboard_clear_secs`——见 frontend/security 与 desktop security.rs）。

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
// Phase 5 T3 fix round 1（I-1）：校验逻辑自 desktop security.rs **迁入本 crate**
// ——settings 写入（settings_set）与**同步分类导入**（sync_snapshot，快照是
// 跨机/跨版本来源，已知键越界值不得经导入绕过范围检查）两个写入口必须共享
// 同一份注册表；desktop security.rs 的 validate_setting 现为薄委托（re-export
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
/// 录制默认保存目录（空/未设置 = 下载目录 Ottr 录制 兜底；2026-10-12 用户需求）。
pub const SETTING_RECORDING_SAVE_DIR: &str = "recording.saveDir";
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
/// MCP 逐次审批超时（秒）（2026-10-13 用户目标「审批超时策略可配」）：
/// 默认 60；写入范围 10..=600（下限防误触瞬超=变相全拒，上限防占死连接）。
pub const SETTING_MCP_APPROVAL_TIMEOUT: &str = "mcp.approval_timeout_secs";
pub const MCP_APPROVAL_TIMEOUT_MIN_SECS: u64 = 10;
pub const MCP_APPROVAL_TIMEOUT_MAX_SECS: u64 = 600;
/// ⌘R 历史保留行数上限（BL-205①）：滚动窗口按此值裁最旧；默认 =
/// [`crate::history::HISTORY_KEEP_ROWS`]（5 万）。写入范围 100..=1_000_000
/// （下限防 0/极小值把历史清成摆设，上限防误输入把库撑爆）。
pub const SETTING_HISTORY_LIMIT: &str = "history.limit";
pub const HISTORY_LIMIT_MIN: u64 = 100;
pub const HISTORY_LIMIT_MAX: u64 = 1_000_000;
/// AI 单请求 token 上限（Task 13 成本护栏）：写入侧上限 8192（缺省 1024）。
pub const AI_MAX_TOKENS_LIMIT: u64 = 8192;
/// 自动检查更新频率（2026-10-13 用户需求）：off / startup / interval（24h）。
/// 消费方在前端 update/autoCheck.ts；Rust 侧只管写入校验（枚举白名单）。
pub const SETTING_UPDATE_CHECK_MODE: &str = "update.check_mode";
pub const UPDATE_CHECK_MODES: [&str; 3] = ["off", "startup", "interval"];
/// 快捷键覆盖表（2026-10-21 改键设置）：动作 id → 加速串（平台中性
/// `CmdOrCtrl+Shift+K` 形态，CmdOrCtrl 三平台同语义）。消费方在 frontend
/// registry（生效查询）与 desktop menu.rs（mac 菜单重建）；Rust 只管写入
/// 校验（对象形态 / 条数 / 键形 / 加速串形态与修饰键要求）。
pub const SETTING_SHORTCUT_OVERRIDES: &str = "shortcuts.overrides";
pub const SHORTCUT_OVERRIDES_MAX_ENTRIES: usize = 64;

/// 加速串形态校验（shortcuts.overrides 值）：`修饰键(1-3 段) + 单键`；
/// 修饰键白名单 {CmdOrCtrl, Ctrl, Shift, Alt}，**至少一个非 Shift 修饰键**
/// （裸 Shift 键位在输入 anywhere 误触——frontend M-4 纪律同源）；
/// 单键 ≤16 字符、非空（`+` 是分隔符，不可表达）。
fn is_f_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() >= 2
        && (bytes[0] == b'f' || bytes[0] == b'F')
        && bytes[1..].iter().all(|b| b.is_ascii_digit())
        && key[1..]
            .parse::<u8>()
            .map(|n| (1..=24).contains(&n))
            .unwrap_or(false)
}

fn validate_shortcut_accel(accel: &str) -> std::result::Result<(), String> {
    let parts: Vec<&str> = accel.split('+').map(str::trim).collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err(format!(
            "accelerator must be 1-4 `+`-separated parts, got {accel:?}"
        ));
    }
    // 单段 = 纯功能键（注册表先例：app.toggleFullscreen 的 F11）；必须 F 系，
    // 裸字母/数字/符号单段无修饰键照样拒绝（下方 has_real_mod 兜底）。
    // 单段 = 纯功能键（注册表先例：app.toggleFullscreen 的 F11）：F 系放行，
    // 其余单段（裸字母/数字/符号）在下方无修饰键检查中拒绝。
    if parts.len() == 1 && !is_f_key(parts[0]) {
        return Err(format!(
            "single-part accelerator must be an F-key, got {accel:?}"
        ));
    }
    let key = parts[parts.len() - 1];
    if key.is_empty() || key.len() > 16 {
        return Err(format!("accelerator key must be 1-16 chars, got {key:?}"));
    }
    if parts.len() >= 2 {
        let has_real_mod = parts[..parts.len() - 1]
            .iter()
            .any(|p| matches!(*p, "CmdOrCtrl" | "Ctrl" | "Alt"));
        if !has_real_mod {
            return Err(format!(
                "accelerator requires CmdOrCtrl/Ctrl/Alt modifier, got {accel:?}"
            ));
        }
    }
    for part in &parts[..parts.len() - 1] {
        if !matches!(*part, "CmdOrCtrl" | "Ctrl" | "Shift" | "Alt") {
            return Err(format!("unknown accelerator modifier: {part:?}"));
        }
    }
    Ok(())
}

/// [`SETTING_SHORTCUT_OVERRIDES`] 值校验：JSON 对象、≤64 条、键为动作
/// id 形态（大小写字母/数字/点/下划线）、值为合法加速串。未知动作 id 不在此层拒绝（动作表在前端，Rust
/// 不持有副本——坏 id 只是永不命中的死条目，加载侧逐条净化）。
fn validate_shortcut_overrides(value: &serde_json::Value) -> std::result::Result<(), String> {
    let obj = value
        .as_object()
        .ok_or_else(|| format!("{SETTING_SHORTCUT_OVERRIDES} must be a JSON object"))?;
    if obj.len() > SHORTCUT_OVERRIDES_MAX_ENTRIES {
        return Err(format!(
            "{SETTING_SHORTCUT_OVERRIDES} exceeds {SHORTCUT_OVERRIDES_MAX_ENTRIES} entries"
        ));
    }
    for (id, accel) in obj {
        if id.is_empty()
            || id.len() > 64
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(format!(
                "{SETTING_SHORTCUT_OVERRIDES}: bad action id {id:?}"
            ));
        }
        let accel = accel.as_str().ok_or_else(|| {
            format!("{SETTING_SHORTCUT_OVERRIDES}: {id} expects a string accelerator")
        })?;
        validate_shortcut_accel(accel).map_err(|e| format!("{SETTING_SHORTCUT_OVERRIDES}: {e}"))?;
    }
    Ok(())
}

/// 已知 settings 键的写入校验（越界/类型错显式拒绝，不静默收敛——写入侧拒绝
/// 比读取侧收敛更能暴露 bug；读取侧仍收敛兜底，见 desktop security.rs *_from）。
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
        SETTING_MCP_ENABLED => bool_value(key, value),
        SETTING_MCP_APPROVAL_TIMEOUT => {
            let n = value
                .as_u64()
                .ok_or_else(|| format!("expected a non-negative integer, got {value}"))?;
            if !(MCP_APPROVAL_TIMEOUT_MIN_SECS..=MCP_APPROVAL_TIMEOUT_MAX_SECS).contains(&n) {
                return Err(format!(
                    "{SETTING_MCP_APPROVAL_TIMEOUT} must be {}-{}, got {n}",
                    MCP_APPROVAL_TIMEOUT_MIN_SECS, MCP_APPROVAL_TIMEOUT_MAX_SECS
                ));
            }
            Ok(())
        }
        SETTING_SHELL_INTEGRATION => bool_value(key, value),
        // 自动检查更新频率（字符串枚举白名单；非法值显式拒绝）
        SETTING_UPDATE_CHECK_MODE => match value {
            serde_json::Value::String(s) if UPDATE_CHECK_MODES.contains(&s.as_str()) => Ok(()),
            serde_json::Value::String(s) => Err(format!(
                "{SETTING_UPDATE_CHECK_MODE} must be one of {UPDATE_CHECK_MODES:?}, got {s:?}"
            )),
            _ => Err(format!("{SETTING_UPDATE_CHECK_MODE} expects a string")),
        },
        // 录制默认保存目录（字符串路径；空串 = 恢复默认；上限 1024 防误粘）
        SETTING_RECORDING_SAVE_DIR => match value {
            serde_json::Value::String(s) if s.trim().len() <= 1024 => Ok(()),
            serde_json::Value::String(_) => Err(format!(
                "{SETTING_RECORDING_SAVE_DIR} path exceeds 1024 chars"
            )),
            _ => Err(format!("{SETTING_RECORDING_SAVE_DIR} expects a string")),
        },
        SETTING_SHORTCUT_OVERRIDES => validate_shortcut_overrides(value),
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
            // 白名单与前端 THEME_IDS 对齐（2026-10-18 续编 +sepia/forest/ember；
            // 此前仍旧七项——三新主题的持久化与同步导入全被拒）。
            if matches!(
                s,
                "light"
                    | "dark"
                    | "system"
                    | "oled"
                    | "amethyst"
                    | "verdant"
                    | "glass"
                    | "sepia"
                    | "forest"
                    | "ember"
            ) {
                Ok(())
            } else {
                Err(format!(
                    "ui.theme must be light|dark|system|oled|amethyst|verdant|glass|sepia|forest|ember, got {s:?}"
                ))
            }
        }
        "ui.language" => {
            let s = value
                .as_str()
                .ok_or_else(|| "ui.language expects a string".to_string())?;
            // 2026-10-18 完整三语：+zh-Hant（港澳台通用繁体）。
            if matches!(s, "zh-CN" | "zh-Hant" | "en-US") {
                Ok(())
            } else {
                Err(format!(
                    "ui.language must be zh-CN|zh-Hant|en-US, got {s:?}"
                ))
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

    /// 自动检查更新频率（2026-10-13）：三枚举放行，非法串/类型错拒绝
    /// （settings_set 与 sync 分类导入共享本注册表）。
    #[test]
    fn update_check_mode_write_side_validation() {
        let key = SETTING_UPDATE_CHECK_MODE;
        for mode in UPDATE_CHECK_MODES {
            assert!(
                validate_known_setting(key, &serde_json::json!(mode)).is_ok(),
                "合法枚举放行: {mode}"
            );
        }
        assert!(
            validate_known_setting(key, &serde_json::json!("daily")).is_err(),
            "未知枚举拒绝"
        );
        assert!(
            validate_known_setting(key, &serde_json::json!(1)).is_err(),
            "类型错拒绝"
        );
    }

    /// ui.theme 白名单与前端 THEME_IDS 对齐（2026-10-18 续编 +sepia/forest/
    /// ember）；未知主题值仍拒绝。
    #[test]
    fn ui_theme_whitelist_covers_new_theme_ids() {
        for id in [
            "light", "dark", "system", "oled", "amethyst", "verdant", "glass", "sepia", "forest",
            "ember",
        ] {
            assert!(
                validate_known_setting("ui.theme", &serde_json::json!(id)).is_ok(),
                "合法主题 id 放行: {id}"
            );
        }
        for bad in ["solarized", "mono", "", "LIGHT"] {
            assert!(
                validate_known_setting("ui.theme", &serde_json::json!(bad)).is_err(),
                "白名单外主题 id 拒绝: {bad:?}"
            );
        }
        assert!(validate_known_setting("ui.theme", &serde_json::json!(1)).is_err());
    }
}

#[cfg(test)]
mod shortcut_overrides_tests {
    use super::*;

    #[test]
    fn accepts_well_formed_override_map() {
        let v = serde_json::json!({
            "palette.toggle": "CmdOrCtrl+Shift+K",
            "session.splitDown": "Ctrl+Alt+D",
            "view.zoom_in": "F2"
        });
        assert!(validate_known_setting(SETTING_SHORTCUT_OVERRIDES, &v).is_ok());
    }

    #[test]
    fn rejects_bad_shapes_and_values() {
        // 非对象
        assert!(
            validate_known_setting(SETTING_SHORTCUT_OVERRIDES, &serde_json::json!([])).is_err()
        );
        // 键形态（空串非法；大写驼峰是合法动作 id 形态）
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "": "CmdOrCtrl+K" })
            )
            .is_err()
        );
        // 值非串
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": 3 })
            )
            .is_err()
        );
        // 裸 Shift（无非 Shift 修饰键）
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": "Shift+K" })
            )
            .is_err()
        );
        // 裸字母（无修饰键）
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": "K" })
            )
            .is_err()
        );
        // 未知修饰键
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": "Hyper+K" })
            )
            .is_err()
        );
        // `+` 分隔符破碎（空键段）
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": "CmdOrCtrl++" })
            )
            .is_err()
        );
    }

    #[test]
    fn alt_and_fkey_are_valid_no_cmd_modifiers() {
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "palette.toggle": "Alt+K" })
            )
            .is_ok()
        );
        assert!(
            validate_known_setting(
                SETTING_SHORTCUT_OVERRIDES,
                &serde_json::json!({ "app.toggleFullscreen": "F11" })
            )
            .is_ok()
        );
    }
}
