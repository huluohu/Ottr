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
