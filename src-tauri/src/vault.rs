//! vault Tauri 命令接线（Task 5）。
//!
//! Task 4 的 TS 层（src/vault/api.ts）文档化了 27 个命令名契约；本模块在
//! src-tauri 侧逐字落地（真后端此前未接线，api.test.ts 注释「真 Tauri 后端
//! 命令在 Task 5 接线」即此）。约定：
//!   * 命令名 = api.ts invoke 名（snake_case，generate_handler 注册同名）；
//!   * 顶层参数 camelCase → Rust snake_case 由 Tauri v2 自动转换（groupId →
//!     group_id）；载荷对象内部（HostInput 等）是 serde 反序列化面，snake_case；
//!   * 返回值 serde 直序列化（snake_case），与 TS 同构类型逐字对齐；
//!   * 错误一律 `String`（VaultError::Display 面向用户可读）。
//!
//! State：`VaultState(Arc<Vault>)` 由后台初始化线程打开后 manage（Task 16.5 起
//! 不再在 setup 主线程同步打开——钥匙链 SecItem 访问在 macOS 27 + ad-hoc 每次
//! 重建签名场景会挂起主线程、把主窗 frame 归零，见 task-16x5-report），单连接
//! Mutex 串行化见 ottr-vault store.rs 模块文档。
//!
//! Task 11（A7）扩展：
//!   * open 走 `Vault::open_auto`（Linux 无 Secret Service → 主密码模式 fallback）；
//!   * 全部实体命令过 `ensure_unlocked` 门卫——锁定（主密码模式）时统一返回
//!     "vault is locked..."（UI LockScreen 遮罩兜底 + 命令面防漏）；
//!   * 安全状态机命令：vault_security_status / vault_unlock / vault_lock /
//!     vault_upgrade_to_master_password（重加密进度事件 ottr://reencrypt-progress）；
//!   * settings_get / settings_set（主题/语言迁 vault + 安全配置；已知键校验在
//!     security.rs）；剪贴板命令在 security.rs（明文不过前端）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use ottr_vault::master_key::KeyStorage as _;
use ottr_vault::{
    AlertRule, AlertRuleInput, AlertRules, CredentialInput, CredentialPatch, Credentials, History,
    HistoryEntry, HistoryInput, Host, HostGroups, HostInput, Hosts, KeyMode, KnownHosts,
    Notification, NotificationInput, Notifications, NotifyChannel, NotifyChannelInput,
    NotifyChannelPatch, NotifyChannels, SecretField, Secrets, SessionSummaries, Settings,
    SnippetInput, Snippets, SummaryEntry, SummaryInput, Vault, VaultError, HISTORY_SEARCH_LIMIT,
    HISTORY_SESSION_LIMIT, SUMMARIES_LIST_LIMIT,
};

/// 托管进 Tauri 的 vault 句柄（全局唯一实例）。
pub struct VaultState(pub Arc<Vault>);

/// setup 阶段打开 vault：目录 = Tauri app_data_dir（macOS
/// ~/Library/Application Support/<identifier>/）。`open_auto`：钥匙链可用走
/// 钥匙链模式（macOS/Windows 恒可用），Linux 无 Secret Service 自动落主密码
/// 模式（Phase 0 spec §3 fallback 承诺，见 ottr-vault store.rs）。
pub fn init(app: &tauri::AppHandle) -> Result<VaultState, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let vault = Vault::open_auto(&dir)?;
    Ok(VaultState(Arc::new(vault)))
}

// --- 后台初始化状态（Task 16.5，0×0 主窗 frame 修复）-------------------------
// vault::init（含钥匙链 SecItem 访问）已移出 setup 主线程。init 完成前
// `VaultState` 尚未 manage，vault 命令在 Tauri 的 State 抽取层即被拒（invoke
// promise reject："state not managed …"，进程不崩）。前端就绪门
// （src/security/VaultInitGate.ts）以下面的状态面为唯一放行依据：
//   * `vault_init_status` 命令——无 VaultState 依赖，初始化窗口期可安全调用；
//   * `ottr://vault-ready` / `ottr://vault-init-failed` 事件——就绪快路径。
//
// 竞态契约（happens-before）：后台线程 **先 `manage(VaultState)` 再置 Ready**，
// 且 Ready/Failed 置位先于事件发出——前端「先挂监听、后查命令」两端夹逼后，
// 见到 Ready 即 State 必已可解析，首批 vault 命令（hosts_list 等）永不踩
// "state not managed"。T11 安全语义不变：Ready 后前端照旧走
// vault_security_status → keyring 模式进主 UI / password 模式进 LockScreen。

