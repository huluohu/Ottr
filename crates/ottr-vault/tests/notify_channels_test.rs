//! notify_channels TDD（Phase 3 Task 3，B5 渠道全矩阵——存储侧）：
//! 0014 迁移建表、create/list 回读、kind 合法集校验（12 种）、config 必须
//! JSON 对象、密文落库直查（库中无明文 + 随机 nonce）、reveal_config 单点
//! 出库、update 补丁语义（config None = 保留现值；Some = 重密封）、锁定拒绝、
//! 主密码升级重密封覆盖本表、未知 id NotFound、enabled 位。
//! 纪律（同 summaries_test）：tempfile 临时目录 + InMemoryStorage。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    NotifyChannelInput, NotifyChannelPatch, NotifyChannels, Vault, VaultError, CHANNEL_KINDS,
};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn input(kind: &str) -> NotifyChannelInput {
    NotifyChannelInput {
        kind: kind.into(),
        config: serde_json::json!({ "webhook": "https://oapi.dingtalk.com/robot/send?access_token=SECRET", "secret": "SECxxx" }),
        template_overrides: None,
        enabled: true,
    }
}

/// 0014 迁移建表 + create/list 回读（serde 面无任何密钥字段）+ kind 合法集
/// 全 12 种放行 + 未知 kind/config 非对象拒绝。
#[test]
fn migration_0014_creates_notify_channels_and_validates_kind() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    for kind in CHANNEL_KINDS {
        let row = NotifyChannels::create(&vault, &input(kind)).unwrap();
        assert!(row.id > 0);
        assert!(row.enabled, "默认启用位透传");
        assert_eq!(row.kind, *kind);
    }
    assert_eq!(NotifyChannels::list(&vault).unwrap().len(), 12);

    let mut bad = input("rss");
    bad.kind = "rss".into();
    assert!(matches!(
        NotifyChannels::create(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    let mut bad2 = input("bark");
    bad2.config = serde_json::json!("not-an-object");
    assert!(matches!(
        NotifyChannels::create(&vault, &bad2),
        Err(VaultError::InvalidInput(_))
    ));
}

/// 密文落库直查：config_enc 列无明文残留 + 随机 nonce（同配置两次密封密文
/// 不同）+ reveal_config 单点出库还原。
#[test]
fn config_is_sealed_at_rest_and_reveal_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let a = NotifyChannels::create(&vault, &input("dingtalk")).unwrap();
    let b = NotifyChannels::create(&vault, &input("dingtalk")).unwrap();

    // serde 面无密钥字段
    let listed = NotifyChannels::list(&vault).unwrap();
    assert!(
        !serde_json::to_string(&listed).unwrap().contains("SECRET"),
        "序列化面不得携带密钥材料"
    );

    // 落库直查：密文里翻不到明文；同明文两次密封密文不同（随机 nonce）。
    // 连接锁块作用域：guard 必须在 reveal_config 重入前释放（Mutex 不可重入）。
    {
        let conn = vault.connection();
        let blob_a: Vec<u8> = conn
            .query_row(
                "SELECT config_enc FROM notify_channels WHERE id = ?1",
                [a.id],
                |r| r.get(0),
            )
            .unwrap();
        let blob_b: Vec<u8> = conn
            .query_row(
                "SELECT config_enc FROM notify_channels WHERE id = ?1",
                [b.id],
                |r| r.get(0),
            )
            .unwrap();
        let s_a = String::from_utf8_lossy(&blob_a).to_string();
        assert!(!s_a.contains("SECRET"), "库中无明文");
        assert_ne!(blob_a, blob_b, "随机 nonce → 密文不同");
    }

    // 单点出库还原
    let plain = NotifyChannels::reveal_config(&vault, a.id).unwrap();
    assert_eq!(plain["secret"], "SECxxx");
    assert_eq!(
        NotifyChannels::reveal_config(&vault, 9999)
            .unwrap_err()
            .to_string(),
        VaultError::NotFound("notify channel id=9999".into()).to_string()
    );
}

/// update 补丁语义：config None = 保留现值（不重密封）；Some = 覆写；
/// template_overrides/enabled 独立翻转；未知 id NotFound。
#[test]
fn update_patch_keeps_config_when_none_and_rewrites_when_some() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let row = NotifyChannels::create(&vault, &input("telegram")).unwrap();

    // config=None：仅翻 enabled + 挂 overrides → 密文不动（reveal 原值不变）
    NotifyChannels::update(
        &vault,
        row.id,
        &NotifyChannelPatch {
            kind: None,
            config: None,
            template_overrides: Some(Some(serde_json::json!({ "body": "{{rule}} on {{host}}" }))),
            enabled: Some(false),
        },
    )
    .unwrap();
    let after = NotifyChannels::get(&vault, row.id).unwrap().unwrap();
    assert!(!after.enabled);
    assert_eq!(
        after.template_overrides.unwrap()["body"],
        "{{rule}} on {{host}}"
    );
    assert_eq!(
        NotifyChannels::reveal_config(&vault, row.id).unwrap()["secret"],
        "SECxxx"
    );

    // config=Some：覆写密文
    NotifyChannels::update(
        &vault,
        row.id,
        &NotifyChannelPatch {
            kind: None,
            config: Some(serde_json::json!({ "bot_token": "NEW", "chat_id": "42" })),
            template_overrides: None,
            enabled: None,
        },
    )
    .unwrap();
    let plain = NotifyChannels::reveal_config(&vault, row.id).unwrap();
    assert_eq!(plain["bot_token"], "NEW");
    assert!(plain.get("secret").is_none(), "全量替换式 config 覆写");

    // overrides=None（嵌套 Option 外层）= 保留现值
    let after2 = NotifyChannels::get(&vault, row.id).unwrap().unwrap();
    assert!(after2.template_overrides.is_some());

    assert_eq!(
        NotifyChannels::update(&vault, 9999, &NotifyChannelPatch::default())
            .unwrap_err()
            .to_string(),
        VaultError::NotFound("notify channel id=9999".into()).to_string()
    );
}

/// 锁定拒绝（password 模式锁定态：create/reveal 都要密钥）。
#[test]
fn locked_vault_rejects_seal_and_reveal() {
    let dir = tempfile::tempdir().unwrap();
    let vault = ottr_vault::Vault::open_password_only(dir.path()).expect("open locked");
    let err = NotifyChannels::create(&vault, &input("bark")).unwrap_err();
    assert_eq!(err.to_string(), VaultError::Locked.to_string());
}

/// 主密码升级重密封覆盖本表（scan_registry 登记的存在性证明）：
/// keyring 模式写密文 → 升级主密码（换钥重密封）→ reveal 仍可开封。
#[test]
fn master_password_upgrade_reencrypts_channel_config() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let row = NotifyChannels::create(&vault, &input("slack")).unwrap();

    let n = vault
        .set_master_password("correct horse battery staple", &mut |_, _| {})
        .expect("upgrade");
    assert!(n >= 1, "重密封扫描至少覆盖本表 1 列");
    let plain = NotifyChannels::reveal_config(&vault, row.id).unwrap();
    assert_eq!(plain["webhook"], input("slack").config["webhook"]);
}
