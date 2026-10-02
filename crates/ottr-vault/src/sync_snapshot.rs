//! 同步分类快照的导出/导入（Phase 5 Task 3，同步编排的数据面）。
//!
//! 八类分类快照（spec Phase 5 裁定面）：host_groups / credentials / hosts /
//! snippets / notify_channels / alert_rules / cron_jobs / settings——每类一条
//! 数组，条目含全部业务字段。信封加密在 TS 侧（src/sync/envelope.ts，Phase 5
//! Task 2），本模块只负责「vault ↔ 快照 JSON」的双向翻译：
//!
//! * **导出**（[`export_categories`]）= 忠实快照 + 本地性剥离：
//!   - 凭据 `secret`/`passphrase`/`totp_secret` 走 [`Credentials::reveal`]
//!     **解密成明文进快照**，渠道 `config` 走 [`NotifyChannels::reveal_config`]
//!     同理——双层加密语义（task-3-report 论证）：明文只在信封明文层短暂存在，
//!     信封口令（PBKDF2→AES-256-GCM）保护传输/云端面，本机主密码（vault
//!     cipher）保护落盘面，两层独立；
//!   - 剥离 `hosts.jump_chain_id`（jump_chains 不在同步集，携带即跨机谎言）；
//!   - 剥离 `alert_rules.last_fired`（触发水位是本机运行态，非配置）；
//!   - 剥离 `sync.*` 前缀的 settings 键（`sync.state` / `sync.scope.*` 是
//!     本机同步簿记，导入他机的会毁掉本机三态判定基线）；
//!   - 无导出时间戳等挥发字段——**同一数据两次导出逐字节相同**，TS 侧
//!     sha256(export JSON) 才能作为「本机数据指纹」参与三态判定。
//!
//! * **导入**（[`import_categories`]）= 全量替换所选分类（裁定：范围勾选 +
//!     冲突按分类人工处理，非逐条 merge——粒度论证见 task-3-report）：
//!   - 单个 SQLite 事务：全部所选分类要么整体落地要么整体不动（回滚）；
//!   - id 全部重映射（AUTOINCREMENT 新 id），引用按「被引用分类也在所选集
//!     内才保留，否则切断」重写：
//!       host_groups.parent_id ← groups；hosts.group_id ← groups；
//!       hosts.credential_id ← credentials；snippets.host_scope ← hosts；
//!       alert_rules.host_id ← hosts（NOT NULL，不可保留即**整行跳过**计数）；
//!       cron_jobs.host_id ← hosts（同上）；alert_rules/cron_jobs 的
//!       `channels` 数组逐 id 过滤（不可映射的剔除，保其余）；
//!   - 替换删除的级联面（schema 裁定既有语义，非本模块发明）：删 hosts 级联
//!     删 alert_rules/cron_jobs（FK CASCADE，且两表 host_id NOT NULL——宿主
//!     没了规则无意义）、SET NULL snippets.host_scope；删 groups/credentials
//!     SET NULL hosts 引用。**未选中的分类被这些级联波及 = 引用切断语义的
//!     自然延伸**（被引用行已整体换血，旧 id 不再存在）；jump_chains 无 FK
//!     （hops 是 JSON 列），删 hosts 前逐台走
//!     [`crate::jump_chains::remove_host_from_chains`] 反向补偿，不留死 hop id；
//!   - settings 替换 = 删除全部非 `sync.*` 键后落快照键（真全量替换）；
//!     `sync.*` 键免疫（本机簿记不随数据走）。
//!
//! * 快照格式版本（[`SYNC_DATA_VERSION`]）不匹配显式拒绝——跨版本演进
//!   （未来加分类/改字段）走版本 bump + 迁移转换，绝不静默误读。
//!
//! 锁定语义：导出要开封凭据/渠道密文（`cipher()` 锁定即拒）；导入要重密封
//! ——两者都过密钥面，与凭据 CRUD 同一锁定语义（src-tauri 命令层再过
//! `ensure_unlocked` 门卫统一报错文案）。

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::jump_chains::remove_host_from_chains;
use crate::{
    aad, AlertRules, CredentialKind, Credentials, CronJobs, HostGroups, HostProtocol, Hosts,
    NotifyChannels, Result, SecretField, Snippets, Vault, VaultError,
};

