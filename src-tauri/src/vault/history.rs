//! 命令历史（Task 15，⌘R 统一搜索）+ 会话纪要（Phase 2 Task 7）。
//! 纯搬家拆分（原 vault.rs 单文件）。

use tauri::State;

use ottr_vault::{
    HISTORY_SEARCH_LIMIT, HISTORY_SESSION_LIMIT, History, HistoryEntry, HistoryInput,
    SUMMARIES_LIST_LIMIT, SessionSummaries, SummaryEntry, SummaryInput,
};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- history（Task 15，spec §5 统一历史搜索 ⌘R）-------------------------------
// 明文面（history 无 *_enc 列，见 0007 迁移文件头）：**不过 ensure_unlocked 门卫**
// ——锁定（password 模式自动锁定）时正在跑的会话命令照常完成、照常入库，
// 门卫在这里会把每条命令变成一次静默丢弃（fire-and-forget 无错误面），故与
// notifications 同一锁定语义。脱敏不在历史层做（spec 定案：历史是本地数据）。
// 写入源 = 前端 CommandWatch（OSC133 命令完成事件），Rust 侧只供表。

#[specta::specta]
#[tauri::command]
pub fn history_insert(
    state: State<'_, VaultState>,
    input: HistoryInput,
) -> CmdResult<HistoryEntry> {
    cmd(History::insert(&state.0, &input))
}

/// `query` 空白 = 最近记录（面板初始态）；`host_id` 缺省 = 跨主机；
/// `limit` 缺省 [`HISTORY_SEARCH_LIMIT`]。≥3 字符 FTS trigram / 超短 LIKE 兜底
/// （Rust 层分派，与 hosts_search 同语义）。
#[specta::specta]
#[tauri::command]
pub fn history_search(
    state: State<'_, VaultState>,
    query: String,
    host_id: Option<i64>,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    cmd(History::search(
        &state.0,
        &query,
        host_id,
        limit.unwrap_or(HISTORY_SEARCH_LIMIT as u32) as usize,
    ))
}

/// 会话维度的命令序列（Phase 2 Task 7 纪要数据源）：id 升序（≈ts 时序），
/// `limit` 缺省 [`HISTORY_SESSION_LIMIT`]。明文面（锁定可读，同 history_search）。
#[specta::specta]
#[tauri::command]
pub fn history_list_session(
    state: State<'_, VaultState>,
    host_id: i64,
    session_id: String,
    limit: Option<u32>,
) -> CmdResult<Vec<HistoryEntry>> {
    cmd(History::list_session(
        &state.0,
        host_id,
        &session_id,
        limit.unwrap_or(HISTORY_SESSION_LIMIT as u32) as usize,
    ))
}

// --- session_summaries（Phase 2 Task 7，B1 会话纪要）--------------------------
// 密文面（summary_enc 已登记 scan_registry）：**过 ensure_unlocked 门卫**，与
// secrets 同一锁定语义——纪要生成是断开时的后台尽力而为任务（前端 fire-and-
// forget 吞错误），锁定时插入被拒即静默丢弃；面板读取同样解锁后可用。

#[specta::specta]
#[tauri::command]
pub fn summary_insert(
    state: State<'_, VaultState>,
    input: SummaryInput,
) -> CmdResult<SummaryEntry> {
    ensure_unlocked(&state.0)?;
    cmd(SessionSummaries::insert(&state.0, &input))
}

/// `host_id` 缺省 = 跨主机；`limit` 缺省 [`SUMMARIES_LIST_LIMIT`]。
#[specta::specta]
#[tauri::command]
pub fn summary_list(
    state: State<'_, VaultState>,
    host_id: Option<i64>,
    limit: Option<u32>,
) -> CmdResult<Vec<SummaryEntry>> {
    ensure_unlocked(&state.0)?;
    cmd(SessionSummaries::list(
        &state.0,
        host_id,
        limit.unwrap_or(SUMMARIES_LIST_LIMIT as u32) as usize,
    ))
}
