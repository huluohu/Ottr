//! sync_snapshot TDD（Phase 5 Task 3——同步分类快照导出/导入）：
//! 八类导出形状（版本字段 + 确定性输出 + 本地性剥离：jump_chain_id /
//! last_fired / sync.* settings 键）+ 双层加密语义的明文面（凭据三字段与渠道
//! config 解密进快照）+ 全量替换导入（跨库 roundtrip、id 重映射、引用保留/
//! 切断、hostless 规则跳过、settings 替换与 sync.* 免疫、jump chain 反向补偿、
//! 单事务原子性、损坏快照显式拒绝、锁定拒绝）。
//! 纪律（同 notify_channels_test）：tempfile 临时目录 + InMemoryStorage。

use serde_json::{Value, json};

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    AlertRuleInput, AlertRules, CredentialInput, CredentialKind, CredentialPatch, Credentials,
    CronJobInput, CronJobs, HostGroups, HostInput, HostProtocol, Hosts, JumpChainInput, JumpChains,
    NotifyChannelInput, NotifyChannels, SYNC_CATEGORIES, SYNC_DATA_VERSION, SecretField, Settings,
    SnippetInput, Snippets, SyncImportMode, Vault, VaultError, sync_snapshot,
};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn all_cats() -> Vec<String> {
    SYNC_CATEGORIES.iter().map(|s| s.to_string()).collect()
}

fn host_input(name: &str, group: Option<i64>, cred: Option<i64>) -> HostInput {
    HostInput {
        name: name.into(),
        group_id: group,
        tags: vec!["web".into()],
        address: format!("10.0.0.{name}.example"),
        port: 22,
        username: Some("deploy".into()),
        protocol: HostProtocol::Ssh,
        credential_id: cred,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: false,
        is_production: false,
        notes: None,
    }
}

/// 富数据源库（A）：分组树（父子两层）、两类凭据（密码型含 secret+totp、密钥型
/// 含 key_pub+passphrase）、两台主机（绑分组/凭据/跳板链）、snippet（scope 到
/// 主机）、渠道（密文 config）、告警规则（订阅渠道 + 已触发水位）、cron 任务、
/// settings（含 sync.* 簿记键）。
fn seed_source(vault: &Vault) {
    let g1 = HostGroups::create(vault, "prod", None, Some("#ff0000")).unwrap();
    let _g2 = HostGroups::create(vault, "prod/web", Some(g1.id), Some("#00ff00")).unwrap();
    let c1 = Credentials::create(
        vault,
        &CredentialInput {
            name: None,
            kind: CredentialKind::Password,
            secret: Some("SECRET-PASSWORD-42".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: Some("TOTP-SEED-43".into()),
        },
    )
    .unwrap();
    let c2 = Credentials::create(
        vault,
        &CredentialInput {
            name: None,
            kind: CredentialKind::Key,
            secret: None,
            key_pub: Some("ssh-ed25519 AAAA PUBLIC-KEY".into()),
            passphrase: Some("KEY-PASS-44".into()),
            totp_secret: None,
        },
    )
    .unwrap();
    let h1 = Hosts::create(vault, host_input("alpha", Some(g1.id), Some(c1.id))).unwrap();
    let h2 = Hosts::create(
        vault,
        HostInput {
            name: "beta".into(),
            protocol: HostProtocol::Ftp,
            is_production: true,
            ..host_input("beta", None, Some(c2.id))
        },
    )
    .unwrap();
    // 跳板链绑定（jump_chains 不在同步集——导出必须剥离该引用）
    let chain = JumpChains::create(
        vault,
        &JumpChainInput {
            name: "edge".into(),
            hops: vec![h1.id],
        },
    )
    .unwrap();
    Hosts::update(
        vault,
        h1.id,
        HostInput {
            jump_chain_id: Some(chain.id),
            ..host_input("alpha", Some(g1.id), Some(c1.id))
        },
    )
    .unwrap();
    Snippets::create(
        vault,
        &SnippetInput {
            name: "deploy".into(),
            body: "systemctl restart {{svc}}".into(),
            variables: vec!["svc".into()],
            tags: vec![],
            host_scope: Some(h1.id),
        },
    )
    .unwrap();
    let ch1 = NotifyChannels::create(
        vault,
        &NotifyChannelInput {
            kind: "dingtalk".into(),
            config: json!({ "webhook": "https://oapi.example/robot/send?access_token=SECRET-TOKEN-45" }),
            template_overrides: None,
            enabled: true,
        },
    )
    .unwrap();
    let rule = AlertRules::create(
        vault,
        &AlertRuleInput {
            host_id: h1.id,
            kind: "cpu".into(),
            params: json!({ "threshold": 90, "consecutive": 3 }),
            channels: vec![ch1.id],
            rate_limit: 60,
            mute_window: Some("22:00-08:00".into()),
        },
    )
    .unwrap();
    // 触发水位 = 本机运行态（导出必须剥离）
    AlertRules::mark_fired(vault, rule.id, 1_700_000_000).unwrap();
    CronJobs::create(
        vault,
        &CronJobInput {
            host_id: h2.id,
            schedule: "*/5 * * * *".into(),
            script: "df -h".into(),
            channels: vec![ch1.id],
            enabled: true,
        },
    )
    .unwrap();
    Settings::set(vault, "ui.theme", &json!("dark")).unwrap();
    Settings::set(vault, "security.autolock_minutes", &json!(15)).unwrap();
    Settings::set(
        vault,
        "sync.state",
        &json!({ "remote_fp": "abc", "local_fp": "def" }),
    )
    .unwrap();
}

fn cat<'a>(snapshot: &'a Value, name: &str) -> &'a Vec<Value> {
    snapshot["categories"][name]
        .as_array()
        .unwrap_or_else(|| panic!("category {name} missing"))
}