/// vault 后台初始化状态（serde tag=status snake_case，前端
/// `VaultInitStatusPayload` 同构）。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum VaultInitStatus {
    /// 后台初始化进行中（app_data_dir + 钥匙链/SQLite 打开）。
    #[default]
    Initializing,
    /// 就绪（VaultState 已 manage，vault 命令面可用）。
    Ready,
    /// 初始化失败（error = 错误 Display）。语义等同旧的「setup 失败即启动
    /// 失败」，只是主窗已可见——前端渲染全屏错误面（含退出按钮）。
    Failed { error: String },
}

/// [`VaultInitStatus`] 的 Tauri 托管壳。Builder 启动即 manage（无钥匙链访问，
/// 零开销）；写入只发生在后台初始化线程。Arc 内壳便于线程持克隆。
#[derive(Clone, Default)]
pub struct VaultInit(pub Arc<std::sync::Mutex<VaultInitStatus>>);

impl VaultInit {
    /// 写入只在后台初始化线程发生（lib.rs vault-init 线程；crate 内私有——
    /// Ready 的 happens-before 契约不允许第三方写入点）。
    pub(crate) fn set(&self, status: VaultInitStatus) {
        *self.0.lock().unwrap() = status;
    }

    pub fn get(&self) -> VaultInitStatus {
        self.0.lock().unwrap().clone()
    }
}

/// vault 初始化状态查询（前端就绪门的取数面）。
#[tauri::command]
pub fn vault_init_status(init: State<'_, VaultInit>) -> VaultInitStatus {
    init.get()
}

/// vault 域命令的统一返回别名（Phase 2 起新命令域复用，pub(crate)）。
pub(crate) type CmdResult<T> = Result<T, String>;

fn cmd<T>(r: ottr_vault::Result<T>) -> CmdResult<T> {
    r.map_err(|e: VaultError| e.to_string())
}

/// 锁定门卫（T11）：实体命令统一在入口拒绝锁定态。vault 层只有密钥面操作
/// 硬性要求密钥（凭据 seal/open），这里把封锁面上收到全部实体读写——遮罩后的
/// UI 本不该发起这些调用，属防漏兵（settings/安全状态命令不过此门卫）。
/// pub(crate)：Phase 2 新命令域（commands/forward.rs）复用同一门卫。
pub(crate) fn ensure_unlocked(vault: &Vault) -> CmdResult<()> {
    vault.ensure_unlocked().map_err(|e| e.to_string())
}

// --- 安全状态机（T11，A7）----------------------------------------------------
// 语义矩阵（完整版见 task-11-report）：keyring 模式无锁概念（open 即解锁，
// lock/unlock 拒绝/无效）；password 模式 open 即锁定 → unlock_with_password 或
// 自动锁定后解锁。事件：ottr://vault-locked / vault-unlocked（Rust 侧统一发，
// 前端状态机订阅）；ottr://reencrypt-progress（升级向导进度条）。

/// 安全状态快照（SecuritySettings 页/锁定屏启动查询）。
#[derive(Clone, serde::Serialize)]
pub struct SecurityStatus {
    /// "keyring" | "password"（KeyMode::as_str）
    pub mode: String,
    pub locked: bool,
}

#[tauri::command]
pub fn vault_security_status(state: State<'_, VaultState>) -> CmdResult<SecurityStatus> {
    Ok(SecurityStatus {
        mode: state.0.mode().as_str().to_string(),
        locked: state.0.is_locked(),
    })
}