/// 快照格式版本（结构演进 bump；导入拒绝其它版本）。
pub const SYNC_DATA_VERSION: u32 = 1;

/// 八类同步分类（canonical 顺序 = 导出/导入的处理顺序；导入按依赖序排列——
/// 被引用分类先落库，id 重映射表才可用）。
pub const SYNC_CATEGORIES: [&str; 8] = [
    "host_groups",
    "credentials",
    "hosts",
    "snippets",
    "notify_channels",
    "alert_rules",
    "cron_jobs",
    "settings",
];

/// 本机同步簿记的 settings 键前缀：不导出、导入不波及。
/// 现有键：`sync.state`（三态判定基线）、`sync.scope.push` / `sync.scope.restore`
/// （范围勾选偏好，src/sync/SyncStore.ts）。
const SYNC_SETTINGS_PREFIX: &str = "sync.";

/// 导入语义（版本化枚举：未来 merge 语义在此扩展，传输参数面向前兼容）。
/// `replace` = 全量替换所选分类（裁定语义：范围勾选 + 分类粒度人工处理冲突）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncImportMode {
    Replace,
}

/// 导入回执（serde 面与 TS `SyncImportReport` 同构；BTreeMap = 键序稳定）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncImportReport {
    /// 每个所选分类实际落库条数。
    pub applied: BTreeMap<String, usize>,
    /// 因 host 引用无法重映射而被整行丢弃的条数（仅 alert_rules / cron_jobs
    /// ——host_id NOT NULL，切断不可能；引用的 hosts 分类不在所选集时发生）。
    pub skipped: BTreeMap<String, usize>,
}

// --- 快照条目结构（serde 反序列化面：字段缺失 = 快照损坏，显式报错回滚）-------