// --- 导出形状 -----------------------------------------------------------------

/// 空库导出：八类齐全、空数组、两次导出逐字节相同（确定性——三态判定的本机
/// 数据指纹前提）；范围校验（空/未知/重复分类显式拒绝）。
#[test]
fn export_is_deterministic_and_validates_scope() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let a = sync_snapshot::export_categories(&vault, &all_cats()).unwrap();
    let b = sync_snapshot::export_categories(&vault, &all_cats()).unwrap();
    assert_eq!(a["version"], json!(SYNC_DATA_VERSION));
    for cat_name in SYNC_CATEGORIES {
        assert!(a["categories"][cat_name].is_array(), "缺分类 {cat_name}");
        assert_eq!(a["categories"][cat_name].as_array().unwrap().len(), 0);
    }
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap(),
        "同数据两次导出必须逐字节相同"
    );

    for bad in [
        vec![],
        vec!["hosts".to_string(), "nonsense".to_string()],
        vec!["hosts".to_string(), "hosts".to_string()],
    ] {
        assert!(
            sync_snapshot::export_categories(&vault, &bad).is_err(),
            "范围 {bad:?} 应拒绝"
        );
    }
}

/// 本地性剥离 + 明文面：jump_chain_id / last_fired 不出库、sync.* settings 不出
/// 库；凭据三字段与渠道 config 解密为明文进快照（信封在 TS 侧整体加密）。
#[test]
fn export_strips_local_only_fields_and_reveals_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    seed_source(&vault);

    let snap = sync_snapshot::export_categories(&vault, &all_cats()).unwrap();

    for h in cat(&snap, "hosts") {
        assert!(!h.as_object().unwrap().contains_key("jump_chain_id"));
    }
    assert_eq!(cat(&snap, "hosts").len(), 2);
    for r in cat(&snap, "alert_rules") {
        assert!(!r.as_object().unwrap().contains_key("last_fired"));
    }
    assert_eq!(cat(&snap, "alert_rules").len(), 1);

    let creds = cat(&snap, "credentials");
    assert_eq!(creds.len(), 2);
    let by_kind = |kind: &str| {
        creds
            .iter()
            .find(|c| c["kind"] == kind)
            .unwrap_or_else(|| panic!("credential kind {kind} missing"))
    };
    let pw = by_kind("password");
    assert_eq!(pw["secret"], "SECRET-PASSWORD-42");
    assert_eq!(pw["totp_secret"], "TOTP-SEED-43");
    let key = by_kind("key");
    assert_eq!(key["passphrase"], "KEY-PASS-44");
    assert_eq!(key["key_pub"], "ssh-ed25519 AAAA PUBLIC-KEY");

    let ch = &cat(&snap, "notify_channels")[0];
    assert_eq!(
        ch["config"]["webhook"],
        "https://oapi.example/robot/send?access_token=SECRET-TOKEN-45"
    );

    let settings = cat(&snap, "settings");
    let keys: Vec<&str> = settings
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert!(keys.contains(&"ui.theme") && keys.contains(&"security.autolock_minutes"));
    assert!(
        !keys.iter().any(|k| k.starts_with("sync.")),
        "sync.* 簿记键不得进快照：{keys:?}"
    );
}

