//! jump_chains CRUD TDD（Phase 2 Task 2，spec §3 B7 下半）：
//! 0009 迁移建表 + schema 版本 9、hops JSON（host_id 有序数组）往返保序、
//! update 全量替换、list/get、delete **解绑引用主机**（hosts.jump_chain_id
//! 置 NULL——存储层承担 SQLite 无法对既有列补 FK 的 SET NULL 语义，偏差
//! 记录见 0009 迁移文件头）、校验（空名/空链/hop 重复/hop 不存在）。
//! 纪律（同 forwards_test）：tempfile 临时目录 + InMemoryStorage，绝不触碰
//! 真实用户目录与真钥匙链。明文配置面（无 *_enc 列，不涉 scan_registry）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostInput, Hosts, JumpChainInput, JumpChains, Vault, VaultError};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

/// 建一台主机返回 host_id（hop 用）。
fn seed_host(vault: &Vault, name: &str) -> i64 {
    Hosts::create(
        vault,
        HostInput {
            protocol: Default::default(),
            name: name.into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.1".into(),
            port: 22,
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

/// 0009 迁移：schema 版本推到 9；建行回读 hops 保序（JSON 数组语义）。
#[test]
fn migration_0009_creates_table_and_roundtrips_hops_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    let h1 = seed_host(&vault, "hop-a");
    let h2 = seed_host(&vault, "hop-b");
    let h3 = seed_host(&vault, "target");

    let row = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "office-bastions".into(),
            hops: vec![h1, h2, h3],
        },
    )
    .unwrap();
    assert!(row.id > 0);
    assert_eq!(row.name, "office-bastions");
    assert_eq!(row.hops, vec![h1, h2, h3], "hop 序即连接序，必须保序");
    assert_eq!(row.created_at, row.updated_at);
    assert!(row.created_at > 0);

    let got = JumpChains::get(&vault, row.id).unwrap().expect("get");
    assert_eq!(got, row);
    assert_eq!(JumpChains::list(&vault).unwrap(), vec![row]);
}

/// 反向链 ≠ 正向链：hops 顺序存取保真（[b,a] 与 [a,b] 是两条不同的链）。
#[test]
fn hops_order_is_significant() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let ha = seed_host(&vault, "a");
    let hb = seed_host(&vault, "b");

    let forward = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "fwd".into(),
            hops: vec![ha, hb],
        },
    )
    .unwrap();
    let backward = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "bwd".into(),
            hops: vec![hb, ha],
        },
    )
    .unwrap();
    assert_ne!(forward.hops, backward.hops);
    assert_eq!(forward.hops, vec![ha, hb]);
    assert_eq!(backward.hops, vec![hb, ha]);
}

/// update 全量替换式更新（name/hops 一起提交）；created_at 保留、updated_at 前进。
#[test]
fn update_replaces_name_and_hops_keep_created_at() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h1 = seed_host(&vault, "a");
    let h2 = seed_host(&vault, "b");
    let row = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "old".into(),
            hops: vec![h1],
        },
    )
    .unwrap();

    let updated = JumpChains::update(
        &vault,
        row.id,
        &JumpChainInput {
            name: "new".into(),
            hops: vec![h2, h1],
        },
    )
    .unwrap();
    assert_eq!(updated.name, "new");
    assert_eq!(updated.hops, vec![h2, h1]);
    assert_eq!(updated.created_at, row.created_at, "created_at 保留");
    assert!(updated.updated_at >= row.updated_at);
    assert_eq!(JumpChains::get(&vault, row.id).unwrap(), Some(updated));
}

