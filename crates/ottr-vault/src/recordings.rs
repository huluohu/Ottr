//! recordings 表访问（Phase 3 Task 5，B3 录制审计回放——存储面）。
//!
//! 录制元数据是**明文面**（0007 history 同一裁定：录制/历史是本地审计数据，
//! 无 `*_enc` 列、不经 AAD 绑定，锁定态照常读写——录制是会话进行中的落盘，
//! 自动锁定不能让它半途丢账）。asciinema 原始流在 .cast 文件（path 列指向，
//! 文件本体不入库）；本表只存元数据 + [`crate::history`] 同款 FTS 检索面。
//!
//! FTS（选型见 0015 迁移文件头）：共享单表 `recordings_fts`（trigram，
//! contentful），content = 录制器剥离 ANSI 后的纯文本，`recording_id`
//! UNINDEXED 列承载归属；AFTER DELETE 触发器保证删行（含 host CASCADE）
//! 即清索引。检索与 [`crate::history::History::search`] 同款分派：≥3 字符
//! MATCH（短语引号包裹防语法注入）、超短 LIKE 兜底（`%_\` 转义），排序
//! id DESC（≈时间倒序），命中带 `snippet()` 高亮（⌘R「录制」页签预览面）。

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::{Result, Vault, VaultError};

/// ⌘R 面板单次搜索/列表返回上限（Tauri 命令面 `limit` 缺省同值）。
pub const RECORDINGS_SEARCH_LIMIT: usize = 50;

/// FTS 索引指针前缀（text_index_path 列 = `{PREFIX}{id}`，0015 选型锚）。
pub const TEXT_INDEX_PREFIX: &str = "recordings_fts:";

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 录制行（serde 面与 `src/vault/api.ts` 的 `RecordingEntry` 同构，snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordingEntry {
    pub id: i64,
    pub host_id: i64,
    /// .cast 文件绝对路径（文件本体不入库）。
    pub path: String,
    /// 秒（浮点，asciinema 事件时间精度；空录制 = 0）。
    pub duration: f64,
    /// FTS 索引指针 `recordings_fts:{id}`。
    pub text_index_path: String,
    /// 秒级 Unix 时间（实体表同口径）。
    pub created_at: i64,
}

/// 搜索命中（列表行 + 命中上下文窗口；空查询 = 开头预览）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordingHit {
    #[serde(flatten)]
    pub entry: RecordingEntry,
    /// 命中词上下文窗口（首现 ±40 字符共 120 字符；⌘R 面板预览面）。
    pub snippet: String,
}

/// 新建录制行的输入（id/created_at/text_index_path 由存储层定）。
#[derive(Debug, Clone, Deserialize)]
pub struct RecordingInput {
    pub host_id: i64,
    pub path: String,
    pub duration: f64,
    /// 剥离 ANSI 后的录制纯文本（空录制 = None/空串——只入元数据不进 FTS）。
    pub text: Option<String>,
}

/// [`RecordingEntry`] 的存储入口。
pub struct Recordings;