/// 解锁（password 模式）：主密码校验通过后 Master Key 进内存。
/// 成功发 `ottr://vault-unlocked`（LockScreen 收口；keyring 模式/密码错显式报错）。
///
/// **明文主密码的 IPC 副本边界（BL-202 成文，不改行为）**——密码从输入框到
/// 消费点的完整生命周期与既定边界：
///
/// 1. **webview 侧**：`LockScreen` useState（向导：SecuritySettings，成功/
///    失败后清空重置）。JS 字符串在 GC 堆上**不可主动清零**——已知边界，
///    收敛手段是输入框 `type="password"`（不进 DOM 明文）+ 组件随锁定态
///    卸载后引用随 GC 回收。
/// 2. **IPC 面**：`invoke("vault_unlock", { password })` → Tauri v2 进程内
///    反序列化产生一份 `String` 副本（本命令栈上）。进程内 IPC 不出进程
///    边界（无网络面）。
/// 3. **消费点**：以 `&str` 借给 [`ottr_vault::Vault::unlock_with_password`]
///    → Argon2id 派生 → **派生中间值（32B RawKey）用后即清**（store.rs
///    `derive_cipher` 内 `key.zeroize()`）；内存中留存的只有
///    [`ottr_vault::Cipher`]（aes-gcm zeroize feature：key schedule
///    ZeroizeOnDrop，`vault_lock` 即取走 drop）。
/// 4. **副本清零边界**：命令参数 `String` 与 IPC 反序列化中间缓冲在命令
///    结束时普通 drop（非 zeroizing）——堆上留有可被同进程后续分配覆写的
///    残留。**裁定接受**：本地单用户进程、副本生命周期限于单次命令调用、
///    全链 zeroize 需自定义分配器改造，边际收益不成比例；作为交换，硬性
///    不变量是：密码**不落盘、不进日志/事件/错误文案/遥测**（错误路径只回
///    `VaultError::Display`，如 "master password is incorrect"，绝不内插
///    密码本身），且**不跨命令缓存**（每次解锁重新输入）。
#[tauri::command]
pub fn vault_unlock(
    state: State<'_, VaultState>,
    app: AppHandle,
    password: String,
) -> CmdResult<()> {
    state
        .0
        .unlock_with_password(&password)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ottr://vault-unlocked", ());
    Ok(())
}

/// 手动锁定（password 模式）。幂等；成功才发 `ottr://vault-locked`
/// （Task 14 快捷键挂同一命令）。keyring 模式无锁概念——**直接返回不发事件**
/// （fix 1/5 M-1）：前端 LockScreen 只订阅事件置锁，keyring 模式带外调用若发
/// 事件会弹一个永远解不开的锁屏（无解锁路径）。
#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>, app: AppHandle) -> CmdResult<()> {
    if state.0.mode() == KeyMode::Password {
        state.0.lock();
        let _ = app.emit("ottr://vault-locked", ());
    }
    Ok(())
}

