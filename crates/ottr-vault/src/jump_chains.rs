//! jump_chains 表访问（Phase 2 Task 2，spec §3 B7 下半：跳板链）。
//!
//! 明文配置面（0009 迁移文件头）：无 `*_enc` 列、不经 AAD 绑定、不涉
//! scan_registry；锁定语义与 hosts 同（命令面统一 `ensure_unlocked` 门卫）。
//!
//! `hops` 列 = JSON 数组（host_id 有序序列，serde 直通）：顺序即连接序——
//! hops[0] 本地直连，hops[i] 经 hops[i-1] 的 direct-tcpip 隧道（Phase 0
//! jump.rs 拓扑），target = 引用本链的 hosts 行（连接侧解析，见
//! src-tauri commands/jump.rs）。反向链与正向链是**不同的链**。
//!
//! FK 语义由存储层承担（0009 偏差记录，SQLite 无法对既有列补 REFERENCES）：
//! * create/update 校验 hops 非空、无重复、指向的主机存在（= FK 存在性），
//!   且与写入同事务（M-4 fix：消除「校验通过后、写入前主机被并发删除」的
//!   悬空窗口）；
//! * delete 在事务内把引用该链的 hosts.jump_chain_id 置 NULL（= SET NULL）；
//! * [`remove_host_from_chains`]（Hosts::delete 调用，I-1 fix）：删 hop 主机时
//!   从各链 hops 中移除该 id（链因此变空 → 级联删链并解绑引用主机——空链无
//!   跳板意义，且解绑让引用主机回退直连而不是报 hop not found）。