// --- 全量替换导入：跨库 roundtrip + id 重映射 ----------------------------------

#[test]
fn roundtrip_full_snapshot_into_fresh_vault() {
    let dir_a = tempfile::tempdir().unwrap();
    let vault_a = open_vault(dir_a.path());
    seed_source(&vault_a);
    let snap = sync_snapshot::export_categories(&vault_a, &all_cats()).unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let vault_b = open_vault(dir_b.path());
    let report =
        sync_snapshot::import_categories(&vault_b, &all_cats(), &snap, SyncImportMode::Replace)
            .unwrap();
    assert_eq!(report.applied.get("host_groups"), Some(&2));
    assert_eq!(report.applied.get("credentials"), Some(&2));
    assert_eq!(report.applied.get("hosts"), Some(&2));
    assert_eq!(report.applied.get("snippets"), Some(&1));
    assert_eq!(report.applied.get("notify_channels"), Some(&1));
    assert_eq!(report.applied.get("alert_rules"), Some(&1));
    assert_eq!(report.applied.get("cron_jobs"), Some(&1));
    assert_eq!(report.applied.get("settings"), Some(&2));
    assert!(report.skipped.values().all(|&n| n == 0), "全量导入无跳过");

    // 分组树关系随 id 重映射保持：子组的父 = 名为 "prod" 的新组
    let groups = HostGroups::list(&vault_b).unwrap();
    assert_eq!(groups.len(), 2);
    let child = groups.iter().find(|g| g.name == "prod/web").unwrap();
    let parent = groups
        .iter()
        .find(|g| Some(g.id) == child.parent_id)
        .unwrap();
    assert_eq!(parent.name, "prod");
    assert_eq!(parent.color.as_deref(), Some("#ff0000"));

    // 凭据：明文 roundtrip（B 库按 B 的本机密钥重密封——reveal 可开封即证）
    let creds = Credentials::list(&vault_b).unwrap();
    assert_eq!(creds.len(), 2);
    let pw = creds
        .iter()
        .find(|c| c.kind == CredentialKind::Password)
        .unwrap();
    assert_eq!(
        Credentials::reveal(&vault_b, pw.id, SecretField::Secret).unwrap(),
        Some("SECRET-PASSWORD-42".to_string())
    );
    assert_eq!(
        Credentials::reveal(&vault_b, pw.id, SecretField::TotpSecret).unwrap(),
        Some("TOTP-SEED-43".to_string())
    );
    let key = creds
        .iter()
        .find(|c| c.kind == CredentialKind::Key)
        .unwrap();
    assert_eq!(key.key_pub.as_deref(), Some("ssh-ed25519 AAAA PUBLIC-KEY"));
    assert_eq!(
        Credentials::reveal(&vault_b, key.id, SecretField::Passphrase).unwrap(),
        Some("KEY-PASS-44".to_string())
    );

    // 主机：group/credential 引用指向新库真实实体；jump_chain_id 已切断
    let hosts = Hosts::list(&vault_b).unwrap();
    let alpha = hosts.iter().find(|h| h.name == "alpha").unwrap();
    let beta = hosts.iter().find(|h| h.name == "beta").unwrap();
    assert_eq!(alpha.group_id, Some(parent.id));
    assert_eq!(
        Credentials::reveal(&vault_b, alpha.credential_id.unwrap(), SecretField::Secret).unwrap(),
        Some("SECRET-PASSWORD-42".to_string())
    );
    assert_eq!(
        alpha.jump_chain_id, None,
        "jump_chains 不在同步集，引用切断"
    );
    assert_eq!(beta.protocol, HostProtocol::Ftp);
    assert!(beta.is_production);

    // 密文落库直查（B 库文件无导出明文残留）
    let blob: Option<Vec<u8>> = vault_b
        .connection()
        .query_row(
            "SELECT secret_enc FROM credentials WHERE id = ?1",
            [pw.id],
            |r| r.get(0),
        )
        .unwrap();
    let blob = blob.expect("secret_enc 已密封");
    let as_text = String::from_utf8_lossy(&blob).to_string();
    assert!(!as_text.contains("SECRET-PASSWORD-42"), "库内无明文");

    // 渠道 config roundtrip
    let ch = NotifyChannels::list(&vault_b).unwrap();
    assert_eq!(ch.len(), 1);
    assert_eq!(
        NotifyChannels::reveal_config(&vault_b, ch[0].id).unwrap()["webhook"],
        "https://oapi.example/robot/send?access_token=SECRET-TOKEN-45"
    );

    // 规则/任务：host 与 channels 都重映射到新 id；last_fired 重置 NULL
    let rules = AlertRules::list(&vault_b).unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].host_id, alpha.id);
    assert_eq!(rules[0].channels, vec![ch[0].id]);
    assert_eq!(rules[0].last_fired, None);
    assert_eq!(rules[0].mute_window.as_deref(), Some("22:00-08:00"));
    let jobs = CronJobs::list(&vault_b).unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].host_id, beta.id);
    assert_eq!(jobs[0].channels, vec![ch[0].id]);

    // snippet host_scope 重映射到新主机
    let snippets = Snippets::list(&vault_b).unwrap();
    assert_eq!(snippets[0].host_scope, Some(alpha.id));

    // settings：值 roundtrip；sync.* 不随数据走
    assert_eq!(
        Settings::get(&vault_b, "ui.theme").unwrap(),
        Some(json!("dark"))
    );
    assert_eq!(
        Settings::get(&vault_b, "security.autolock_minutes").unwrap(),
        Some(json!(15))
    );
    assert_eq!(Settings::get(&vault_b, "sync.state").unwrap(), None);
}

