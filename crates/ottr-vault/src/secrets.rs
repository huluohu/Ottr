//! secrets 表访问（Task 13）：AI provider api key 等敏感配置的密封 KV 存储。
//!
//! 与 [`crate::settings`]（明文面、锁定可读）相对：本模块是**密文面**——
//! 读写都要求 Master Key 在内存（`vault.cipher()`，锁定即 [`VaultError::Locked`]）。
//!
//! * 密封：AES-256-GCM，AAD = `secrets:{id}:value`（[`crate::aad`] 约定，
//!   与 `scan_registry` 登记项同源——主密码升级重密封必须逐字节复刻）；
//! * upsert 语义：同 key 覆盖（rowid 不变，AAD 稳定）；覆盖在**单事务**内
//!   完成（先插占位行拿 id 再密封回填，事务保护下不存在半密封窗口）；
//! * `key` 逻辑名约定：`ai.apikey.<providerId>`（前端 provider 删除时连带
//!   `Secrets::delete`，防孤儿密文累积）。

use rusqlite::{params, OptionalExtension};

use crate::{aad, Result, Vault, VaultError};

pub struct Secrets;

impl Secrets {
    /// 写入/覆盖一个密文项（upsert；锁定 → [`VaultError::Locked`]）。
    pub fn set(vault: &Vault, key: &str, plain: &str) -> Result<()> {
        if key.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "secret key must not be empty".into(),
            ));
        }
        let cipher = vault.cipher()?;
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM secrets WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        // upsert 保留原行（rowid/AAD 稳定，created_at 语义=首建时刻）
        let id = match existing {
            Some(id) => id,
            None => {
                // 占位行拿 id（AUTOINCREMENT 分配），同事务内立刻密封回填
                let ts = now_ts();
                tx.execute(
                    "INSERT INTO secrets (key, value_enc, created_at, updated_at)
                     VALUES (?1, zeroblob(1), ?2, ?2)",
                    params![key, ts],
                )?;
                tx.last_insert_rowid()
            }
        };
        let sealed = cipher.seal(plain.as_bytes(), &aad("secrets", id, "value"))?;
        tx.execute(
            "UPDATE secrets SET value_enc = ?1, updated_at = ?2 WHERE id = ?3",
            params![sealed, now_ts(), id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 读一个密文项（明文出库；未设置 → `None`；密文损坏/AAD 换绑 → Crypto 错误）。
    pub fn get(vault: &Vault, key: &str) -> Result<Option<String>> {
        let cipher = vault.cipher()?;
        let conn = vault.connection();
        let row: Option<(i64, Vec<u8>)> = conn
            .query_row(
                "SELECT id, value_enc FROM secrets WHERE key = ?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((id, blob)) = row else {
            return Ok(None);
        };
        let plain = cipher.open(&blob, &aad("secrets", id, "value"))?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| VaultError::Crypto("secret value is not valid utf-8".into()))
    }

    /// 删除一个密文项；未知 key 显式报 [`VaultError::NotFound`]（前端删 provider
    /// 时 key 应当在；不一致即 bug，宁可响）。
    pub fn delete(vault: &Vault, key: &str) -> Result<()> {
        let n = vault
            .connection()
            .execute("DELETE FROM secrets WHERE key = ?1", [key])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("secret key={key}")));
        }
        Ok(())
    }

    /// 是否存在某密文项（不派生明文——设置页「已保存 key」标记用）。
    pub fn contains(vault: &Vault, key: &str) -> Result<bool> {
        let conn = vault.connection();
        let n: i64 = conn.query_row("SELECT count(*) FROM secrets WHERE key = ?1", [key], |r| {
            r.get(0)
        })?;
        Ok(n > 0)
    }
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
