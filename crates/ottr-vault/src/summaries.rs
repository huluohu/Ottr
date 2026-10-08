//! session_summaries 表访问（Phase 2 Task 7，B1 会话纪要）。
//!
//! 纪要 = 会话命令序列（history 同 session_id 行）的 AI 单轮摘要。内容含命令
//! 面（潜在敏感）→ **密文面**：summary 经 AES-256-GCM 密封落 `summary_enc`
//! （AAD = `session_summaries:{id}:summary`，[`crate::aad`] 唯一构造点，与
//! `scan_registry` 登记项同源——主密码升级重密封必须逐字节复刻），锁定即拒
//! （[`Vault::cipher`] → [`VaultError::Locked`]），与 secrets 同一锁定语义。
//!
//! upsert 语义（重连会话多次收尾）：同 (host_id, session_id) 只保留一行——
//! 手动断开后再连再用再断开，后一次纪要覆盖前一次（覆盖会话全程），rowid/AAD
//! 稳定（secrets.rs「占位行拿 id + 同事务密封回填」同款，无半密封窗口）。
//!
//! 列表（⌘R 纪要页签取数面）：id DESC（AUTOINCREMENT ≈ 时间倒序，最近优先），
//! 可选 host 过滤（host_id 最左前缀走唯一索引）。

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError, aad};

/// ⌘R 纪要页签单次返回上限（Tauri 命令面 `limit` 缺省同值）。
pub const SUMMARIES_LIST_LIMIT: usize = 50;

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 纪要行（serde 面与 `src/vault/api.ts` 的 `SummaryEntry` 同构，snake_case；
/// `summary` 为开封后的明文——密文只在 `summary_enc` 列，出库即开）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SummaryEntry {
    pub id: i64,
    pub host_id: i64,
    pub session_id: String,
    pub summary: String,
    /// 摘要覆盖的命令条数（面板徽标 + 溯源面）。
    pub command_count: i64,
    /// 秒级 Unix 时间（upsert 时 = 最新一次生成时刻）。
    pub ts: i64,
}

/// 新建/覆盖纪要的输入（ts/id 由存储层定）。
#[derive(Debug, Clone, Deserialize)]
pub struct SummaryInput {
    pub host_id: i64,
    pub session_id: String,
    pub summary: String,
    pub command_count: i64,
}

/// [`SummaryEntry`] 的存储入口。
pub struct SessionSummaries;

impl SessionSummaries {
    /// 写入一条纪要（同 (host_id, session_id) upsert；锁定 →
    /// [`VaultError::Locked`]）。host_id 必须指向存在的主机（FK 拒绝悬空插入
    /// ——CASCADE 只管删主机联动删纪要）。session_id / summary 空白、
    /// command_count 负数 → [`VaultError::InvalidInput`]。
    pub fn insert(vault: &Vault, input: &SummaryInput) -> Result<SummaryEntry> {
        if input.session_id.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "summary session id must not be empty".into(),
            ));
        }
        if input.summary.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "summary text must not be empty".into(),
            ));
        }
        if input.command_count < 0 {
            return Err(VaultError::InvalidInput(
                "summary command count must not be negative".into(),
            ));
        }
        let cipher = vault.cipher()?;
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        let ts = now_ts();
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM session_summaries WHERE host_id = ?1 AND session_id = ?2",
                params![input.host_id, input.session_id],
                |r| r.get(0),
            )
            .optional()?;
        // upsert 保留原行（rowid/AAD 稳定，首建时刻随 ts 刷新语义=最新生成）
        let id = match existing {
            Some(id) => id,
            None => {
                // 占位行拿 id（AUTOINCREMENT 分配），同事务内立刻密封回填
                tx.execute(
                    "INSERT INTO session_summaries
                         (host_id, session_id, summary_enc, command_count, ts)
                     VALUES (?1, ?2, zeroblob(1), ?3, ?4)",
                    params![input.host_id, input.session_id, input.command_count, ts],
                )?;
                tx.last_insert_rowid()
            }
        };
        let sealed = cipher.seal(
            input.summary.as_bytes(),
            &aad("session_summaries", id, "summary"),
        )?;
        tx.execute(
            "UPDATE session_summaries
             SET summary_enc = ?1, command_count = ?2, ts = ?3 WHERE id = ?4",
            params![sealed, input.command_count, ts, id],
        )?;
        tx.commit()?;
        Ok(SummaryEntry {
            id,
            host_id: input.host_id,
            session_id: input.session_id.clone(),
            summary: input.summary.clone(),
            command_count: input.command_count,
            ts,
        })
    }

    /// 纪要列表（逐行开封；`host_id` Some → 主机过滤；排序 id DESC，`limit` 下限 1）。
    pub fn list(vault: &Vault, host_id: Option<i64>, limit: usize) -> Result<Vec<SummaryEntry>> {
        let cipher = vault.cipher()?;
        let conn = vault.connection();
        let mut stmt = conn.prepare(
            "SELECT id, host_id, session_id, summary_enc, command_count, ts
             FROM session_summaries
             WHERE (?1 IS NULL OR host_id = ?1)
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![host_id, limit.max(1) as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (id, host_id, session_id, blob, command_count, ts) in rows {
            let plain = cipher.open(&blob, &aad("session_summaries", id, "summary"))?;
            let summary = String::from_utf8(plain)
                .map_err(|_| VaultError::Crypto("summary is not valid utf-8".into()))?;
            out.push(SummaryEntry {
                id,
                host_id,
                session_id,
                summary,
                command_count,
                ts,
            });
        }
        Ok(out)
    }
}
