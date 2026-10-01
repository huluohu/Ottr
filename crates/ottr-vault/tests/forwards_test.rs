//! port_forwards CRUD TDD（Phase 2 Task 1，spec §3 B7 上半）：
//! 0008 迁移建表 + schema 版本 8、三 kind 建读往返、update 全量替换、
//! set_enabled、delete、list 过滤/list_enabled、FK ON DELETE CASCADE（删主机
//! 连带删转发）、CHECK 底线（dynamic 带 target 被 SQL 拒）、输入校验与归一
//! （dynamic 的 target 传入即丢弃）。
//! 纪律（同 notifications_test）：tempfile 临时目录 + InMemoryStorage，绝不
//! 触碰真实用户目录与真钥匙链。明文配置面（无 *_enc 列，不涉 scan_registry）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    ForwardKind, HostInput, Hosts, PortForwardInput, PortForwards, Vault, VaultError,
};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn input(kind: ForwardKind) -> PortForwardInput {
    PortForwardInput {
        host_id: 1,
        kind,
        bind_addr: "127.0.0.1".into(),
        bind_port: 8080,
        target_host: Some("db.internal".into()),
        target_port: Some(5432),
        enabled: true,
        auto_reconnect: true,
    }
}

/// 建一台主机返回 host_id（FK 用）。
fn seed_host(vault: &Vault) -> i64 {
    Hosts::create(
        vault,
        HostInput {
            protocol: Default::default(),
            name: "fx".into(),
            group_id: None,
            tags: vec![],
            address: "127.0.0.1".into(),
            port: 2222,
            username: Some("spike".into()),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
        },
    )
    .unwrap()
    .id
}

/// 0008 迁移：schema 版本推到 8；三 kind 各建一行回读字段逐一相符。
#[test]
fn migration_0008_creates_table_and_roundtrips_three_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let host_id = seed_host(&vault);

    // local：完整目标
    let local = PortForwards::create(&vault, &input(ForwardKind::Local)).unwrap();
    assert!(local.id > 0);
    assert_eq!(local.kind, ForwardKind::Local);
    assert_eq!(local.bind_addr, "127.0.0.1");
    assert_eq!(local.bind_port, 8080);
    assert_eq!(local.target_host.as_deref(), Some("db.internal"));
    assert_eq!(local.target_port, Some(5432));
    assert!(local.enabled && local.auto_reconnect);
    assert_eq!(local.created_at, local.updated_at);
    assert!(local.created_at > 0);

    // remote：0 端口合法（服务端选择），回读保真
    let mut remote_in = input(ForwardKind::Remote);
    remote_in.host_id = host_id;
    remote_in.bind_port = 0;
    remote_in.target_host = Some("127.0.0.1".into());
    remote_in.target_port = Some(3000);
    let remote = PortForwards::create(&vault, &remote_in).unwrap();
    assert_eq!(remote.bind_port, 0);
    assert_eq!(remote.target_port, Some(3000));

    // dynamic：target 强制 NULL（传入值被归一丢弃，不落库）
    let mut dyn_in = input(ForwardKind::Dynamic);
    dyn_in.host_id = host_id;
    dyn_in.target_host = Some("should.be.dropped".into());
    dyn_in.target_port = Some(1);
    let dynamic = PortForwards::create(&vault, &dyn_in).unwrap();
    assert_eq!(
        dynamic.target_host, None,
        "dynamic 的 target 必须归一为 NULL"
    );
    assert_eq!(dynamic.target_port, None);
    assert_eq!(dynamic.bind_port, 8080);

    // get 回读与 create 返回逐字段一致
    let fetched = PortForwards::get(&vault, dynamic.id).unwrap().unwrap();
    assert_eq!(fetched, dynamic);
}

/// update 全量替换（created_at 保留、updated_at 刷新）+ set_enabled + delete。
#[test]
fn update_set_enabled_delete_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let host_id = seed_host(&vault);
    let row = PortForwards::create(&vault, &input(ForwardKind::Local)).unwrap();

    let mut edited = input(ForwardKind::Remote);
    edited.host_id = host_id;
    edited.bind_addr = "0.0.0.0".into();
    edited.bind_port = 7777;
    edited.target_host = Some("localhost".into());
    edited.target_port = Some(9090);
    edited.enabled = false;
    edited.auto_reconnect = false;
    let updated = PortForwards::update(&vault, row.id, &edited).unwrap();
    assert_eq!(updated.created_at, row.created_at, "created_at 保留");
    assert!(updated.updated_at >= row.updated_at);
    assert_eq!(updated.kind, ForwardKind::Remote);
    assert_eq!(updated.bind_addr, "0.0.0.0");
    assert!(!updated.enabled && !updated.auto_reconnect);

    // set_enabled 翻转
    PortForwards::set_enabled(&vault, row.id, true).unwrap();
    assert!(PortForwards::get(&vault, row.id).unwrap().unwrap().enabled);
    PortForwards::set_enabled(&vault, row.id, false).unwrap();
    assert!(!PortForwards::get(&vault, row.id).unwrap().unwrap().enabled);
    assert!(matches!(
        PortForwards::set_enabled(&vault, 999_999, true),
        Err(VaultError::NotFound(_))
    ));

    // delete：行消失；再删 = NotFound
    PortForwards::delete(&vault, row.id).unwrap();
    assert!(PortForwards::get(&vault, row.id).unwrap().is_none());
    assert!(matches!(
        PortForwards::delete(&vault, row.id),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        PortForwards::update(&vault, row.id, &edited),
        Err(VaultError::NotFound(_))
    ));
}