impl Recordings {
    /// 落一条录制元数据并返回完整行。事务内三步：行插入 → text_index_path
    /// 回填（`recordings_fts:{id}`，id 插入后才可知）→ FTS 索引（text 非空时）。
    /// host_id 必须指向存在的主机（FK 约束拒绝悬空插入）。
    pub fn insert(vault: &Vault, input: &RecordingInput) -> Result<RecordingEntry> {
        if input.path.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "recording path must not be empty".into(),
            ));
        }
        let conn = vault.connection();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO recordings (host_id, path, duration, text_index_path, created_at)
             VALUES (?1, ?2, ?3, '', ?4)",
            params![input.host_id, input.path, input.duration, now_ts()],
        )?;
        let id = tx.last_insert_rowid();
        let tip = format!("{TEXT_INDEX_PREFIX}{id}");
        tx.execute(
            "UPDATE recordings SET text_index_path = ?1 WHERE id = ?2",
            params![tip, id],
        )?;
        if let Some(text) = input.text.as_deref() {
            if !text.is_empty() {
                tx.execute(
                    "INSERT INTO recordings_fts (content, recording_id) VALUES (?1, ?2)",
                    params![text, id],
                )?;
            }
        }
        tx.commit()?;
        Ok(RecordingEntry {
            id,
            host_id: input.host_id,
            path: input.path.clone(),
            duration: input.duration,
            text_index_path: tip,
            created_at: now_ts(),
        })
    }

    /// 最近录制（⌘R「录制」页签初始态）：id DESC，`host_id` Some → 附加过滤，
    /// `limit` 下限 1（缺省 [`RECORDINGS_SEARCH_LIMIT`]）。
    pub fn list(vault: &Vault, host_id: Option<i64>, limit: usize) -> Result<Vec<RecordingEntry>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare(
            "SELECT * FROM recordings
             WHERE (?1 IS NULL OR host_id = ?1)
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![host_id, limit.max(1) as i64], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 全文检索（⌘R「录制」页签取数面，[`crate::history::History::search`]
    /// 同款分派）：≥3 字符走 recordings_fts MATCH（短语引号包裹），超短
    /// （含空）LIKE 兜底；排序 id DESC。
    ///
    /// 命中上下文（snippet）：
    /// * FTS 分支用 FTS5 `snippet()` aux 函数——6 参签名（fix round 1/5 I-2
    ///   实测定序）：`snippet(table, column, start, end, ellipsis, tokens)`
    ///   （列在前；首轮误按 `(table,start,end,ellipsis,column)` 调用才报
    ///   "wrong number of arguments"）。`tokens=24`（trigram 一 token≈3 字符，
    ///   ≈72 字符上下文）；**大小写不敏感**（trigram 缺省 case-folding——
    ///   instr 窗口做不到的，这正是改回的理由）。
    /// * LIKE 分支（超短查询/空查询）不能用 snippet()——aux 函数要求 MATCH
    ///   上下文；退 instr 定位窗口（大小写敏感，但该分支只服务 <3 字符探针
    ///   与「最近录制」预览态，非检索主路径）。
    pub fn search(
        vault: &Vault,
        query: &str,
        host_id: Option<i64>,
        limit: usize,
    ) -> Result<Vec<RecordingHit>> {
        let q = query.trim();
        let like_snip = "substr(recordings_fts.content,
                     max(1, ifnull(instr(recordings_fts.content, :raw), 0) - 40), 120) AS snip";
        let (match_val, sql): (String, &str) = if q.chars().count() >= 3 {
            (
                match_query(q),
                "SELECT r.*,
                 snippet(recordings_fts, 0, '[', ']', '…', 24) AS snip
                 FROM recordings_fts JOIN recordings r ON r.id = recordings_fts.recording_id
                 WHERE recordings_fts MATCH :match
                   AND (:host IS NULL OR r.host_id = :host)
                 ORDER BY r.id DESC LIMIT :limit",
            )
        } else {
            (
                format!("%{}%", escape_like(q)),
                "SELECT r.*, {like_snip}
                 FROM recordings_fts JOIN recordings r ON r.id = recordings_fts.recording_id
                 WHERE recordings_fts.content LIKE :match ESCAPE '\\'
                   AND (:host IS NULL OR r.host_id = :host)
                 ORDER BY r.id DESC LIMIT :limit",
            )
        };
        let sql = sql.replace("{like_snip}", like_snip);
        let limit_i64 = limit.max(1) as i64;
        // 两分支参数面不同：FTS 分支的 snippet() 是列内函数，不吃 :raw
        // （rusqlite 对「绑定但未使用」的具名参数报 InvalidParameterName），
        // 故按分支装配——与 history.rs 的「单组参数」纪律在此分叉（参数面
        // 真实不同，硬凑单组反而引入死参数）。
        let conn = vault.connection();
        let mut stmt = conn.prepare(&sql)?;
        let rows = if q.chars().count() >= 3 {
            let args: [(&str, &dyn rusqlite::ToSql); 3] = [
                (":match", &match_val),
                (":host", &host_id),
                (":limit", &limit_i64),
            ];
            stmt.query_map(args.as_slice(), |row| {
                Ok(RecordingHit {
                    entry: row_to_entry(row)?,
                    snippet: row.get("snip")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            let args: [(&str, &dyn rusqlite::ToSql); 4] = [
                (":match", &match_val),
                (":host", &host_id),
                (":limit", &limit_i64),
                (":raw", &q),
            ];
            stmt.query_map(args.as_slice(), |row| {
                Ok(RecordingHit {
                    entry: row_to_entry(row)?,
                    snippet: row.get("snip")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    /// 按 id 取单条（回放/导出取 path 面；不存在 = None）。
    pub fn get(vault: &Vault, id: i64) -> Result<Option<RecordingEntry>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare("SELECT * FROM recordings WHERE id = ?1")?;
        let row = stmt.query_row(params![id], row_to_entry).optional()?;
        Ok(row)
    }

    /// 删除一行（FK CASCADE 与 AFTER DELETE 触发器各自接管从属清理；.cast
    /// 文件删除在命令层）。删除不存在的 id → [`VaultError::NotFound`]。
    pub fn delete(vault: &Vault, id: i64) -> Result<()> {
        let conn = vault.connection();
        let n = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(VaultError::NotFound(format!("recording id={id}")));
        }
        Ok(())
    }
}

/// FTS MATCH 查询词：短语引号包裹（内部 `"` 翻倍）——history.rs 同款语义，
/// 单点复刻避免跨模块 pub 面。
fn match_query(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// LIKE 兜底的通配转义——history.rs 同款语义。
fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn row_to_entry(row: &Row) -> rusqlite::Result<RecordingEntry> {
    Ok(RecordingEntry {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        path: row.get("path")?,
        duration: row.get("duration")?,
        text_index_path: row.get("text_index_path")?,
        created_at: row.get("created_at")?,
    })
}
