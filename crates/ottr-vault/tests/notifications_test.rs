//! notifications TDD（Task 12，spec §7 ①应用内通知中心）：
//! 0005 迁移建表、insert/list（倒序+截断）、mark_read（单条/全部）、clear、
//! unread_count、FK ON DELETE SET NULL（删主机通知留痕）、severity 校验。
//! 纪律（同 entities_test）：tempfile 临时目录 + InMemoryStorage，绝不触碰
//! 真实用户目录与真钥匙链。通知是明文面（无 *_enc 列，不涉 scan_registry
//! 守卫；锁定态可读写不另测——settings 同语义）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostInput, Hosts, NotificationInput, Notifications, Vault, VaultError};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn input(kind: &str, severity: &str, title_key: &str) -> NotificationInput {
    NotificationInput {
        kind: kind.into(),
        severity: severity.into(),
        host_id: None,
        title_key: title_key.into(),
        body: String::new(),
        payload: None,
    }
}

/// 0005 迁移建表 + 字段回读（payload JSON 往返、read 默认 false、ts 存储层定）。
#[test]
fn migration_0005_creates_notifications_and_insert_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    let row = Notifications::insert(
        &vault,
        &NotificationInput {
            kind: "transfer".into(),
            severity: "error".into(),
            host_id: None,
            title_key: "notify.title.transferFailed".into(),
            body: "/srv/app.tar — boom".into(),
            payload: Some(serde_json::json!({ "transfer_id": "xfer-1", "status": "failed" })),
        },
    )
    .unwrap();

    assert!(row.id > 0);
    assert!(row.ts > 0, "ts 由存储层落值");
    assert!(!row.read, "新通知默认未读");
    let listed = Notifications::list(&vault, 10).unwrap();
    assert_eq!(listed, vec![row.clone()], "serde 面字段逐字段回读一致");
    assert_eq!(
        listed[0].payload.as_ref().unwrap()["transfer_id"],
        "xfer-1",
        "payload JSON 列无损往返"
    );
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 1);
}

/// 列表 = 最近优先（ts DESC；同 ts 按 id DESC 保序），limit 截断取最新。
#[test]
fn list_orders_recent_first_and_respects_limit() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    // 同秒插入三条：id 递增即 ts 相同（回放顺序确定性）
    for i in 1..=3 {
        Notifications::insert(
            &vault,
            &NotificationInput {
                kind: "session".into(),
                severity: "warning".into(),
                host_id: None,
                title_key: format!("t.{i}"),
                body: String::new(),
                payload: None,
            },
        )
        .unwrap();
    }
    let all = Notifications::list(&vault, 10).unwrap();
    let ids: Vec<i64> = all.iter().map(|n| n.id).collect();
    let mut sorted_desc = ids.clone();
    sorted_desc.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(ids, sorted_desc, "最近通知在前（ts DESC + id DESC 保序）");

    let top2 = Notifications::list(&vault, 2).unwrap();
    assert_eq!(top2.len(), 2);
    assert_eq!(top2[0].id, all[0].id, "limit 截断取最新的 N 条");
}

/// 已读流转：单条标读（未读数递减）→ 全部已读 → 幂等；未知 id NotFound。
#[test]
fn mark_read_single_all_and_unread_count() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let a = Notifications::insert(&vault, &input("transfer", "error", "a")).unwrap();
    let b = Notifications::insert(&vault, &input("transfer", "warning", "b")).unwrap();
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 2);

    assert_eq!(Notifications::mark_read(&vault, Some(a.id)).unwrap(), 1);
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 1);
    let listed = Notifications::list(&vault, 10).unwrap();
    let row = listed.iter().find(|n| n.id == a.id).unwrap();
    assert!(row.read, "标读落库");
    // 幂等：已读行再标仍是命中（「指到即读」语义）
    assert_eq!(Notifications::mark_read(&vault, Some(a.id)).unwrap(), 1);
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 1);

    // 全部已读（id=None）；再标全 = 0 行翻转但不报错
    assert_eq!(Notifications::mark_read(&vault, None).unwrap(), 1);
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 0);
    assert_eq!(Notifications::mark_read(&vault, None).unwrap(), 0);
    assert_eq!(Notifications::mark_read(&vault, Some(b.id)).unwrap(), 1);

    // 未知 id 显式 NotFound（UI 侧清空竞态的防漏兵）
    assert!(matches!(
        Notifications::mark_read(&vault, Some(9999)),
        Err(VaultError::NotFound(_))
    ));
}

/// 清空：返回删除行数、表清零；空表清空幂等。
#[test]
fn clear_empties_table() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    for k in ["a", "b"] {
        Notifications::insert(&vault, &input("session", "info", k)).unwrap();
    }
    assert_eq!(Notifications::clear(&vault).unwrap(), 2);
    assert!(Notifications::list(&vault, 10).unwrap().is_empty());
    assert_eq!(Notifications::unread_count(&vault).unwrap(), 0);
    assert_eq!(Notifications::clear(&vault).unwrap(), 0, "幂等");
}

/// FK ON DELETE SET NULL（裁定 #3 删除语义同构）：删主机 → 通知留痕、host_id 置空。
#[test]
fn delete_host_sets_notification_host_id_null() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let host = Hosts::create(
        &vault,
        HostInput {
            protocol: Default::default(),
            name: "web-01".into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.1".into(),
            port: 22,
            username: None,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap();
    let row = Notifications::insert(
        &vault,
        &NotificationInput {
            host_id: Some(host.id),
            ..input("session", "warning", "notify.title.sessionLost")
        },
    )
    .unwrap();
    Hosts::delete(&vault, host.id).unwrap();
    let listed = Notifications::list(&vault, 10).unwrap();
    assert_eq!(listed.len(), 1, "通知不随主机删除消失（历史留痕）");
    assert_eq!(listed[0].id, row.id);
    assert_eq!(listed[0].host_id, None, "host_id SET NULL");
}

/// 入口校验：severity 合法集（DB CHECK 之外的可读错误）、kind/title_key 非空。
#[test]
fn insert_rejects_bad_severity_and_empty_kind() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert!(matches!(
        Notifications::insert(&vault, &input("transfer", "fatal", "t")),
        Err(VaultError::InvalidInput(_))
    ));
    assert!(matches!(
        Notifications::insert(&vault, &input("", "info", "t")),
        Err(VaultError::InvalidInput(_))
    ));
    assert!(matches!(
        Notifications::insert(&vault, &input("transfer", "info", " ")),
        Err(VaultError::InvalidInput(_))
    ));
    // 合法四集全部可写
    for sev in ["info", "success", "warning", "error"] {
        Notifications::insert(&vault, &input("transfer", sev, "t")).unwrap();
    }
    assert_eq!(Notifications::list(&vault, 10).unwrap().len(), 4);
}
