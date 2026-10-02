//! alert_rules TDD（Phase 3 Task 3，B5 告警规则引擎——存储侧）：
//! 0013 迁移建表、create/list/update/delete 回读、kind 合法集校验、params
//! 必须 JSON 对象、mute_window 形状校验、rate_limit 非负、FK 悬空拒绝、
//! mark_fired 水位回写 + update 不清水位、host 删除 CASCADE、未知 id NotFound。
//! 纪律（同 notifications_test）：tempfile 临时目录 + InMemoryStorage，绝不
//! 触碰真实用户目录与真钥匙链。明文面（无 *_enc 列，不涉 scan_registry 守卫）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{AlertRuleInput, AlertRules, HostInput, Hosts, Vault, VaultError};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn host_input(name: &str) -> HostInput {
    HostInput {
        protocol: Default::default(),
        name: name.into(),
        group_id: None,
        tags: vec![],
        address: "10.0.0.1".into(),
        port: 22,
        username: Some("deploy".into()),
        credential_id: None,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: true,
        is_production: false,
        notes: None,
    }
}

fn input(host_id: i64) -> AlertRuleInput {
    AlertRuleInput {
        host_id,
        kind: "disk".into(),
        params: serde_json::json!({ "mount": "/", "threshold": 90 }),
        channels: vec![1, 2],
        rate_limit: 300,
        mute_window: None,
    }
}

/// 0013 迁移建表 + create/list 回读（id/ts 存储层定、last_fired 初值 NULL、
/// params/channels JSON 无损往返）。
#[test]
fn migration_0013_creates_alert_rules_and_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let row = AlertRules::create(&vault, &input(h.id)).unwrap();
    assert!(row.id > 0);
    assert!(row.created_at > 0);
    assert_eq!(row.last_fired, None, "新规则从未触发");
    assert_eq!(row.params["threshold"], 90, "params JSON 往返无损");
    assert_eq!(row.channels, vec![1, 2], "channels 数组往返无损");

    let listed = AlertRules::list(&vault).unwrap();
    assert_eq!(listed, vec![row.clone()], "serde 面逐字段回读一致");
}

/// kind 合法集校验（disk/cpu/process/log 放行——log 存储面放行、引擎延后；
/// 其他拒绝）+ params 非对象拒绝 + mute_window 形状拒绝 + rate_limit 负数拒绝。
#[test]
fn input_validation_rejects_bad_kind_params_window_ratelimit() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    for kind in ["disk", "cpu", "process", "log"] {
        let mut i = input(h.id);
        i.kind = kind.into();
        assert!(AlertRules::create(&vault, &i).is_ok(), "kind={kind} 放行");
    }
    let mut i = input(h.id);
    i.kind = "memory".into();
    assert_eq!(
        AlertRules::create(&vault, &i).unwrap_err().to_string(),
        VaultError::InvalidInput("unknown alert rule kind: memory (disk/cpu/process/log)".into())
            .to_string()
    );

    let mut i = input(h.id);
    i.params = serde_json::json!([1, 2]);
    assert!(AlertRules::create(&vault, &i).is_err(), "params 必须是对象");

    let mut i = input(h.id);
    i.mute_window = Some("25:00-99:99".into());
    assert!(
        AlertRules::create(&vault, &i).is_err(),
        "mute_window 形状不对（HH:MM-HH:MM）"
    );
    let mut i = input(h.id);
    i.mute_window = Some("22:00-08:00".into());
    assert!(AlertRules::create(&vault, &i).is_ok(), "合法静音窗放行");

    let mut i = input(h.id);
    i.rate_limit = -1;
    assert!(AlertRules::create(&vault, &i).is_err(), "rate_limit 非负");
}

/// update 全量替换（last_fired 水位保持）+ mark_fired 回写 + 未知 id NotFound。
#[test]
fn update_keeps_fired_watermark_and_mark_fired_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    let rule = AlertRules::create(&vault, &input(h.id)).unwrap();

    AlertRules::mark_fired(&vault, rule.id, 1_700_000_000).unwrap();
    assert_eq!(
        AlertRules::get(&vault, rule.id)
            .unwrap()
            .unwrap()
            .last_fired,
        Some(1_700_000_000),
        "水位回写"
    );

    let mut patch = input(h.id);
    patch.kind = "cpu".into();
    patch.params = serde_json::json!({ "threshold": 85, "consecutive": 3 });
    let updated = AlertRules::update(&vault, rule.id, &patch).unwrap();
    assert_eq!(updated.kind, "cpu");
    assert_eq!(
        updated.last_fired,
        Some(1_700_000_000),
        "编辑配置不清防重复水位"
    );
    assert!(updated.updated_at >= updated.created_at);

    assert_eq!(
        AlertRules::mark_fired(&vault, 9999, 0)
            .unwrap_err()
            .to_string(),
        VaultError::NotFound("alert rule id=9999".into()).to_string()
    );
    assert_eq!(
        AlertRules::update(&vault, 9999, &patch)
            .unwrap_err()
            .to_string(),
        VaultError::NotFound("alert rule id=9999".into()).to_string()
    );
    assert_eq!(
        AlertRules::delete(&vault, 9999).unwrap_err().to_string(),
        VaultError::NotFound("alert rule id=9999".into()).to_string()
    );
}

/// FK 悬空拒绝（host 不存在）+ host 删除 CASCADE（规则随主机消亡）。
#[test]
fn fk_rejects_dangling_host_and_cascades_on_host_delete() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let mut i = input(9999);
    i.host_id = 9999;
    assert!(
        AlertRules::create(&vault, &i).is_err(),
        "host 不存在 → FK 拒绝"
    );

    let rule = AlertRules::create(&vault, &input(h.id)).unwrap();
    Hosts::delete(&vault, h.id).unwrap();
    assert_eq!(
        AlertRules::list(&vault).unwrap(),
        vec![],
        "删主机即删其规则（ON DELETE CASCADE）"
    );
    assert_eq!(
        AlertRules::get(&vault, rule.id).unwrap(),
        None,
        "级联删除后 get 落空"
    );
}