/// 升级到主密码模式（设置页向导本体，keyring → password）：
/// 重加密逐字段发 `ottr://reencrypt-progress`（向导进度条），成功后删除钥匙链
/// 旧条目（失败路径什么都不动——vault 层单事务保证，残留由下次 open 兜底）。
/// 返回值 = 重密封字段数（向导完成页展示）。
/// 明文主密码的 IPC 副本边界与 [`vault_unlock`] 同一套（BL-202 成文，见彼处
/// 四点生命周期）；本命令在库内跑的是重密封（Argon2id 派生 + 全表重加密），
/// 副本生命周期因 Argon2 拉长到秒级，结论不变：不落盘、不进日志、不缓存。
#[tauri::command]
pub fn vault_upgrade_to_master_password(
    state: State<'_, VaultState>,
    app: AppHandle,
    password: String,
) -> CmdResult<usize> {
    let emitter = app.clone();
    let fields = state
        .0
        .set_master_password(&password, &mut |done, total| {
            let _ = emitter.emit(
                "ottr://reencrypt-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
        .map_err(|e| e.to_string())?;
    // 旧 Master Key 条目删除（升级成功的收尾）。失败不致命——残留条目在下次
    // open（password 模式）被兜底清理，且不再参与任何解锁路径。
    if let Err(e) =
        ottr_vault::master_key::KeyringStorage::new(ottr_vault::master_key::DEFAULT_SERVICE)
            .delete()
    {
        eprintln!("[vault-upgrade] stale keyring entry cleanup failed: {e}");
    }
    let _ = app.emit("ottr://vault-unlocked", ());
    Ok(fields)
}

// --- settings（T11：theme/language 迁 vault + 安全配置）-----------------------

#[tauri::command]
pub fn settings_get(
    state: State<'_, VaultState>,
    key: String,
) -> CmdResult<Option<serde_json::Value>> {
    // 明文面：锁定可读（锁定屏要读主题/自动锁定配置，见 ottr-vault settings.rs）。
    cmd(Settings::get(&state.0, &key))
}

/// 写设置项。已知安全键越界/类型错显式拒绝（security::validate_setting），
/// 未注册键放行（settings 表是通用配置面）。
#[tauri::command]
pub fn settings_set(
    state: State<'_, VaultState>,
    key: String,
    value: serde_json::Value,
) -> CmdResult<()> {
    crate::security::validate_setting(&key, &value)?;
    cmd(Settings::set(&state.0, &key, &value))
}

// --- secrets（Task 13，AI BYOK）密文 KV：provider api key 等 ------------------
// 与 settings 相对：**密文面**（AES-256-GCM 密封，AAD 绑定 rowid），锁定即拒
// （ensure_unlocked 门卫同实体命令）。key 逻辑名约定 `ai.apikey.<providerId>`；
// 明文只在 webview 组装请求头时短暂出现（前端经 credentials_reveal 同款单点
// 出库面 secret_get），永不落 settings/日志。

/// 写入/覆盖一个密文项（upsert）。
#[tauri::command]
pub fn secret_set(state: State<'_, VaultState>, key: String, value: String) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::set(&state.0, &key, &value))
}

/// 读一个密文项（明文单点出库；未设置 → None）。
#[tauri::command]
pub fn secret_get(state: State<'_, VaultState>, key: String) -> CmdResult<Option<String>> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::get(&state.0, &key))
}

/// 删除一个密文项（未知 key 显式报错——provider 已删而密文在即 bug，宁可响）。
#[tauri::command]
pub fn secret_delete(state: State<'_, VaultState>, key: String) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::delete(&state.0, &key))
}

/// 密文项存在性（不派生明文——设置页「已保存 key」标记）。
#[tauri::command]
pub fn secret_contains(state: State<'_, VaultState>, key: String) -> CmdResult<bool> {
    ensure_unlocked(&state.0)?;
    cmd(Secrets::contains(&state.0, &key))
}

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

// --- history（Task 15，spec §5 统一历史搜索 ⌘R）-------------------------------
// 明文面（history 无 *_enc 列，见 0007 迁移文件头）：**不过 ensure_unlocked 门卫**
// ——锁定（password 模式自动锁定）时正在跑的会话命令照常完成、照常入库，
// 门卫在这里会把每条命令变成一次静默丢弃（fire-and-forget 无错误面），故与
// notifications 同一锁定语义。脱敏不在历史层做（spec 定案：历史是本地数据）。
// 写入源 = 前端 CommandWatch（OSC133 命令完成事件），Rust 侧只供表。

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

#[tauri::command]
pub fn summary_insert(
    state: State<'_, VaultState>,
    input: SummaryInput,
) -> CmdResult<SummaryEntry> {
    ensure_unlocked(&state.0)?;
    cmd(SessionSummaries::insert(&state.0, &input))
}

/// `host_id` 缺省 = 跨主机；`limit` 缺省 [`SUMMARIES_LIST_LIMIT`]。
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

// --- hosts -----------------------------------------------------------------

#[tauri::command]
pub fn hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list(&state.0))
}

#[tauri::command]
pub fn hosts_get(state: State<'_, VaultState>, id: i64) -> CmdResult<Option<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::get(&state.0, id))
}

#[tauri::command]
pub fn hosts_create(state: State<'_, VaultState>, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::create(&state.0, input))
}

#[tauri::command]
pub fn hosts_update(state: State<'_, VaultState>, id: i64, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::update(&state.0, id, input))
}

#[tauri::command]
pub fn hosts_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::delete(&state.0, id))
}

#[tauri::command]
pub fn hosts_list_by_group(
    state: State<'_, VaultState>,
    group_id: Option<i64>,
) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list_by_group(&state.0, group_id))
}

#[tauri::command]
pub fn hosts_search(state: State<'_, VaultState>, query: String) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::search(&state.0, &query))
}

// --- credentials -----------------------------------------------------------

#[tauri::command]
pub fn credentials_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Credential>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::list(&state.0))
}

#[tauri::command]
pub fn credentials_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Credential>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::get(&state.0, id))
}

#[tauri::command]
pub fn credentials_create(
    state: State<'_, VaultState>,
    input: CredentialInput,
) -> CmdResult<ottr_vault::Credential> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::create(&state.0, &input))
}

#[tauri::command]
pub fn credentials_update(
    state: State<'_, VaultState>,
    id: i64,
    patch: CredentialPatch,
) -> CmdResult<ottr_vault::Credential> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::update(&state.0, id, &patch))
}

#[tauri::command]
pub fn credentials_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::delete(&state.0, id))
}

/// 明文单点出库（`field` 反序列化依赖 SecretField 的 serde snake_case 面，
/// Task 4 评审转交必办①）。
#[tauri::command]
pub fn credentials_reveal(
    state: State<'_, VaultState>,
    id: i64,
    field: SecretField,
) -> CmdResult<Option<String>> {
    ensure_unlocked(&state.0)?;
    cmd(Credentials::reveal(&state.0, id, field))
}

// --- host_groups -----------------------------------------------------------

#[tauri::command]
pub fn host_groups_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::HostGroup>> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::list(&state.0))
}