// --- 子集导入：引用切断 + hostless 行跳过 --------------------------------------

#[test]
fn import_subset_severs_references_and_skips_hostless_rules() {
    let dir_a = tempfile::tempdir().unwrap();
    let vault_a = open_vault(dir_a.path());
    seed_source(&vault_a);
    let snap = sync_snapshot::export_categories(&vault_a, &all_cats()).unwrap();

    // 只导 hosts：分组/凭据不在所选集 → 引用切断（NULL）
    let dir_b = tempfile::tempdir().unwrap();
    let vault_b = open_vault(dir_b.path());
    let report = sync_snapshot::import_categories(
        &vault_b,
        &["hosts".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.applied.get("hosts"), Some(&2));
    let hosts = Hosts::list(&vault_b).unwrap();
    assert!(
        hosts
            .iter()
            .all(|h| h.group_id.is_none() && h.credential_id.is_none())
    );
    assert_eq!(HostGroups::list(&vault_b).unwrap().len(), 0);

    // 只导 alert_rules：host_id NOT NULL 且 hosts 不在所选集 → 整行跳过
    let dir_c = tempfile::tempdir().unwrap();
    let vault_c = open_vault(dir_c.path());
    let report = sync_snapshot::import_categories(
        &vault_c,
        &["alert_rules".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.applied.get("alert_rules"), Some(&0));
    assert_eq!(report.skipped.get("alert_rules"), Some(&1));
    assert!(AlertRules::list(&vault_c).unwrap().is_empty());

    // 只导 cron_jobs：同上
    let report = sync_snapshot::import_categories(
        &vault_c,
        &["cron_jobs".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.skipped.get("cron_jobs"), Some(&1));

    // hosts+alert_rules 同导：规则保住、channels 订阅被切断（渠道不在所选集）
    let dir_d = tempfile::tempdir().unwrap();
    let vault_d = open_vault(dir_d.path());
    let report = sync_snapshot::import_categories(
        &vault_d,
        &["hosts".to_string(), "alert_rules".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.applied.get("alert_rules"), Some(&1));
    assert_eq!(report.skipped.get("alert_rules"), Some(&0));
    assert!(AlertRules::list(&vault_d).unwrap()[0].channels.is_empty());
}

// --- 全量替换语义 + settings 替换的 sync.* 免疫 --------------------------------

#[test]
fn import_is_full_replacement_and_sync_settings_survive() {
    let dir_empty = tempfile::tempdir().unwrap();
    let vault_empty = open_vault(dir_empty.path());
    Settings::set(&vault_empty, "ui.language", &json!("en-US")).unwrap();
    let snap = sync_snapshot::export_categories(&vault_empty, &all_cats()).unwrap();

    let dir_e = tempfile::tempdir().unwrap();
    let vault_e = open_vault(dir_e.path());
    seed_source(&vault_e);
    Settings::set(&vault_e, "local.only", &json!(1)).unwrap();

    let report =
        sync_snapshot::import_categories(&vault_e, &all_cats(), &snap, SyncImportMode::Replace)
            .unwrap();
    assert_eq!(report.applied.get("hosts"), Some(&0));
    assert_eq!(report.applied.get("settings"), Some(&1));

    // 全量替换：源库数据清空（配置回落快照形态）
    assert!(Hosts::list(&vault_e).unwrap().is_empty());
    assert!(HostGroups::list(&vault_e).unwrap().is_empty());
    assert!(Credentials::list(&vault_e).unwrap().is_empty());
    assert!(NotifyChannels::list(&vault_e).unwrap().is_empty());

    // settings 真替换：非簿记键回落快照（ui.theme 被清、ui.language 落地、
    // local.only 被清）；本机三态基线 sync.state 免疫
    assert_eq!(Settings::get(&vault_e, "ui.theme").unwrap(), None);
    assert_eq!(
        Settings::get(&vault_e, "ui.language").unwrap(),
        Some(json!("en-US"))
    );
    assert_eq!(Settings::get(&vault_e, "local.only").unwrap(), None);
    assert_eq!(
        Settings::get(&vault_e, "sync.state").unwrap(),
        Some(json!({ "remote_fp": "abc", "local_fp": "def" }))
    );
}

// --- jump_chains 反向补偿 -------------------------------------------------------

/// 替换 hosts 前逐台从链上摘除（Hosts::delete 同款补偿）：不留死 hop id，
/// 链空则级联删链。
#[test]
fn import_replacing_hosts_compensates_jump_chains() {
    let dir_empty = tempfile::tempdir().unwrap();
    let vault_empty = open_vault(dir_empty.path());
    let snap = sync_snapshot::export_categories(&vault_empty, &all_cats()).unwrap();

    let dir_h = tempfile::tempdir().unwrap();
    let vault_h = open_vault(dir_h.path());
    let h1 = Hosts::create(&vault_h, host_input("alpha", None, None)).unwrap();
    JumpChains::create(
        &vault_h,
        &JumpChainInput {
            name: "edge".into(),
            hops: vec![h1.id],
        },
    )
    .unwrap();

    sync_snapshot::import_categories(
        &vault_h,
        &["hosts".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();

    assert!(Hosts::list(&vault_h).unwrap().is_empty());
    assert!(
        JumpChains::list(&vault_h).unwrap().is_empty(),
        "链空后级联删链，不留悬空 hops"
    );
}

// --- 校验 + 原子性 --------------------------------------------------------------

#[test]
fn import_rejects_corrupt_snapshots_atomically() {
    let dir_a = tempfile::tempdir().unwrap();
    let vault_a = open_vault(dir_a.path());
    seed_source(&vault_a);
    let snap = sync_snapshot::export_categories(&vault_a, &all_cats()).unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let vault_b = open_vault(dir_b.path());
    let g = HostGroups::create(&vault_b, "local", None, None).unwrap();

    // 版本不符 / categories 缺失 / 所选分类缺失 / 条目损坏 → 全部显式拒绝
    let mut bad_version = snap.clone();
    bad_version["version"] = json!(99);
    let no_categories = json!({ "version": SYNC_DATA_VERSION });
    let mut missing_cat = snap.clone();
    missing_cat["categories"]
        .as_object_mut()
        .unwrap()
        .remove("hosts");
    let mut malformed = snap.clone();
    malformed["categories"]["hosts"] = json!([{ "address": "x" }]); // 缺 name 等必填字段

    for (label, bad) in [
        ("version", &bad_version),
        ("no_categories", &no_categories),
        ("missing_cat", &missing_cat),
        ("malformed", &malformed),
    ] {
        let err =
            sync_snapshot::import_categories(&vault_b, &all_cats(), bad, SyncImportMode::Replace)
                .unwrap_err();
        assert!(matches!(err, VaultError::InvalidInput(_)), "{label}: {err}");
    }

    // 原子性：以上任何一次失败都不动现有数据（groups 未被替换清空）
    assert_eq!(HostGroups::list(&vault_b).unwrap().len(), 1);
    assert_eq!(
        HostGroups::get(&vault_b, g.id).unwrap().unwrap().name,
        "local"
    );

    // 空分类集 / 未知分类
    assert!(
        sync_snapshot::import_categories(&vault_b, &[], &snap, SyncImportMode::Replace).is_err()
    );
    assert!(
        sync_snapshot::import_categories(
            &vault_b,
            &["nonsense".to_string()],
            &snap,
            SyncImportMode::Replace
        )
        .is_err()
    );

    // mode 参数面：serde 小写反序列化（未知语义拒绝在反序列化层）
    assert_eq!(
        serde_json::from_value::<SyncImportMode>(json!("replace")).unwrap(),
        SyncImportMode::Replace
    );
    assert!(serde_json::from_value::<SyncImportMode>(json!("merge")).is_err());
}

// --- 锁定语义 -------------------------------------------------------------------

/// 密钥面拒绝：锁定（password 模式）时，含凭据的导出与一切导入都拒绝
/// （要开封/重密封密文）。desktop 命令层另有 ensure_unlocked 门卫统一文案。
#[test]
fn locked_vault_rejects_secret_bearing_export_and_any_import() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_password_only(dir.path()).unwrap();
    // 首次解锁 = 设置主密码 → 造一条带密文的凭据 → 再锁定
    vault.unlock_with_password("master-pass-1").unwrap();
    Credentials::create(
        &vault,
        &CredentialInput {
            name: None,
            kind: CredentialKind::Password,
            secret: Some("LOCKED-SECRET".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: None,
        },
    )
    .unwrap();
    vault.lock();
    assert!(vault.is_locked());

    // 库里有凭据 → 导出 credentials 要开封 → Locked
    let err = sync_snapshot::export_categories(&vault, &["credentials".to_string()]).unwrap_err();
    assert!(matches!(err, VaultError::Locked));

    // 合法形状的空快照（校验通过）→ 走到密封器 → Locked
    let empty = json!({ "version": SYNC_DATA_VERSION, "categories": { "hosts": [] } });
    let err = sync_snapshot::import_categories(
        &vault,
        &["hosts".to_string()],
        &empty,
        SyncImportMode::Replace,
    )
    .unwrap_err();
    assert!(matches!(err, VaultError::Locked));
}

// --- CredentialPatch 保留语义对照（导入不触碰既有凭据补丁面——回归哨兵）----------

/// 导入全量替换所选分类，但不经 CredentialPatch 路径——此处验证导入后原库
/// update 语义不受影响（未重输的密钥不重密封）。
#[test]
fn credential_patch_semantics_unaffected_after_import() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    seed_source(&vault);
    let snap = sync_snapshot::export_categories(&vault, &all_cats()).unwrap();

    let dir_b = tempfile::tempdir().unwrap();
    let vault_b = open_vault(dir_b.path());
    sync_snapshot::import_categories(&vault_b, &all_cats(), &snap, SyncImportMode::Replace)
        .unwrap();

    let c = &Credentials::list(&vault_b).unwrap()[0];
    let updated = Credentials::update(
        &vault_b,
        c.id,
        &CredentialPatch {
            kind: None,
            name: None,
            secret: None, // None = 保留现值
            key_pub: Some("ssh-ed25519 NEW".into()),
            passphrase: None,
            totp_secret: None,
        },
    )
    .unwrap();
    assert_eq!(updated.key_pub.as_deref(), Some("ssh-ed25519 NEW"));
    assert_eq!(
        Credentials::reveal(&vault_b, c.id, SecretField::Secret).unwrap(),
        Some("SECRET-PASSWORD-42".to_string())
    );
}

// --- settings 导入防线（fix round 1 I-1）----------------------------------------

/// 敌意/损坏快照的 settings 导入三防线：`sync.*` 簿记键不覆写本机三态基线；
/// 已知键越界值不落库（与 settings_set 同一注册表——validate_known_setting）；
/// 合法键照常导入。全部计 skipped，不拖垮其余键。
#[test]
fn import_settings_filters_sync_keys_and_validates_known_keys() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    // 本机现状：三态基线 + 合法安全配置
    Settings::set(
        &vault,
        "sync.state",
        &json!({ "remote_fp": "MINE", "local_fp": "MINE" }),
    )
    .unwrap();
    Settings::set(&vault, "security.autolock_minutes", &json!(10)).unwrap();
    Settings::set(&vault, "ui.theme", &json!("dark")).unwrap();

    // 手工构造快照（绕过导出剥离面——正是敌意来源的形态）：
    // sync.state 覆写企图 + 越界 autolock + 非法 theme + 两个合法键
    let snap = json!({
        "version": SYNC_DATA_VERSION,
        "categories": { "settings": [
            { "key": "sync.state", "value": { "remote_fp": "FORGED", "local_fp": "FORGED" } },
            { "key": "security.autolock_minutes", "value": 99_999 },
            { "key": "ui.theme", "value": "purple" },
            { "key": "ui.language", "value": "en-US" },
            { "key": "security.clipboard_clear_secs", "value": 30 },
        ]}
    });
    let report = sync_snapshot::import_categories(
        &vault,
        &["settings".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.applied.get("settings"), Some(&2));
    assert_eq!(report.skipped.get("settings"), Some(&3));

    // 本机基线不被覆写（伪造已同步会掩盖真实分歧）
    assert_eq!(
        Settings::get(&vault, "sync.state").unwrap(),
        Some(json!({ "remote_fp": "MINE", "local_fp": "MINE" }))
    );
    // 越界/类型错不落库，现值保持
    assert_eq!(
        Settings::get(&vault, "security.autolock_minutes").unwrap(),
        Some(json!(10))
    );
    assert_eq!(
        Settings::get(&vault, "ui.theme").unwrap(),
        Some(json!("dark"))
    );
    // 合法键照常导入
    assert_eq!(
        Settings::get(&vault, "ui.language").unwrap(),
        Some(json!("en-US"))
    );
    assert_eq!(
        Settings::get(&vault, "security.clipboard_clear_secs").unwrap(),
        Some(json!(30))
    );
}

// --- host_groups 父子环防线（fix round 1 Minor）----------------------------------

/// 损坏快照的 parent_id 环（互环/自环）导入后被断开：树可安全遍历（任一结点
/// 上行步数 ≤ 组数），正常子树不受牵连。
#[test]
fn import_severs_parent_cycles_in_corrupt_snapshot() {
    let snap = json!({
        "version": SYNC_DATA_VERSION,
        "categories": { "host_groups": [
            { "id": 1, "name": "a", "parent_id": 2, "color": null, "created_at": 1, "updated_at": 1 },
            { "id": 2, "name": "b", "parent_id": 1, "color": null, "created_at": 1, "updated_at": 1 },
            { "id": 3, "name": "self", "parent_id": 3, "color": null, "created_at": 1, "updated_at": 1 },
            { "id": 4, "name": "child-of-cycle", "parent_id": 1, "color": null, "created_at": 1, "updated_at": 1 },
        ]}
    });
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let report = sync_snapshot::import_categories(
        &vault,
        &["host_groups".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap();
    assert_eq!(report.applied.get("host_groups"), Some(&4));

    // 断言无环：从任一结点沿 parent 上行 ≤ 组数步必达根（有环则超界 panic）
    let groups = HostGroups::list(&vault).unwrap();
    assert_eq!(groups.len(), 4);
    for g in &groups {
        let mut cur = Some(g.id);
        let mut steps = 0usize;
        while let Some(id) = cur {
            steps += 1;
            assert!(steps <= groups.len(), "环未断开：从 {} 上行超界", g.name);
            let row = groups.iter().find(|x| x.id == id).unwrap();
            cur = row.parent_id;
        }
    }
    // 环上结点已被提根/断边：互环两结点至少一个 parent 为 None；自环结点 parent 为 None
    let by_name = |n: &str| groups.iter().find(|x| x.name == n).unwrap();
    assert!(
        by_name("a").parent_id.is_none() || by_name("b").parent_id.is_none(),
        "互环 a↔b 至少断一边"
    );
    assert!(by_name("self").parent_id.is_none(), "自环已提根");
    // 正常子树不受牵连：child-of-cycle 挂在 a 或 b 之下（引用仍可解析）
    let child = by_name("child-of-cycle");
    let parent = groups
        .iter()
        .find(|x| Some(x.id) == child.parent_id)
        .expect("child-of-cycle 的 parent 引用保留");
    assert!(parent.name == "a" || parent.name == "b");
}

/// BL-206：导入**写入段**中途失败的反馈——错误必须带「失败在哪个分类」的
/// 上下文（此前裸穿 rusqlite 原文，UI/日志无法定位坏在哪一类），且单事务
/// 原子回滚语义不变。构造：手工快照携带两个同级同名根分组（0018 部分唯一
/// 索引在第二条 INSERT 上失败——parse/预校验全过、写段才炸的 exactly 场景）。
#[test]
fn import_mid_write_failure_names_category_and_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let vault_b = open_vault(dir.path());
    HostGroups::create(&vault_b, "survivor", None, None).unwrap();

    let snap = json!({
        "version": SYNC_DATA_VERSION,
        "categories": {
            "host_groups": [
                { "id": 1, "name": "dup", "parent_id": null, "color": null,
                  "created_at": 1, "updated_at": 1 },
                { "id": 2, "name": "dup", "parent_id": null, "color": null,
                  "created_at": 2, "updated_at": 2 }
            ]
        }
    });
    let err = sync_snapshot::import_categories(
        &vault_b,
        &["host_groups".to_string()],
        &snap,
        SyncImportMode::Replace,
    )
    .unwrap_err();
    match &err {
        VaultError::ImportStep { category, source } => {
            assert_eq!(category, "host_groups");
            assert!(
                source.to_string().to_lowercase().contains("unique"),
                "底层错误可经 source 追溯，实际 {source}"
            );
        }
        other => panic!("expected ImportStep, got {other:?}"),
    }
    // Display 面直接带分类（错误直达 UI/日志时可定位）。
    assert!(err.to_string().contains("host_groups"), "{}", err);
    // 原子回滚不变：既有分组幸存、快照零落库。
    let groups = HostGroups::list(&vault_b).unwrap();
    assert_eq!(groups.len(), 1, "快照写入必须整体回滚");
    assert_eq!(groups[0].name, "survivor");
}
