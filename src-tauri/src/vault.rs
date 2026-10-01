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
    CredentialInput, CredentialPatch, Credentials, History, HistoryEntry, HistoryInput, Host,
    HostGroups, HostInput, Hosts, KeyMode, KnownHosts, Notification, NotificationInput,
    Notifications, SecretField, Secrets, Settings, SnippetInput, Snippets, Vault, VaultError,
    HISTORY_SEARCH_LIMIT,
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

type CmdResult<T> = Result<T, String>;

fn cmd<T>(r: ottr_vault::Result<T>) -> CmdResult<T> {
    r.map_err(|e: VaultError| e.to_string())
}

/// 锁定门卫（T11）：实体命令统一在入口拒绝锁定态。vault 层只有密钥面操作
/// 硬性要求密钥（凭据 seal/open），这里把封锁面上收到全部实体读写——遮罩后的
/// UI 本不该发起这些调用，属防漏兵（settings/安全状态命令不过此门卫）。
fn ensure_unlocked(vault: &Vault) -> CmdResult<()> {
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

/// CSV 导出主机清单。`path` 缺省写到系统下载目录 `ottr-hosts.csv`；返回落盘路径。
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
    let csv = build_hosts_csv(&state.0).map_err(|e| e.to_string())?;
    std::fs::write(&target, csv).map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 主机清单 CSV（RFC4180：含逗号/引号/换行的字段加引号、引号翻倍）。
fn build_hosts_csv(vault: &Vault) -> ottr_vault::Result<String> {
    let groups: std::collections::HashMap<i64, String> = HostGroups::list(vault)?
        .into_iter()
        .map(|g| (g.id, g.name))
        .collect();
    let mut out = String::from("name,username,address,port,group,tags,encoding,notes\n");
    for h in Hosts::list(vault)? {
        let group = h
            .group_id
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
        let row: Vec<String> = vec![
            h.name.clone(),
            h.username.clone().unwrap_or_default(),
            h.address.clone(),
            h.port.to_string(),
            group.to_string(),
            h.tags.join("|"),
            h.encoding_override.clone().unwrap_or_default(),
            h.notes.clone().unwrap_or_default(),
        ];
        let cells: Vec<String> = row.iter().map(|c| csv_field(c)).collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// 单字段转义：危险字符（`,` `"` CR LF）任一出现即整体加引号、内部引号翻倍。
fn csv_field(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_field_quotes_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }

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
}