/// delete 后引用该链的主机 jump_chain_id 置 NULL（SET NULL 语义由存储层承担，
/// 0009 迁移偏差记录）；链本身消失；其他主机/其他链不受牵连。
#[test]
fn delete_unbinds_referencing_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let ha = seed_host(&vault, "a");
    let hb = seed_host(&vault, "b");
    let chain = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "c".into(),
            hops: vec![ha],
        },
    )
    .unwrap();
    let other_chain = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "other".into(),
            hops: vec![hb],
        },
    )
    .unwrap();

    // 两台主机绑同一链 + 一台绑其他链
    let bind = |vault: &Vault, id: i64, chain_id: Option<i64>| {
        let host = Hosts::get(vault, id).unwrap().unwrap();
        Hosts::update(
            vault,
            id,
            HostInput {
                protocol: Default::default(),
                name: host.name.clone(),
                group_id: host.group_id,
                tags: host.tags.clone(),
                address: host.address.clone(),
                port: host.port,
                username: host.username.clone(),
                credential_id: host.credential_id,
                jump_chain_id: chain_id,
                encoding_override: host.encoding_override.clone(),
                theme_override: host.theme_override.clone(),
                monitor_enabled: host.monitor_enabled,
                notes: host.notes.clone(),
            },
        )
        .unwrap();
    };
    bind(&vault, ha, Some(chain.id));
    bind(&vault, hb, Some(other_chain.id));

    JumpChains::delete(&vault, chain.id).unwrap();
    assert!(JumpChains::get(&vault, chain.id).unwrap().is_none());
    assert_eq!(
        Hosts::get(&vault, ha).unwrap().unwrap().jump_chain_id,
        None,
        "引用被删链的主机必须解绑"
    );
    assert_eq!(
        Hosts::get(&vault, hb).unwrap().unwrap().jump_chain_id,
        Some(other_chain.id),
        "其他链的绑定不受牵连"
    );
    assert_eq!(JumpChains::list(&vault).unwrap().len(), 1);
    // 幂等性：再删同 id 显式 NotFound（同实体表惯例）
    assert!(matches!(
        JumpChains::delete(&vault, chain.id),
        Err(VaultError::NotFound(_))
    ));
}

/// 校验决策表：空名 / 空链 / hop 重复 / hop 指向不存在的主机 → InvalidInput。
#[test]
fn validation_rejects_bad_input() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h1 = seed_host(&vault, "a");

    for (bad, why) in [
        (
            JumpChainInput {
                name: "  ".into(),
                hops: vec![h1],
            },
            "empty name",
        ),
        (
            JumpChainInput {
                name: "c".into(),
                hops: vec![],
            },
            "empty hops",
        ),
        (
            JumpChainInput {
                name: "c".into(),
                hops: vec![h1, h1],
            },
            "duplicate hop",
        ),
        (
            JumpChainInput {
                name: "c".into(),
                hops: vec![h1, 999_999],
            },
            "nonexistent host",
        ),
    ] {
        let err = JumpChains::create(&vault, &bad).unwrap_err();
        assert!(matches!(err, VaultError::InvalidInput(_)), "{why}: {err:?}");
    }
    assert!(
        JumpChains::list(&vault).unwrap().is_empty(),
        "校验失败不得留半行"
    );

    // update 同口径
    let row = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "ok".into(),
            hops: vec![h1],
        },
    )
    .unwrap();
    assert!(matches!(
        JumpChains::update(
            &vault,
            row.id,
            &JumpChainInput {
                name: "x".into(),
                hops: vec![]
            }
        ),
        Err(VaultError::InvalidInput(_))
    ));
    // 不存在的链 id → NotFound
    assert!(matches!(
        JumpChains::update(
            &vault,
            12345,
            &JumpChainInput {
                name: "x".into(),
                hops: vec![h1]
            }
        ),
        Err(VaultError::NotFound(_))
    ));
}