#[tauri::command]
pub fn host_groups_create(
    state: State<'_, VaultState>,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::create(
        &state.0,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[tauri::command]
pub fn host_groups_update(
    state: State<'_, VaultState>,
    id: i64,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::update(
        &state.0,
        id,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[tauri::command]
pub fn host_groups_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::delete(&state.0, id))
}

// --- snippets --------------------------------------------------------------

#[tauri::command]
pub fn snippets_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::list(&state.0))
}

#[tauri::command]
pub fn snippets_get(
    state: State<'_, VaultState>,
    id: i64,
) -> CmdResult<Option<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::get(&state.0, id))
}

#[tauri::command]
pub fn snippets_search(
    state: State<'_, VaultState>,
    query: String,
) -> CmdResult<Vec<ottr_vault::Snippet>> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::search(&state.0, &query))
}

#[tauri::command]
pub fn snippets_create(
    state: State<'_, VaultState>,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::create(&state.0, &input))
}

#[tauri::command]
pub fn snippets_update(
    state: State<'_, VaultState>,
    id: i64,
    input: SnippetInput,
) -> CmdResult<ottr_vault::Snippet> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::update(&state.0, id, &input))
}

#[tauri::command]
pub fn snippets_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Snippets::delete(&state.0, id))
}

// --- known_hosts -----------------------------------------------------------
// 0004 迁移（Task 8 义务①）起按 host 端点记账：host_key = "address:port"
// （ottr_vault::host_endpoint_key 构造），fingerprint 列 = 当前信任锚。

#[tauri::command]
pub fn known_hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::KnownHost>> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::list(&state.0))
}

#[tauri::command]
pub fn known_hosts_upsert(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::upsert(&state.0, &host_key, &fingerprint))
}

#[tauri::command]
pub fn known_hosts_verify(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::verify(&state.0, &host_key, &fingerprint))
}

#[tauri::command]
pub fn known_hosts_mark_changed(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::mark_changed(&state.0, &host_key, &fingerprint))
}

/// 删除 = 忘记该端点（B9 管理页，Task 6 Phase 3）：行消失后下次连接重走
/// TOFU（首见 pending）。返回是否有行被删（幂等面）。
#[tauri::command]
pub fn known_hosts_delete(state: State<'_, VaultState>, host_key: String) -> CmdResult<bool> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::delete(&state.0, &host_key))
}

// --- 导入 / 导出（Task 5 Step 3）-------------------------------------------

/// 导入 ~/.ssh/config（`path` 缺省时用 `~/.ssh/config`；前端 MVP 无文件选择器，
/// 传 None 即默认路径——留参数位给后续文件选择对话框）。
/// 解析与去重规则见 ssh_config 模块文档；报告（新增/跳过/错误行）由前端对话框展示。
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(crate::ssh_config::default_ssh_config_path)
        .ok_or_else(|| "cannot resolve home directory".to_string())?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let outcome = crate::ssh_config::parse_config(&content);
    cmd(crate::ssh_config::import_entries(&state.0, outcome))
}

/// 导入 Xshell 会话（Phase 2 Task 10，B3）。`path` = 会话目录或单个 .xsh；
/// 缺省回落 Windows 惯例会话目录（不存在即报错——mac/Linux 无默认位置）。
/// 解析规则与去重见 importers::xshell 模块文档；报告同构 ssh-config 导入。
#[tauri::command]
pub fn import_xshell_sessions(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(crate::importers::xshell::default_sessions_dir)
        .ok_or_else(|| "cannot resolve Xshell sessions directory; pick a folder".to_string())?;
    cmd(crate::importers::xshell::import_path(&state.0, &path))
}

/// 导入 Tabby 配置（Phase 2 Task 10，B3）。`path` 必传（配置 JSON 无跨平台
/// 惯例位置——前端经文件对话框选定）。解析规则见 importers::tabby 模块文档。
#[tauri::command]
pub fn import_tabby_config(
    state: State<'_, VaultState>,
    path: String,
) -> CmdResult<crate::ssh_config::ImportReport> {
    ensure_unlocked(&state.0)?;
    cmd(crate::importers::tabby::import_path(
        &state.0,
        &PathBuf::from(path),
    ))
}

/// CSV 导出主机清单。`path` 缺省写到系统下载目录 `ottr-hosts.csv`；返回落盘路径。
/// CSV 组装（RFC4180 转义 + 实体 join）在 ottr-vault `hosts_csv`（BL-206：随
/// 实体同库可独立单测）；本命令只保留路径解析与落盘。
#[tauri::command]
pub fn export_hosts_csv(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<String> {
    ensure_unlocked(&state.0)?;
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = app
                .path()
                .download_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| format!("resolve export dir: {e}"))?;
            dir.join("ottr-hosts.csv")
        }
    };
    let csv = ottr_vault::hosts_csv(&state.0).map_err(|e| e.to_string())?;
    std::fs::write(&target, csv).map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
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

