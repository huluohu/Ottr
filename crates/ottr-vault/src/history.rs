//! history 表访问（Task 15，spec §5 文本层消费方③：统一历史搜索）。
//!
//! 命令历史是**明文面**：无任何密钥材料（无 `*_enc` 列、不经 AAD 绑定），
//! 锁定态照常读写（与 notifications/settings 同一锁定语义，见 store.rs 模块
//! 文档「锁定语义」）——自动锁定后正在跑的会话命令照常完成、照常入库，
//! 绝不因锁定静默丢历史。脱敏不在历史层做（spec 定案：历史是本地数据）。
//!
//! 写入路径（简报裁定）：前端 CommandWatch（xterm OSC133 监听）在命令完成
//! 事件里 invoke `history_insert`——Rust 侧不做第二条 OSC 解析管线（T13 评审
//! 裁定：xterm 侧解析可用，能复用就复用）。逐条 insert（SQLite 本地写毫秒级，
//! 前端 async fire-and-forget 不阻塞终端）。
//!
//! 检索（spec §3 CJK 约束）：与 [`crate::entities::Hosts::search`] 同款分派——
//! 空查询返回最近记录（⌘R 面板初始态）；≥3 字符走 history_fts MATCH（短语
//! 引号包裹防 FTS 语法注入）；<3 字符 LIKE 兜底（`%_\` 转义）。排序差异刻意
//! 为之：hosts 按 bm25 相关度，history 按 id 倒序（AUTOINCREMENT ≈ 时间序）——
//! 「在哪跑过 docker logs」要的是最近一次，不是最相关一次。
//!
//! 保留上限（简报「简单 LITE 策略」）：滚动窗口，每次 insert 顺手清理超限
//! 旧行——`id <= max(id) - KEEP` 的范围删除在 rowid b-tree 上未超限时是
//! O(log n) 空扫，超限时一次删一批（无 COUNT 全表扫、无独立清理任务）。
//! KEEP 由 settings 键 `history.limit` 可配（BL-205①）：默认
//! [`HISTORY_KEEP_ROWS`]，读取侧收敛见 [`history_limit_from`]；写入侧越界
//! 由 validate_known_setting 拒绝（settings_set 与 sync 导入同一注册表）。

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};

use crate::settings::{Settings, HISTORY_LIMIT_MAX, HISTORY_LIMIT_MIN, SETTING_HISTORY_LIMIT};
use crate::{Result, Vault, VaultError};

/// 保留的最近历史行数（简报定值：默认 5 万；BL-205① 起 settings 键
/// `history.limit` 可配，本常量为未配置/坏值时的回落默认）。
pub const HISTORY_KEEP_ROWS: i64 = 50_000;

/// BL-205① history.limit 读取侧收敛（src-tauri security.rs *_from 同语义）：
/// 未设置/类型错/越界/读取失败一律回落默认 [`HISTORY_KEEP_ROWS`]。写入侧
/// （settings_set 与 sync 分类导入共享 validate_known_setting）已拒绝越界，
/// 这里兜外部直写/旧库坏值——配置错误不挡历史入库（读取失败安全侧不断链）。
///
/// 锁纪律：本函数内部取 `vault.connection()`——**调用方不得在持有
/// connection() 守卫期间调用**（同线程 Mutex 二次加锁死锁，store.rs with_conn
/// 注记的 T8 同款根因）；`History::insert` 先读本函数再开连接。
pub fn history_limit_from(vault: &Vault) -> i64 {
    match Settings::get_u64(vault, SETTING_HISTORY_LIMIT) {
        Ok(Some(n)) if (HISTORY_LIMIT_MIN..=HISTORY_LIMIT_MAX).contains(&n) => n as i64,
        _ => HISTORY_KEEP_ROWS,
    }
}

/// ⌘R 面板单次搜索返回上限（Tauri 命令面 `limit` 缺省同值）。
pub const HISTORY_SEARCH_LIMIT: usize = 50;

/// 会话命令序列取数上限（Task 7 纪要数据源；prompt 体量护栏——超长会话只
/// 摘要最近 N 条，id DESC 取尾再反转为时序）。
pub const HISTORY_SESSION_LIMIT: usize = 200;

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 历史行（serde 面与 `src/vault/api.ts` 的 `HistoryEntry` 同构，snake_case）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub host_id: i64,
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i64>,
    pub session_id: Option<String>,
    /// 秒级 Unix 时间（实体表同口径）。
    pub ts: i64,
}

/// 新建历史行的输入（ts 由存储层定；command 非空校验在存储层）。
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryInput {
    pub host_id: i64,
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i64>,
    pub session_id: Option<String>,
}

/// [`HistoryEntry`] 的存储入口。
pub struct History;