/// I-1 fix（FK 补偿反向）：删 hop 主机 → 该 id 从各链 hops 摘除（余跳相对
/// 顺序不变、updated_at 前进），链保留；connect 侧不再报 hop not found
/// （hops 只含现存主机 id）。
#[test]
fn delete_hop_host_removes_it_from_chain_hops() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let ha = seed_host(&vault, "a");
    let hb = seed_host(&vault, "b");
    let hc = seed_host(&vault, "c");
    let chain = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "c".into(),
            hops: vec![ha, hb, hc],
        },
    )
    .unwrap();

    Hosts::delete(&vault, hb).unwrap();

    let row = JumpChains::get(&vault, chain.id).unwrap().expect("链保留");
    assert_eq!(row.hops, vec![ha, hc], "中间 hop 摘除，相对顺序不变");
    assert_eq!(row.name, "c");
    assert!(
        row.updated_at >= chain.updated_at,
        "hops 变更推进 updated_at"
    );
    // 反向不变量：链内所有 hop 都指向现存主机（connect 不再报 not found）。
    for &hop in &row.hops {
        assert!(Hosts::get(&vault, hop).unwrap().is_some());
    }
    // 不相关的链不动。
    let other = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "other".into(),
            hops: vec![hc],
        },
    )
    .unwrap();
    assert_eq!(
        JumpChains::get(&vault, other.id).unwrap().unwrap().hops,
        vec![hc]
    );
}

/// I-1 fix（级联裁定）：链的最后一个 hop 被删 → 链级联删除 + 引用该链的
/// 主机解绑（jump_chain_id 置 NULL，回退直连——不再报 hop not found）；
/// 删不存在的 host id → NotFound 且链原样（事务回滚）。
#[test]
fn delete_last_hop_host_cascades_chain_and_unbinds_referencing_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let ha = seed_host(&vault, "a");
    let hb = seed_host(&vault, "b");
    let href = seed_host(&vault, "ref");
    let chain = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "solo".into(),
            hops: vec![ha],
        },
    )
    .unwrap();
    let other_chain = JumpChains::create(
        &vault,
        &JumpChainInput {
            name: "other".into(),
            hops: vec![hb],
        },
    )
    .unwrap();
    // 引用主机：一台绑被级联的链（删 hop 后应解绑），一台绑其他链（对照）。
    let bind = |vault: &Vault, id: i64, chain_id: Option<i64>| {
        let host = Hosts::get(vault, id).unwrap().unwrap();
        Hosts::update(
            vault,
            id,
            HostInput {
                protocol: Default::default(),
                name: host.name.clone(),
                group_id: host.group_id,
                tags: host.tags.clone(),
                address: host.address.clone(),
                port: host.port,
                username: host.username.clone(),
                credential_id: host.credential_id,
                jump_chain_id: chain_id,
                encoding_override: host.encoding_override.clone(),
                theme_override: host.theme_override.clone(),
                monitor_enabled: host.monitor_enabled,
                notes: host.notes.clone(),
            },
        )
        .unwrap();
    };
    bind(&vault, href, Some(chain.id));
    bind(&vault, hb, Some(other_chain.id));

    Hosts::delete(&vault, ha).unwrap();

    assert!(
        JumpChains::get(&vault, chain.id).unwrap().is_none(),
        "空链必须级联删除"
    );
    assert_eq!(Hosts::get(&vault, ha).unwrap(), None, "主机本身已删");
    assert_eq!(
        Hosts::get(&vault, href).unwrap().unwrap().jump_chain_id,
        None,
        "引用被级联链的主机必须解绑（回退直连，不再报 hop not found）"
    );
    assert_eq!(
        JumpChains::get(&vault, other_chain.id).unwrap(),
        Some(other_chain.clone()),
        "其他链不受牵连"
    );
    assert_eq!(
        Hosts::get(&vault, hb).unwrap().unwrap().jump_chain_id,
        Some(other_chain.id),
        "其他链的绑定不受牵连"
    );

    // 删不存在的 id → NotFound，且链表无副作用（事务回滚面）。
    assert!(matches!(
        Hosts::delete(&vault, 999_999),
        Err(VaultError::NotFound(_))
    ));
    assert_eq!(JumpChains::list(&vault).unwrap().len(), 1);
}