// --- 同步分类快照（Phase 5 Task 3；ottr-vault sync_snapshot 模块）-------------
// 分类快照导出/导入 = 同步编排（src/sync/SyncStore.ts）的数据面。两者都开封/
// 重密封凭据与渠道密文（双层加密语义：信封口令保护传输面、本机主密码保护落盘
// 面，见 task-3-report）——过 ensure_unlocked 门卫，与凭据 CRUD 同一锁定语义。
// 命令名即简报裁定面：sync_export_categories(cats) / sync_import_categories(cats,
// data, mode)；顶层参数 camelCase（cats/data/mode 无歧义不转）。

/// 导出所选分类为快照 JSON（确定性输出；含解密后的凭据/渠道明文——返回值只进
/// 信封加密，前端不得落盘/落日志）。
#[tauri::command]
pub fn sync_export_categories(
    state: State<'_, VaultState>,
    cats: Vec<String>,
) -> CmdResult<serde_json::Value> {
    ensure_unlocked(&state.0)?;
    cmd(ottr_vault::sync_snapshot::export_categories(
        &state.0, &cats,
    ))
}

/// 全量替换式导入所选分类（单事务原子；返回逐分类落库/跳过计数）。
#[tauri::command]
pub fn sync_import_categories(
    state: State<'_, VaultState>,
    cats: Vec<String>,
    data: serde_json::Value,
    mode: ottr_vault::SyncImportMode,
) -> CmdResult<ottr_vault::SyncImportReport> {
    ensure_unlocked(&state.0)?;
    cmd(ottr_vault::sync_snapshot::import_categories(
        &state.0, &cats, &data, mode,
    ))
}

// --- 重置应用（BL-537 清偿：锁定屏「忘记密码？」终局出路）---------------------
// 主密码不可找回（AES-256-GCM，Master Key 由主密码派生——密码丢失即密文永久
// 不可开封），唯一出路 = 重置应用：清本机库 + 清钥匙链条目，回到首启状态
// （1Password 同款语义）。安全纪律：
//   * confirm 门卫——不带显式 confirm=true 的调用在入口拒绝，不动任何数据；
//   * abort-safe 顺序——先删钥匙链条目（失败即中止，库文件原样保留可重试），
//     再清数据目录（逐条目失败如实上抛，残余留给重试）；
//   * 清完 `app.restart()`——进程级回到首启链：vault-init 线程重跑 `open_auto`
//     （目录已空 → 全新 keyring 模式库、无锁）→ 前端就绪门/锁定状态机自然落
//     到首启面。不做进程内 vault 热替换（Arc<Vault> 不可换、连接/密钥槽残留
//     面大），重启是唯一语义完整的「回到首启」。

/// 重置确认门卫（pub(crate) 供单测）：confirm 必须显式 `Some(true)`。
/// 缺参（Tauri 反序列化 null → None）与显式 false 一律拒绝。
pub(crate) fn ensure_reset_confirmed(confirm: Option<bool>) -> Result<(), String> {
    if confirm == Some(true) {
        return Ok(());
    }
    Err(
        "vault_reset requires explicit confirmation: pass confirm=true (this wipes ALL local \
         vault data and the keychain entry)"
            .into(),
    )
}

/// 清空 vault 数据目录全部条目（vault.db/-wal/-shm、cron-runs/、recordings/、
/// mcp.sock 等——目录本身保留，重开时 create_dir_all 幂等）+ 删除钥匙链
/// 全部条目（`storages` 逐个删：Master Key + 同步信封口令——漏清后者则
/// 重置后云信封仍可被记忆口令解密，「回到首启」语义破产，T5 评审 P1）。
/// `storages` 注入（生产 = KeyringStorage 两条目，测试 = InMemoryStorage，
/// 单测绝不碰真钥匙链）。错误如实上抛，不做部分成功的静默伪装。
pub(crate) fn wipe_vault_data(
    dir: &std::path::Path,
    storages: &[&dyn ottr_vault::master_key::KeyStorage],
) -> Result<(), String> {
    // ① 钥匙链条目先删（abort-safe：任一条目清不掉就中止，库文件原样保留，
    // 用户可原样重试；条目序 = 调用方语义序，无跨条目依赖）。NoEntry 已由
    // KeyringStorage::delete 收敛为 Ok（条目本就不存在 = 已是目标态）。
    for (i, storage) in storages.iter().enumerate() {
        storage
            .delete()
            .map_err(|e| format!("keychain delete (entry {i}): {e}"))?;
    }
    // ② 数据目录逐条目清除（文件/子目录一视同仁；删除中的打开句柄在
    // macOS/Windows 上 unlink 语义由各平台兜底，进程重启后无残留引用）。
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|e| format!("readdir {}: {e}", dir.display()))?
            .path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