#[derive(Deserialize)]
struct SyncGroup {
    id: i64,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncCredential {
    id: i64,
    kind: CredentialKind,
    key_pub: Option<String>,
    secret: Option<String>,
    passphrase: Option<String>,
    totp_secret: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncHost {
    id: i64,
    name: String,
    group_id: Option<i64>,
    tags: Vec<String>,
    address: String,
    port: i64,
    username: Option<String>,
    protocol: HostProtocol,
    credential_id: Option<i64>,
    encoding_override: Option<String>,
    theme_override: Option<String>,
    monitor_enabled: bool,
    is_production: bool,
    notes: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncSnippet {
    /// 源 id 仅作快照完整性面（反序列化要求字段齐全）；本类无被引用方，不消费。
    #[allow(dead_code)]
    id: i64,
    name: String,
    body: String,
    variables: Vec<String>,
    tags: Vec<String>,
    host_scope: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncChannel {
    id: i64,
    kind: String,
    config: Value,
    template_overrides: Option<Value>,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncAlertRule {
    /// 源 id 仅作快照完整性面（反序列化要求字段齐全）；规则无被引用方，不消费。
    #[allow(dead_code)]
    id: i64,
    host_id: i64,
    kind: String,
    params: Value,
    channels: Vec<i64>,
    rate_limit: i64,
    mute_window: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
struct SyncCronJob {
    /// 源 id 仅作快照完整性面（反序列化要求字段齐全）；任务无被引用方，不消费。
    #[allow(dead_code)]
    id: i64,
    host_id: i64,
    schedule: String,
    script: String,
    channels: Vec<i64>,
    enabled: bool,
    created_at: i64,
    updated_at: i64,
}
#[derive(Deserialize)]
struct SyncSetting {
    key: String,
    value: Value,
}

// --- 范围校验 -----------------------------------------------------------------

/// 所选分类校验：非空、全部合法、无重复（重复多半是调用方 bug，显式拒绝）。
fn validate_cats(cats: &[String]) -> Result<()> {
    if cats.is_empty() {
        return Err(VaultError::InvalidInput(
            "no sync categories selected".into(),
        ));
    }
    let mut seen = HashSet::new();
    for c in cats {
        if !SYNC_CATEGORIES.contains(&c.as_str()) {
            return Err(VaultError::InvalidInput(format!(
                "unknown sync category: {c} (valid: {})",
                SYNC_CATEGORIES.join("/")
            )));
        }
        if !seen.insert(c.as_str()) {
            return Err(VaultError::InvalidInput(format!(
                "duplicate sync category: {c}"
            )));
        }
    }
    Ok(())
}

fn is_selected(selected: &HashSet<&str>, cat: &str) -> bool {
    selected.contains(cat)
}

/// 从快照 JSON 取某分类的条目数组并反序列化（分类缺失/非数组 = 快照损坏，
/// 显式报错——整个导入在单事务内回滚）。
fn parse_entries<T: for<'de> Deserialize<'de>>(
    categories: &serde_json::Map<String, Value>,
    cat: &str,
) -> Result<Vec<T>> {
    let raw = categories.get(cat).ok_or_else(|| {
        VaultError::InvalidInput(format!("snapshot is missing category \"{cat}\""))
    })?;
    let arr = raw.as_array().ok_or_else(|| {
        VaultError::InvalidInput(format!("snapshot category \"{cat}\" is not an array"))
    })?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        out.push(serde_json::from_value::<T>(item.clone()).map_err(|e| {
            VaultError::InvalidInput(format!(
                "snapshot category \"{cat}\" entry #{i} is malformed: {e}"
            ))
        })?);
    }
    Ok(out)
}

// --- 导出 ---------------------------------------------------------------------

/// 导出所选分类为快照 JSON（确定性：同数据两次导出逐字节相同——三态判定的
/// 本机数据指纹以此为准）。条目含解密后的凭据/渠道明文——调用方必须立即整体
/// 加密（信封），不得落盘/落日志。
pub fn export_categories(vault: &Vault, cats: &[String]) -> Result<Value> {
    let selected: HashSet<&str> = {
        validate_cats(cats)?;
        cats.iter().map(String::as_str).collect()
    };
    let mut categories = serde_json::Map::new();
    if is_selected(&selected, "host_groups") {
        categories.insert(
            "host_groups".into(),
            serde_json::to_value(HostGroups::list(vault)?)?,
        );
    }
    if is_selected(&selected, "credentials") {
        let mut rows = Vec::new();
        for c in Credentials::list(vault)? {
            rows.push(json!({
                "id": c.id,
                "kind": c.kind,
                "key_pub": c.key_pub,
                "secret": Credentials::reveal(vault, c.id, SecretField::Secret)?,
                "passphrase": Credentials::reveal(vault, c.id, SecretField::Passphrase)?,
                "totp_secret": Credentials::reveal(vault, c.id, SecretField::TotpSecret)?,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
            }));
        }
        categories.insert("credentials".into(), Value::Array(rows));
    }
    if is_selected(&selected, "hosts") {
        let mut rows = Vec::new();
        for h in Hosts::list(vault)? {
            let mut v = serde_json::to_value(&h)?;
            // jump_chains 不在同步集：携带他机不可解析的本地 id 即谎言，剥离。
            v.as_object_mut()
                .expect("Host 序列化必为对象")
                .remove("jump_chain_id");
            rows.push(v);
        }
        categories.insert("hosts".into(), Value::Array(rows));
    }
    if is_selected(&selected, "snippets") {
        categories.insert(
            "snippets".into(),
            serde_json::to_value(Snippets::list(vault)?)?,
        );
    }
    if is_selected(&selected, "notify_channels") {
        let mut rows = Vec::new();
        for c in NotifyChannels::list(vault)? {
            rows.push(json!({
                "id": c.id,
                "kind": c.kind,
                "config": NotifyChannels::reveal_config(vault, c.id)?,
                "template_overrides": c.template_overrides,
                "enabled": c.enabled,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
            }));
        }
        categories.insert("notify_channels".into(), Value::Array(rows));
    }
    if is_selected(&selected, "alert_rules") {
        let mut rows = Vec::new();
        for r in AlertRules::list(vault)? {
            let mut v = serde_json::to_value(&r)?;
            // 触发水位是本机运行态（防重复告警），不属于配置快照。
            v.as_object_mut()
                .expect("AlertRule 序列化必为对象")
                .remove("last_fired");
            rows.push(v);
        }
        categories.insert("alert_rules".into(), Value::Array(rows));
    }
    if is_selected(&selected, "cron_jobs") {
        categories.insert(
            "cron_jobs".into(),
            serde_json::to_value(CronJobs::list(vault)?)?,
        );
    }
    if is_selected(&selected, "settings") {
        categories.insert("settings".into(), export_settings(vault)?);
    }
    Ok(json!({ "version": SYNC_DATA_VERSION, "categories": Value::Object(categories) }))
}

/// 非簿记 settings 行（`sync.*` 前缀除外），按 key 排序（确定性）。
fn export_settings(vault: &Vault) -> Result<Value> {
    let entries: Vec<Value> = {
        let conn = vault.connection();
        let mut stmt = conn.prepare(&format!(
            "SELECT key, value FROM settings WHERE key NOT LIKE '{SYNC_SETTINGS_PREFIX}%' ORDER BY key"
        ))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (key, raw) = row?;
            let value: Value = serde_json::from_str(&raw)?;
            out.push(json!({ "key": key, "value": value }));
        }
        out
    };
    Ok(Value::Array(entries))
}

// --- 导入 ---------------------------------------------------------------------

/// 全量替换所选分类（单事务原子；任何条目损坏 → 整体回滚不动现有数据）。
/// 返回逐分类落库/跳过计数。语义细节见模块文档（引用保留规则、级联面）。
pub fn import_categories(
    vault: &Vault,
    cats: &[String],
    data: &Value,
    mode: SyncImportMode,
) -> Result<SyncImportReport> {
    let selected: HashSet<&str> = {
        validate_cats(cats)?;
        cats.iter().map(String::as_str).collect()
    };
    let _ = mode; // 当前唯一语义 Replace；参数位为未来 merge 保留
    let version = data
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| VaultError::InvalidInput("snapshot is missing \"version\"".into()))?;
    if version != SYNC_DATA_VERSION as u64 {
        return Err(VaultError::InvalidInput(format!(
            "unsupported snapshot version: {version} (expected {SYNC_DATA_VERSION})"
        )));
    }
    let categories = data
        .get("categories")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            VaultError::InvalidInput("snapshot is missing \"categories\" object".into())
        })?
        .clone();

    // 解析全部所选分类的条目（先整体校验后动库——损坏快照在事务开始前即失败）。
    let groups: Vec<SyncGroup> = if is_selected(&selected, "host_groups") {
        parse_entries(&categories, "host_groups")?
    } else {
        Vec::new()
    };
    let credentials: Vec<SyncCredential> = if is_selected(&selected, "credentials") {
        parse_entries(&categories, "credentials")?
    } else {
        Vec::new()
    };
    let hosts: Vec<SyncHost> = if is_selected(&selected, "hosts") {
        parse_entries(&categories, "hosts")?
    } else {
        Vec::new()
    };
    let snippets: Vec<SyncSnippet> = if is_selected(&selected, "snippets") {
        parse_entries(&categories, "snippets")?
    } else {
        Vec::new()
    };
    let channels: Vec<SyncChannel> = if is_selected(&selected, "notify_channels") {
        parse_entries(&categories, "notify_channels")?
    } else {
        Vec::new()
    };
    let rules: Vec<SyncAlertRule> = if is_selected(&selected, "alert_rules") {
        parse_entries(&categories, "alert_rules")?
    } else {
        Vec::new()
    };
    let jobs: Vec<SyncCronJob> = if is_selected(&selected, "cron_jobs") {
        parse_entries(&categories, "cron_jobs")?
    } else {
        Vec::new()
    };
    let settings_rows: Vec<SyncSetting> = if is_selected(&selected, "settings") {
        parse_entries(&categories, "settings")?
    } else {
        Vec::new()
    };

    // 密封器先取（锁定即拒，事务开始前失败零副作用）。
    let cipher = vault.cipher()?;

    let mut applied: BTreeMap<String, usize> = BTreeMap::new();
    let mut skipped: BTreeMap<String, usize> = BTreeMap::new();

    let conn = vault.connection();
    let tx = conn.unchecked_transaction()?;

    // --- 替换删除（子行在前；级联面语义见模块文档）--------------------------
    if is_selected(&selected, "cron_jobs") {
        tx.execute("DELETE FROM cron_jobs", [])?;
    }
    if is_selected(&selected, "alert_rules") {
        tx.execute("DELETE FROM alert_rules", [])?;
    }
    if is_selected(&selected, "snippets") {
        tx.execute("DELETE FROM snippets", [])?;
    }
    if is_selected(&selected, "hosts") {
        // jump_chains 无 FK（hops JSON 列）：删主机前逐台从链上摘除（链变空
        // 级联删链），不留死 hop id——Hosts::delete 的反向补偿同款。
        let host_ids: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM hosts")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<i64>>>()?
        };
        for id in host_ids {
            remove_host_from_chains(&tx, id)?;
        }
        tx.execute("DELETE FROM hosts", [])?;
    }
    if is_selected(&selected, "host_groups") {
        tx.execute("DELETE FROM host_groups", [])?;
    }
    if is_selected(&selected, "credentials") {
        tx.execute("DELETE FROM credentials", [])?;
    }
    if is_selected(&selected, "notify_channels") {
        tx.execute("DELETE FROM notify_channels", [])?;
    }
    if is_selected(&selected, "settings") {
        // 真全量替换：非簿记键清空后落快照键；sync.* 键是本机三态基线，免疫。
        tx.execute(
            &format!("DELETE FROM settings WHERE key NOT LIKE '{SYNC_SETTINGS_PREFIX}%'"),
            [],
        )?;
    }