/// list 全量/按主机过滤 + list_enabled；id 升序（创建序）稳定。
#[test]
fn list_filters_by_host_and_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h1 = seed_host(&vault);
    let h2 = Hosts::create(
        &vault,
        HostInput {
            protocol: Default::default(),
            name: "second".into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.2".into(),
            port: 22,
            username: None,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
        },
    )
    .unwrap()
    .id;

    let mut a = input(ForwardKind::Local);
    a.host_id = h1;
    a.enabled = true;
    let row_a = PortForwards::create(&vault, &a).unwrap();
    let mut b = input(ForwardKind::Dynamic);
    b.host_id = h1;
    b.enabled = false;
    let row_b = PortForwards::create(&vault, &b).unwrap();
    let mut c = input(ForwardKind::Remote);
    c.host_id = h2;
    c.enabled = true;
    let row_c = PortForwards::create(&vault, &c).unwrap();

    let all = PortForwards::list(&vault, None).unwrap();
    assert_eq!(
        all.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![row_a.id, row_b.id, row_c.id],
        "全量按 id 升序"
    );
    let of_h1 = PortForwards::list(&vault, Some(h1)).unwrap();
    assert_eq!(
        of_h1.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![row_a.id, row_b.id]
    );
    let enabled_h1 = PortForwards::list_enabled(&vault, h1).unwrap();
    assert_eq!(
        enabled_h1.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![row_a.id],
        "list_enabled 只取 enabled 行"
    );
    assert!(PortForwards::list(&vault, Some(999_999))
        .unwrap()
        .is_empty());
}

/// FK ON DELETE CASCADE：删主机连带删其转发配置（转发是主机附属配置，
/// 非 0002 裁定 #3 的可复用实体，与 history 同裁定）。
#[test]
fn deleting_host_cascades_to_forwards() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let host_id = seed_host(&vault);
    let row = PortForwards::create(&vault, &input(ForwardKind::Local)).unwrap();
    assert!(PortForwards::get(&vault, row.id).unwrap().is_some());
    Hosts::delete(&vault, host_id).unwrap();
    assert!(
        PortForwards::get(&vault, row.id).unwrap().is_none(),
        "级联删除"
    );
    assert!(PortForwards::list(&vault, Some(host_id))
        .unwrap()
        .is_empty());
}

/// 输入校验：空白 bind_addr / 空白 target_host / local 缺 target / target_port=0
/// 全部 InvalidInput；未知 kind 字符串回读显式报错（不静默）。
#[test]
fn validation_rejects_bad_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    seed_host(&vault);

    let mut bad = input(ForwardKind::Local);
    bad.bind_addr = "   ".into();
    assert!(matches!(
        PortForwards::create(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    let mut bad = input(ForwardKind::Local);
    bad.target_host = Some("  ".into());
    assert!(matches!(
        PortForwards::create(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    let mut bad = input(ForwardKind::Local);
    bad.target_host = None;
    bad.target_port = None;
    assert!(matches!(
        PortForwards::create(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    let mut bad = input(ForwardKind::Remote);
    bad.target_port = Some(0);
    assert!(matches!(
        PortForwards::create(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    // bind_addr 首尾空白归一（trim 后入库）
    let mut loose = input(ForwardKind::Local);
    loose.bind_addr = " 127.0.0.1 ".into();
    loose.target_host = Some(" db.internal ".into());
    let row = PortForwards::create(&vault, &loose).unwrap();
    assert_eq!(row.bind_addr, "127.0.0.1");
    assert_eq!(row.target_host.as_deref(), Some("db.internal"));
}

/// SQL CHECK 底线（绕过实体层直写）：dynamic 带 target 被拒；bind_port 越界被拒；
/// 非法 kind 被拒。实体层校验是友好报错面，CHECK 是最后防线。
#[test]
fn sql_check_constraints_are_the_last_line() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let host_id = seed_host(&vault);
    let ts = 1_700_000_000i64;

    let conn = vault.connection();
    // dynamic 带 target → CHECK 拒绝
    assert!(conn
        .execute(
            "INSERT INTO port_forwards (host_id, kind, bind_addr, bind_port, target_host,
                                        target_port, enabled, auto_reconnect, created_at, updated_at)
             VALUES (?1, 'dynamic', '127.0.0.1', 1080, 'x', 1, 0, 1, ?2, ?2)",
            rusqlite::params![host_id, ts],
        )
        .is_err());
    // bind_port 越界 → CHECK 拒绝
    assert!(conn
        .execute(
            "INSERT INTO port_forwards (host_id, kind, bind_addr, bind_port, target_host,
                                        target_port, enabled, auto_reconnect, created_at, updated_at)
             VALUES (?1, 'local', '127.0.0.1', 70000, 'db', 5432, 0, 1, ?2, ?2)",
            rusqlite::params![host_id, ts],
        )
        .is_err());
    // 非法 kind → CHECK 拒绝
    assert!(conn
        .execute(
            "INSERT INTO port_forwards (host_id, kind, bind_addr, bind_port, target_host,
                                        target_port, enabled, auto_reconnect, created_at, updated_at)
             VALUES (?1, 'reverse', '127.0.0.1', 80, 'db', 5432, 0, 1, ?2, ?2)",
            rusqlite::params![host_id, ts],
        )
        .is_err());
    // host 不存在 → FK 拒绝
    assert!(conn
        .execute(
            "INSERT INTO port_forwards (host_id, kind, bind_addr, bind_port, target_host,
                                        target_port, enabled, auto_reconnect, created_at, updated_at)
             VALUES (424242, 'local', '127.0.0.1', 80, 'db', 5432, 0, 1, ?1, ?1)",
            rusqlite::params![ts],
        )
        .is_err());
}