/// 重置应用命令（锁定屏「忘记密码？」确认后调用）。`confirm` 必须显式 true；
/// 清库成功即进程重启（本命令不返回——`AppHandle::restart` diverges），前端
/// invoke 永不 resolve 是预期形态；重启失败/清库失败错误如实回传上屏。
#[tauri::command]
pub fn vault_reset(
    state: State<'_, VaultState>,
    app: AppHandle,
    confirm: Option<bool>,
) -> CmdResult<()> {
    ensure_reset_confirmed(confirm)?;
    // 先落锁：password 模式把 Master Key 清出内存再动盘上数据（重启前不留
    // 敏感材料；keyring 模式 lock 本就 no-op 语义）。
    if state.0.mode() == KeyMode::Password {
        state.0.lock();
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    // 防呆：app_data_dir 解析异常退化成根/无父目录时拒绝清（宁可不重置）。
    if dir.parent().is_none() || dir == std::path::Path::new("/") {
        return Err(format!(
            "refusing to wipe suspicious data dir: {}",
            dir.display()
        ));
    }
    // 两条钥匙链条目：Master Key + 同步信封口令（重置 = 回到首启态，本应用
    // 在正式 service 下的条目一个不留；entry 序对应错误消息 entry 0/1）。
    let master =
        ottr_vault::master_key::KeyringStorage::new(ottr_vault::master_key::DEFAULT_SERVICE);
    let sync_pass = ottr_vault::master_key::KeyringStorage::with_account(
        crate::commands::sync_git::SYNC_SERVICE,
        crate::commands::sync_git::SYNC_ACCOUNT,
    );
    wipe_vault_data(&dir, &[&master, &sync_pass])?;
    eprintln!(
        "[vault] reset confirmed: data dir wiped ({}), restarting app",
        dir.display()
    );
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Task 16.5：vault_init_status 的 serde 面与前端 VaultInitStatusPayload
    /// 同构（tag=status snake_case）——字段名漂移会让前端就绪门永远停在 loading。
    #[test]
    fn vault_init_status_serde_matches_frontend_contract() {
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Initializing).unwrap(),
            serde_json::json!({ "status": "initializing" })
        );
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Ready).unwrap(),
            serde_json::json!({ "status": "ready" })
        );
        assert_eq!(
            serde_json::to_value(VaultInitStatus::Failed {
                error: "boom".into()
            })
            .unwrap(),
            serde_json::json!({ "status": "failed", "error": "boom" })
        );
    }

    /// tracker 缺省 Initializing、set→get 终态可见（后台线程经此与前端共享
    /// 终态；Ready 置位由 lib.rs 保证严格晚于 VaultState manage）。
    #[test]
    fn vault_init_tracker_defaults_to_initializing_and_lands_terminal_state() {
        let tracker = VaultInit::default();
        assert!(matches!(tracker.get(), VaultInitStatus::Initializing));
        tracker.set(VaultInitStatus::Ready);
        assert!(matches!(tracker.get(), VaultInitStatus::Ready));
        tracker.set(VaultInitStatus::Failed { error: "x".into() });
        assert!(matches!(tracker.get(), VaultInitStatus::Failed { .. }));
    }

    // --- vault_reset（BL-537 清偿：锁定屏「忘记密码？」终局出路）---------------

    /// 确认门卫：confirm 必须显式 Some(true)。缺参/显式 false 一律拒绝——
    /// 破坏性命令不接受任何静默默认（漏传 confirm = Tauri 反序列化层缺参，
    /// 也走 None 拒绝路径，不会意外清库）。
    #[test]
    fn reset_confirm_guard_rejects_everything_but_explicit_true() {
        assert!(
            ensure_reset_confirmed(None).is_err(),
            "缺 confirm 参数 = 拒绝"
        );
        assert!(
            ensure_reset_confirmed(Some(false)).is_err(),
            "显式 false = 拒绝"
        );
        assert_eq!(ensure_reset_confirmed(Some(true)), Ok(()));
        let err = ensure_reset_confirmed(None).unwrap_err();
        assert!(
            err.contains("confirm"),
            "错误消息必须指明 confirm 契约（前端可诊断）：{err}"
        );
    }

    /// wipe 清空数据目录全部条目（文件/子目录一视同仁）+ 删除钥匙链条目
    /// （Master Key + 同步信封口令——T5 评审 P1：漏清 sync-passphrase 会让
    /// 重置后云信封仍可被记忆口令解密，「回到首启」语义破产）。
    /// storage 注入 InMemoryStorage——单测绝不碰真钥匙链（测试纪律同
    /// ottr-vault master_key）。
    #[test]
    fn wipe_vault_data_clears_dir_and_keychain_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        std::fs::write(dir.path().join("vault.db-wal"), b"wal").unwrap();
        let sub = dir.path().join("cron-runs");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("1-2.log"), b"log").unwrap();

        let master = ottr_vault::master_key::InMemoryStorage::default();
        let sync_pass = ottr_vault::master_key::InMemoryStorage::default();
        use ottr_vault::master_key::KeyStorage as _;
        master.save("master-key-material").unwrap();
        sync_pass.save("sync-passphrase-material").unwrap();

        wipe_vault_data(dir.path(), &[&master, &sync_pass]).unwrap();

        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "数据目录必须清空（含子目录 cron-runs）"
        );
        assert_eq!(
            master.load().unwrap(),
            None,
            "钥匙链 Master Key 条目必须删除"
        );
        assert_eq!(
            sync_pass.load().unwrap(),
            None,
            "钥匙链同步口令条目必须删除（重置后云信封不得可解）"
        );
    }

    /// 钥匙链删除失败 → 整体报错且**先于任何文件删除**（abort-safe 顺序：
    /// 钥匙链清不掉就绝不碰库文件，用户可原样重试）。用「不可写目录」构造
    /// 文件删除失败场景验证错误如实上抛。
    #[test]
    fn wipe_vault_data_reports_storage_failure_without_touching_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        // 刻意损坏的 storage：delete 恒败（模拟钥匙链拒绝访问）。
        struct BrokenStorage;
        impl ottr_vault::master_key::KeyStorage for BrokenStorage {
            fn load(&self) -> ottr_vault::Result<Option<String>> {
                Ok(None)
            }
            fn save(&self, _secret: &str) -> ottr_vault::Result<()> {
                Ok(())
            }
            fn delete(&self) -> ottr_vault::Result<()> {
                Err(ottr_vault::VaultError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "keychain denied",
                )))
            }
        }
        let err = wipe_vault_data(dir.path(), &[&BrokenStorage]).unwrap_err();
        assert!(err.contains("keychain"), "错误须指明钥匙链环节：{err}");
        assert_eq!(
            std::fs::read_to_string(&db).unwrap(),
            "cipher",
            "钥匙链删除失败时库文件必须原样保留（可重试）"
        );
    }

    /// 第二条目（同步口令）删除失败同样 abort-safe：任一钥匙链条目清不掉
    /// 就绝不碰库文件（T5 评审 P1 伴随面——重置必须两条目原子语义）。
    #[test]
    fn wipe_vault_data_sync_entry_failure_aborts_before_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        struct BrokenStorage;
        impl ottr_vault::master_key::KeyStorage for BrokenStorage {
            fn load(&self) -> ottr_vault::Result<Option<String>> {
                Ok(None)
            }
            fn save(&self, _secret: &str) -> ottr_vault::Result<()> {
                Ok(())
            }
            fn delete(&self) -> ottr_vault::Result<()> {
                Err(ottr_vault::VaultError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "keychain denied",
                )))
            }
        }
        let master = ottr_vault::master_key::InMemoryStorage::default();
        let err = wipe_vault_data(dir.path(), &[&master, &BrokenStorage]).unwrap_err();
        assert!(err.contains("keychain"), "错误须指明钥匙链环节：{err}");
        assert_eq!(
            std::fs::read_to_string(&db).unwrap(),
            "cipher",
            "同步口令条目删除失败时库文件必须原样保留（可重试）"
        );
    }

    /// 目录删除失败（只读目录）→ 错误如实上抛，不静默（残余文件留给重试）。
    #[test]
    fn wipe_vault_data_reports_dir_errors() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ottr_vault::master_key::InMemoryStorage::default();
        // 目录本身不存在 → read_dir 失败必须显式报错（app_data_dir 解析异常
        // 的兜底面，静默 Ok 会伪装成「已重置」）。
        let missing = dir.path().join("does-not-exist");
        assert!(wipe_vault_data(&missing, &[&storage]).is_err());
    }
}