    // --- 插入 + id 重映射（依赖序）------------------------------------------

    // host_groups：先全插（parent 暂 NULL）再回填（源树 parent 可能 id 大于子）。
    let mut group_map: HashMap<i64, i64> = HashMap::new();
    if is_selected(&selected, "host_groups") {
        let mut map: HashMap<i64, i64> = HashMap::new();
        for g in &groups {
            tx.execute(
                "INSERT INTO host_groups (name, parent_id, color, created_at, updated_at)
                 VALUES (?1, NULL, ?2, ?3, ?4)",
                params![g.name, g.color, g.created_at, g.updated_at],
            )?;
            map.insert(g.id, tx.last_insert_rowid());
        }
        group_map = map;
        for g in &groups {
            if let Some(old_parent) = g.parent_id {
                if let Some(new_parent) = group_map.get(&old_parent) {
                    tx.execute(
                        "UPDATE host_groups SET parent_id = ?1 WHERE id = ?2",
                        params![new_parent, group_map[&g.id]],
                    )?;
                }
                // parent 不在快照内（截断快照）→ 提根（引用切断语义）。
            }
        }
        applied.insert("host_groups".into(), group_map.len());
    }

    // credentials：行落地拿 id → 同事务按新 id AAD 重密封三个密文字段。
    let mut cred_map: HashMap<i64, i64> = HashMap::new();
    if is_selected(&selected, "credentials") {
        let mut count = 0usize;
        let mut map: HashMap<i64, i64> = HashMap::new();
        for c in &credentials {
            tx.execute(
                "INSERT INTO credentials (kind, key_pub, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![c.kind.as_str(), c.key_pub, c.created_at, c.updated_at],
            )?;
            let new_id = tx.last_insert_rowid();
            for (field, plain) in [
                ("secret", c.secret.as_deref()),
                ("passphrase", c.passphrase.as_deref()),
                ("totp_secret", c.totp_secret.as_deref()),
            ] {
                let Some(plain) = plain else { continue };
                let blob = cipher.seal(plain.as_bytes(), &aad("credentials", new_id, field))?;
                tx.execute(
                    &format!("UPDATE credentials SET {field}_enc = ?1 WHERE id = ?2"),
                    params![blob, new_id],
                )?;
            }
            map.insert(c.id, new_id);
            count += 1;
        }
        cred_map = map;
        applied.insert("credentials".into(), count);
    }

