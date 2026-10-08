//! B5 通知域存储面：通知中心（notify_*）/ 渠道（nc_*）/ 告警规则（ar_*）。
//! 纯搬家拆分（原 vault.rs 单文件）。

use tauri::State;

use ottr_vault::{
    AlertRule, AlertRuleInput, AlertRules, DeliveryFailure, Notification, NotificationInput,
    Notifications, NotifyChannel, NotifyChannelInput, NotifyChannelPatch, NotifyChannels,
};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- notifications（Task 12，spec §7 通知管线①应用内通知中心）-----------------
// 明文面（通知无 *_enc 列，见 0005 迁移文件头）：**不过 ensure_unlocked 门卫**
// ——锁定态下 session-closed 等事件也要能落表（与 settings 同一锁定语义）。
// 事件源接线在前端 src/notify/core.ts（管线枢纽，spec §7 定案），Rust 只供表。

#[tauri::command]
pub fn notify_insert(
    state: State<'_, VaultState>,
    input: NotificationInput,
) -> CmdResult<Notification> {
    cmd(Notifications::insert(&state.0, &input))
}

/// `limit` 缺省 200（None → 200；通知中心一屏量级）。
#[tauri::command]
pub fn notify_list(
    state: State<'_, VaultState>,
    limit: Option<u32>,
) -> CmdResult<Vec<Notification>> {
    cmd(Notifications::list(&state.0, limit.unwrap_or(200) as usize))
}

/// 标记已读：`id` 缺省 = 全部已读；未知 id 显式报错。
#[tauri::command]
pub fn notify_mark_read(state: State<'_, VaultState>, id: Option<i64>) -> CmdResult<usize> {
    cmd(Notifications::mark_read(&state.0, id))
}

#[tauri::command]
pub fn notify_clear(state: State<'_, VaultState>) -> CmdResult<usize> {
    cmd(Notifications::clear(&state.0))
}

#[tauri::command]
pub fn notify_unread_count(state: State<'_, VaultState>) -> CmdResult<i64> {
    cmd(Notifications::unread_count(&state.0))
}

/// 投递失败标记入账（BL-530）：渠道终败标记落库（按渠道去重），返回更新后
/// 的行。明文面不过门卫（同 notify_* 组；投递失败发生在锁定态也要能落账）。
/// 未知行显式报错（前端按尽力而为面 console 处理，内存账本保底 UI 不谎报）。
#[tauri::command]
pub fn notify_mark_delivery_failed(
    state: State<'_, VaultState>,
    id: i64,
    failure: DeliveryFailure,
) -> CmdResult<Notification> {
    cmd(Notifications::mark_delivery_failed(&state.0, id, &failure))
}

/// 投递失败翻正清账（BL-530）：摘除一个渠道的标记（重发/后台重试成功时调
/// 用）；集合清空回归 NULL。明文面不过门卫，同上。
#[tauri::command]
pub fn notify_clear_delivery_failure(
    state: State<'_, VaultState>,
    id: i64,
    channel: String,
) -> CmdResult<Notification> {
    cmd(Notifications::clear_delivery_failure(
        &state.0, id, &channel,
    ))
}

// --- alert_rules（Phase 3 Task 3，B5 告警规则——存储侧命令面）------------------
// 明文面（无 *_enc 列，见 0013 迁移文件头）：**过 ensure_unlocked 门卫**（配置
// 面与 hosts 同一锁定语义）。规则评估引擎在前端 src/notify/rules.ts（数据源 =
// ottr://monitor 事件流 + monitor_ps），Rust 只供表 + mark_fired 水位回写。

#[tauri::command]
pub fn ar_list(state: State<'_, VaultState>) -> CmdResult<Vec<AlertRule>> {
    ensure_unlocked(&state.0)?;
    cmd(AlertRules::list(&state.0))
}

#[tauri::command]
pub fn ar_create(state: State<'_, VaultState>, input: AlertRuleInput) -> CmdResult<AlertRule> {
    ensure_unlocked(&state.0)?;
    cmd(AlertRules::create(&state.0, &input))
}

#[tauri::command]
pub fn ar_update(
    state: State<'_, VaultState>,
    id: i64,
    input: AlertRuleInput,
) -> CmdResult<AlertRule> {
    ensure_unlocked(&state.0)?;
    cmd(AlertRules::update(&state.0, id, &input))
}

#[tauri::command]
pub fn ar_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(AlertRules::delete(&state.0, id))
}

/// 触发水位回写（引擎放行一条告警时调用；规则刚被删 → NotFound 显式浮出）。
#[tauri::command]
pub fn ar_touch_fired(state: State<'_, VaultState>, id: i64, ts: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(AlertRules::mark_fired(&state.0, id, ts))
}

// --- notify_channels（Phase 3 Task 3，B5 渠道全矩阵——存储侧命令面）------------
// 密文面（config_enc 已登记 scan_registry）：**过 ensure_unlocked 门卫**，与
// secrets/summaries 同一锁定语义。列表不携带密钥材料（serde 面 NotifyChannel
// 无 config 字段）；明文 config 只经 nc_reveal_config 单点出库（设置页「发送
// 测试」与管线挂载时取一次）；发信面在 commands/notify.rs（SMTP）与前端
// fetch 适配器（其余 11 渠道）。

#[tauri::command]
pub fn nc_list(state: State<'_, VaultState>) -> CmdResult<Vec<NotifyChannel>> {
    ensure_unlocked(&state.0)?;
    cmd(NotifyChannels::list(&state.0))
}

#[tauri::command]
pub fn nc_create(
    state: State<'_, VaultState>,
    input: NotifyChannelInput,
) -> CmdResult<NotifyChannel> {
    ensure_unlocked(&state.0)?;
    cmd(NotifyChannels::create(&state.0, &input))
}

#[tauri::command]
pub fn nc_update(
    state: State<'_, VaultState>,
    id: i64,
    patch: NotifyChannelPatch,
) -> CmdResult<NotifyChannel> {
    ensure_unlocked(&state.0)?;
    cmd(NotifyChannels::update(&state.0, id, &patch))
}

#[tauri::command]
pub fn nc_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(NotifyChannels::delete(&state.0, id))
}

#[tauri::command]
pub fn nc_reveal_config(state: State<'_, VaultState>, id: i64) -> CmdResult<serde_json::Value> {
    ensure_unlocked(&state.0)?;
    cmd(NotifyChannels::reveal_config(&state.0, id))
}