use rusqlite::OptionalExtension;
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 一条跳板链（serde 面与前端 `JumpChain` 同构，snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JumpChain {
    pub id: i64,
    pub name: String,
    /// host_id 有序数组：顺序即连接序（末位之后接 target）。
    pub hops: Vec<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 新建/全量更新跳板链的输入（id/ts 由存储层定）。
#[derive(Debug, Clone, Deserialize)]
pub struct JumpChainInput {
    pub name: String,
    pub hops: Vec<i64>,
}

/// [`JumpChain`] 的存储入口。
pub struct JumpChains;

impl JumpChains {
    /// 校验（FK 语义的存储层承担面）：名字非空白；hop 非空、无重复、
    /// 指向的主机存在。返回去空白后的名字。
    /// `conn` 由调用方传入事务连接（M-4 fix：校验与写入同事务）。
    fn validate(conn: &rusqlite::Connection, input: &JumpChainInput) -> Result<String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(VaultError::InvalidInput(
                "jump chain name must not be empty".into(),
            ));
        }
        if input.hops.is_empty() {
            return Err(VaultError::InvalidInput(
                "jump chain must contain at least one hop".into(),
            ));
        }
        let mut seen = std::collections::HashSet::with_capacity(input.hops.len());
        for &host_id in &input.hops {
            if !seen.insert(host_id) {
                return Err(VaultError::InvalidInput(format!(
                    "jump chain has duplicate hop host id={host_id}"
                )));
            }
            let exists: Option<i64> = conn
                .query_row("SELECT id FROM hosts WHERE id = ?1", [host_id], |r| {
                    r.get(0)
                })
                .optional()?;
            if exists.is_none() {
                return Err(VaultError::InvalidInput(format!(
                    "jump chain hop host id={host_id} does not exist"
                )));
            }
        }
        Ok(name.into())
    }

    pub fn create(vault: &Vault, input: &JumpChainInput) -> Result<JumpChain> {
        let ts = now_ts();
        let conn = vault.connection();
        // 校验 + 写入同一事务（M-4 fix）：校验通过后主机被并发删除的窗口内
        // 写入会整体回滚，不会留下指向不存在主机的链行。
        let tx = conn.unchecked_transaction()?;
        let name = Self::validate(&tx, input)?;
        tx.execute(
            "INSERT INTO jump_chains (name, hops, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
            params![name, serde_json::to_string(&input.hops)?, ts],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(JumpChain {
            id,
            name,
            hops: input.hops.clone(),
            created_at: ts,
            updated_at: ts,
        })
    }

    /// 全量替换式更新（name/hops 同提交）；updated_at 刷新、created_at 保留。
    /// 校验 + 写入同一事务（M-4 fix，同 create）。
    pub fn update(vault: &Vault, id: i64, input: &JumpChainInput) -> Result<JumpChain> {
        let ts = now_ts();
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let name = Self::validate(&tx, input)?;
        let created_at: i64 = tx
            .query_row(
                "SELECT created_at FROM jump_chains WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("jump_chain id={id}")))?;
        tx.execute(
            "UPDATE jump_chains SET name = ?1, hops = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, serde_json::to_string(&input.hops)?, ts, id],
        )?;
        tx.commit()?;
        Ok(JumpChain {
            id,
            name,
            hops: input.hops.clone(),
            created_at,
            updated_at: ts,
        })
    }

    /// 删链 + 解绑引用主机（= ON DELETE SET NULL 的存储层等价物；事务保证
    /// 「删链」与「解绑」原子——中断不会留下悬空引用）。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let n = tx.execute("DELETE FROM jump_chains WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("jump_chain id={id}")));
        }
        tx.execute(
            "UPDATE hosts SET jump_chain_id = NULL, updated_at = updated_at
             WHERE jump_chain_id = ?1",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn get(vault: &Vault, id: i64) -> Result<Option<JumpChain>> {
        let conn = vault.connection();
        conn.query_row(
            "SELECT * FROM jump_chains WHERE id = ?1",
            [id],
            row_to_chain,
        )
        .optional()
        .map_err(Into::into)
    }

    /// 全量列表（id 升序 = 创建序；链数量级小，按主机过滤走内存筛选）。
    pub fn list(vault: &Vault) -> Result<Vec<JumpChain>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM jump_chains ORDER BY id")?;
        let rows = stmt
            .query_map([], row_to_chain)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

/// 删 hop 主机时的 FK 反向补偿（I-1 fix；`Hosts::delete` 在**同一事务**内
/// 调用）：把 `host_id` 从所有链的 hops 中移除——
/// * 链仍有余跳 → 原链保留、hops 更新（updated_at 前进；跳序中该 id 直接
///   摘除，其余相对顺序不变）；
/// * 链因此变空 → **级联删链** + 解绑引用该链的主机（`jump_chain_id` 置 NULL，
///   与 [`JumpChains::delete`] 同语义）。空链无跳板意义（评审推荐 a+级联）；
///   解绑让引用主机回退**直连**而不是连接时报 `hop not found`。
pub(crate) fn remove_host_from_chains(tx: &rusqlite::Transaction, host_id: i64) -> Result<()> {
    let mut stmt = tx.prepare("SELECT id, hops FROM jump_chains")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>("id")?, r.get::<_, String>("hops")?))
        })?
        .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
    drop(stmt);
    let ts = now_ts();
    for (chain_id, hops_json) in rows {
        // hops 列损坏 → Json 错误穿透，调用方事务回滚（主机不删，安全侧）。
        let hops: Vec<i64> = serde_json::from_str(&hops_json).map_err(VaultError::Json)?;
        if !hops.contains(&host_id) {
            continue;
        }
        let remaining: Vec<i64> = hops.into_iter().filter(|h| *h != host_id).collect();
        if remaining.is_empty() {
            // 级联删链 + 解绑引用主机（空链不保留；与删链路径同一解绑语义）。
            tx.execute("DELETE FROM jump_chains WHERE id = ?1", [chain_id])?;
            tx.execute(
                "UPDATE hosts SET jump_chain_id = NULL WHERE jump_chain_id = ?1",
                [chain_id],
            )?;
        } else {
            tx.execute(
                "UPDATE jump_chains SET hops = ?1, updated_at = ?2 WHERE id = ?3",
                params![serde_json::to_string(&remaining)?, ts, chain_id],
            )?;
        }
    }
    Ok(())
}

fn row_to_chain(row: &Row) -> rusqlite::Result<JumpChain> {
    let hops_json: String = row.get("hops")?;
    Ok(JumpChain {
        id: row.get("id")?,
        name: row.get("name")?,
        hops: serde_json::from_str(&hops_json).map_err(|e| {
            // JSON 列损坏显式报错不静默（同 tags 列的外部改写防御口径）。
            rusqlite::Error::FromSqlConversionFailure(
                row.as_ref().column_index("hops").unwrap_or(0),
                rusqlite::types::Type::Text,
                format!("malformed jump chain hops json: {e}").into(),
            )
        })?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