impl History {
    /// 落一条命令历史并返回完整行（id/ts 由存储层定）；随后顺手执行滚动清理
    /// （超上限的旧行一次删尽；上限 = `history.limit` 配置，未配置/坏值回落
    /// [`HISTORY_KEEP_ROWS`]，见 [`history_limit_from`]）。host_id 必须指向
    /// 存在的主机（FK 约束拒绝悬空插入——CASCADE 只管删主机联动删历史）。
    /// command 空白 → [`VaultError::InvalidInput`]（提示符噪声/纯回车在调用方
    /// 已滤，这里是兜底）。
    pub fn insert(vault: &Vault, input: &HistoryInput) -> Result<HistoryEntry> {
        if input.command.trim().is_empty() {
            return Err(VaultError::InvalidInput(
                "history command must not be empty".into(),
            ));
        }
        let ts = now_ts();
        // 锁纪律（见 history_limit_from）：先读上限再开连接——insert 持有
        // connection() 守卫期间不得二次调用任何会取锁的高层方法。
        let keep = history_limit_from(vault);
        let conn = vault.connection();
        conn.execute(
            "INSERT INTO history (host_id, command, cwd, exit_code, session_id, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.host_id,
                input.command,
                input.cwd,
                input.exit_code,
                input.session_id,
                ts
            ],
        )?;
        let id = conn.last_insert_rowid();
        Self::prune_conn(&conn, keep)?;
        Ok(HistoryEntry {
            id,
            host_id: input.host_id,
            command: input.command.clone(),
            cwd: input.cwd.clone(),
            exit_code: input.exit_code,
            session_id: input.session_id.clone(),
            ts,
        })
    }

    /// 滚动清理：保留最近 `keep` 条（id 单调递增，max(id)-keep 以下的整段
    /// 一次删尽；FTS 同步由 history_fts_ad 触发器承接）。
    fn prune_conn(conn: &rusqlite::Connection, keep: i64) -> Result<()> {
        conn.execute(
            "DELETE FROM history WHERE id <= (SELECT max(id) FROM history) - ?1",
            params![keep],
        )?;
        Ok(())
    }

    /// 统一搜索（⌘R 面板取数面）。
    ///
    /// * `query` 空白 → 忽略（返回最近记录）；`host_id` Some → 附加主机过滤；
    /// * ≥3 字符（按字符数，CJK 同权重）→ history_fts MATCH（短语引号包裹）；
    /// * <3 字符 → command LIKE 兜底（`%_\` 转义）；
    /// * 排序一律 id DESC（≈时间倒序，最近优先），`limit` 下限 1。
    ///
    /// 参数纪律：只有两条 SQL（FTS / LIKE），共用同一组具名占位符（`:match`
    /// `:host` `:limit`，两条全都出现）+ 同一组绑定——空查询 = LIKE `%%`（匹配
    /// 全部，即「最近记录」初始态），`host_id = None` 走 `:host IS NULL` 恒假支。
    /// 分支间只差 SQL 文本与 `:match` 取值，杜绝按分支手抄参数表的漂移面。
    /// 代价是 host 过滤分支不走 idx_history_host_id（OR-IS NULL 形态挡住索引；
    /// 5 万行全扫毫秒级，⌘R 是键入节流的交互查询——该索引的真消费方是 FK 级联
    /// 删除路径）。
    pub fn search(
        vault: &Vault,
        query: &str,
        host_id: Option<i64>,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        let q = query.trim();
        let limit_i64 = limit.max(1) as i64;
        // 分派（spec §3 + T4 同款）：≥3 字符走 FTS MATCH，其余（含空查询）LIKE 兜底
        let (match_val, sql): (String, &str) = if q.chars().count() >= 3 {
            (
                match_query(q),
                "SELECT history.* FROM history, history_fts
                 WHERE history.id = history_fts.rowid AND history_fts MATCH :match
                   AND (:host IS NULL OR history.host_id = :host)
                 ORDER BY history.id DESC LIMIT :limit",
            )
        } else {
            (
                format!("%{}%", escape_like(q)),
                "SELECT * FROM history
                 WHERE command LIKE :match ESCAPE '\\'
                   AND (:host IS NULL OR history.host_id = :host)
                 ORDER BY id DESC LIMIT :limit",
            )
        };
        let args: [(&str, &dyn rusqlite::ToSql); 3] = [
            (":match", &match_val),
            (":host", &host_id),
            (":limit", &limit_i64),
        ];
        let conn = vault.connection();
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(args.as_slice(), row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 会话维度的命令序列（Task 7 会话纪要的数据源契约）：某会话
    /// （host_id + session_id）最近 `limit` 条命令，**按 id 升序（≈ ts 时序）**
    /// 返回——纪要 prompt 按时间顺序装配。明文面：锁定可读（同 insert/search）。
    /// limit 缺省 [`HISTORY_SESSION_LIMIT`]（超长会话只摘最近 N 条，prompt 体量
    /// 护栏；DELETE 路径不存在——history 只插入与滚动清理）。
    pub fn list_session(
        vault: &Vault,
        host_id: i64,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>> {
        let conn = vault.connection();
        let mut stmt = conn.prepare(
            "SELECT * FROM history
             WHERE host_id = ?1 AND session_id = ?2
             ORDER BY id DESC LIMIT ?3",
        )?;
        let mut rows = stmt
            .query_map(
                params![host_id, session_id, limit.max(1) as i64],
                row_to_entry,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.reverse(); // DESC 取尾（最近优先）→ 反转为时序
        Ok(rows)
    }
}

/// FTS MATCH 查询词：短语引号包裹（内部 `"` 翻倍），防 AND/OR/NEAR/* 等语法
/// 注入（entities.rs fts_phrase 同款语义，单点复刻于此避免跨模块 pub 面）。
fn match_query(q: &str) -> String {
    format!("\"{}\"", q.replace('"', "\"\""))
}

/// LIKE 兜底的通配转义：`\` `%` `_` 前置 `\`，配合 `ESCAPE '\'` 使用
/// （entities.rs escape_like 同款语义，单点复刻）。
fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn row_to_entry(row: &Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get("id")?,
        host_id: row.get("host_id")?,
        command: row.get("command")?,
        cwd: row.get("cwd")?,
        exit_code: row.get("exit_code")?,
        session_id: row.get("session_id")?,
        ts: row.get("ts")?,
    })
}