    // notify_channels：占位行拿 id → 同事务密封 config（NotifyChannels::create 同款）。
    let mut chan_map: HashMap<i64, i64> = HashMap::new();
    if is_selected(&selected, "notify_channels") {
        let mut count = 0usize;
        for c in &channels {
            let overrides = c
                .template_overrides
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            tx.execute(
                "INSERT INTO notify_channels (kind, config_enc, template_overrides, enabled, created_at, updated_at)
                 VALUES (?1, zeroblob(1), ?2, ?3, ?4, ?5)",
                params![c.kind, overrides, c.enabled as i64, c.created_at, c.updated_at],
            )?;
            let new_id = tx.last_insert_rowid();
            let config_str = serde_json::to_string(&c.config)?;
            let blob = cipher.seal(
                config_str.as_bytes(),
                &aad("notify_channels", new_id, "config"),
            )?;
            tx.execute(
                "UPDATE notify_channels SET config_enc = ?1 WHERE id = ?2",
                params![blob, new_id],
            )?;
            chan_map.insert(c.id, new_id);
            count += 1;
        }
        applied.insert("notify_channels".into(), count);
    }

    let mut host_map: HashMap<i64, i64> = HashMap::new();
    if is_selected(&selected, "hosts") {
        for h in &hosts {
            tx.execute(
                "INSERT INTO hosts (name, group_id, tags, address, port, username, protocol,
                                    credential_id, encoding_override, theme_override,
                                    monitor_enabled, is_production, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    h.name,
                    h.group_id.and_then(|id| group_map.get(&id)),
                    serde_json::to_string(&h.tags)?,
                    h.address,
                    h.port,
                    h.username,
                    h.protocol.as_str(),
                    h.credential_id.and_then(|id| cred_map.get(&id)),
                    h.encoding_override,
                    h.theme_override,
                    h.monitor_enabled as i64,
                    h.is_production as i64,
                    h.notes,
                    h.created_at,
                    h.updated_at,
                ],
            )?;
            host_map.insert(h.id, tx.last_insert_rowid());
        }
        applied.insert("hosts".into(), host_map.len());
    }

    if is_selected(&selected, "snippets") {
        let mut count = 0usize;
        for s in &snippets {
            tx.execute(
                "INSERT INTO snippets (name, body, variables, tags, host_scope, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    s.name,
                    s.body,
                    serde_json::to_string(&s.variables)?,
                    serde_json::to_string(&s.tags)?,
                    s.host_scope.and_then(|id| host_map.get(&id)),
                    s.created_at,
                    s.updated_at,
                ],
            )?;
            count += 1;
        }
        applied.insert("snippets".into(), count);
    }

    if is_selected(&selected, "alert_rules") {
        let (mut count, mut skip) = (0usize, 0usize);
        for r in &rules {
            let Some(host_id) = host_map.get(&r.host_id) else {
                skip += 1; // host_id NOT NULL：宿主不可重映射 → 整行跳过（不静默造悬空行）
                continue;
            };
            let channels_json = remap_channel_ids(&r.channels, &chan_map);
            tx.execute(
                "INSERT INTO alert_rules (host_id, kind, params, channels, rate_limit, mute_window, last_fired, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)",
                params![
                    host_id,
                    r.kind,
                    serde_json::to_string(&r.params)?,
                    serde_json::to_string(&channels_json)?,
                    r.rate_limit,
                    r.mute_window,
                    r.created_at,
                    r.updated_at,
                ],
            )?;
            count += 1;
        }
        applied.insert("alert_rules".into(), count);
        skipped.insert("alert_rules".into(), skip);
    }

    if is_selected(&selected, "cron_jobs") {
        let (mut count, mut skip) = (0usize, 0usize);
        for j in &jobs {
            let Some(host_id) = host_map.get(&j.host_id) else {
                skip += 1;
                continue;
            };
            let channels_json = remap_channel_ids(&j.channels, &chan_map);
            tx.execute(
                "INSERT INTO cron_jobs (host_id, schedule, script, channels, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    host_id,
                    j.schedule.trim(),
                    j.script,
                    serde_json::to_string(&channels_json)?,
                    j.enabled as i64,
                    j.created_at,
                    j.updated_at,
                ],
            )?;
            count += 1;
        }
        applied.insert("cron_jobs".into(), count);
        skipped.insert("cron_jobs".into(), skip);
    }

    if is_selected(&selected, "settings") {
        let mut count = 0usize;
        for s in &settings_rows {
            tx.execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![s.key, serde_json::to_string(&s.value)?],
            )?;
            count += 1;
        }
        applied.insert("settings".into(), count);
    }

    tx.commit()?;
    Ok(SyncImportReport { applied, skipped })
}

/// channels 数组逐 id 重映射；不可映射（渠道分类不在所选集）的剔除、可映射的
/// 保留——规则/任务本身有效，只失去对未同步渠道的订阅。
fn remap_channel_ids(channels: &[i64], map: &HashMap<i64, i64>) -> Vec<i64> {
    channels
        .iter()
        .filter_map(|id| map.get(id).copied())
        .collect()
}
