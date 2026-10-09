//! T11 安全底座 TDD：主密码模式升级（重加密迁移三件套）+ 解锁状态机 +
//! Linux fallback（password-only 打开）+ settings 访问层。
//!
//! 纪律（同既有 vault 测试）：一律 InMemoryStorage + tempfile 临时目录，
//! 绝不触碰真实钥匙链/真实用户数据目录。

use ottr_vault::master_key::{InMemoryStorage, KeyStorage};
use ottr_vault::store::KeyMode;
use ottr_vault::{
    CredentialInput, CredentialKind, Credentials, HostInput, Hosts, Settings, Vault, VaultError,
};

const GOOD_PASSWORD: &str = "correct horse battery staple";

/// 固定凭据集（三件套共用的迁移前状态）：cred A 三密文字段齐全，cred B 只有
/// secret（passphrase/totp 为 NULL——扫描必须跳过空列），另立一台 host 绑 A。
fn seed_fixed_credentials(vault: &Vault) -> (i64, i64) {
    let a = Credentials::create(
        vault,
        &CredentialInput {
            name: None,
            kind: CredentialKind::Password,
            secret: Some("s3cret-password-α".into()),
            key_pub: None,
            passphrase: Some("folder-passphrase".into()),
            totp_secret: Some("JBSWY3DPEHPK3PXP".into()),
        },
    )
    .unwrap();
    let b = Credentials::create(
        vault,
        &CredentialInput {
            name: None,
            kind: CredentialKind::Key,
            secret: Some(
                "-----BEGIN OPENSSH PRIVATE KEY-----\nseed-b\n-----END OPENSSH PRIVATE KEY-----"
                    .into(),
            ),
            key_pub: Some("ssh-ed25519 AAAA seed-b".into()),
            passphrase: None,
            totp_secret: None,
        },
    )
    .unwrap();
    Hosts::create(
        vault,
        HostInput {
            protocol: Default::default(),
            name: "web-01".into(),
            group_id: None,
            tags: vec!["prod".into()],
            address: "10.0.0.1".into(),
            port: 2222,
            username: Some("deploy".into()),
            credential_id: Some(a.id),
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap();
    (a.id, b.id)
}

// ---------------------------------------------------------------------------
// 三件套①：迁移前后数据可解（固定凭据集）
// ---------------------------------------------------------------------------

#[test]
fn upgrade_roundtrip_reencrypts_all_fields_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    assert_eq!(vault.mode(), KeyMode::Keyring);
    assert!(!vault.is_locked());
    let (id_a, id_b) = seed_fixed_credentials(&vault);
    drop(vault);

    // 升级（进度回调逐字段推进，终值 = (total, total)）。
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let mut progress = Vec::new();
    let fields = vault
        .set_master_password(GOOD_PASSWORD, &mut |done, total| {
            progress.push((done, total));
        })
        .unwrap();
    assert_eq!(fields, 4, "A 三字段 + B 一字段（key 凭据的 secret）");
    assert_eq!(progress.last(), Some(&(4, 4)), "进度终值必须收口在总数上");
    assert_eq!(vault.mode(), KeyMode::Password);
    assert!(!vault.is_locked(), "升级后保持解锁态（向导无需再输密码）");
    // 升级后立刻可解（同一会话）：AAD 不变、新钥密封。
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α")
    );
    drop(vault);

    // 重开：password 模式 → 锁定态；残留钥匙链条目被兜底清理。
    let reopened = Vault::open_with(dir.path(), &storage).unwrap();
    assert_eq!(reopened.mode(), KeyMode::Password);
    assert!(reopened.is_locked(), "password 模式 open 即锁定");
    assert!(
        storage.load().unwrap().is_none(),
        "升级提交后的钥匙链残留必须在重开时被清理"
    );
    // 锁定态：需要密钥的操作拒绝。
    assert!(matches!(
        Credentials::reveal(&reopened, id_a, ottr_vault::SecretField::Secret),
        Err(VaultError::Locked)
    ));
    // 解锁 → 固定凭据集逐字段可解，与迁移前逐字节一致。
    reopened.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert!(!reopened.is_locked());
    for (id, field, want) in [
        (id_a, ottr_vault::SecretField::Secret, "s3cret-password-α"),
        (
            id_a,
            ottr_vault::SecretField::Passphrase,
            "folder-passphrase",
        ),
        (
            id_a,
            ottr_vault::SecretField::TotpSecret,
            "JBSWY3DPEHPK3PXP",
        ),
        (
            id_b,
            ottr_vault::SecretField::Secret,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nseed-b\n-----END OPENSSH PRIVATE KEY-----",
        ),
        (id_b, ottr_vault::SecretField::Passphrase, ""),
        (id_b, ottr_vault::SecretField::TotpSecret, ""),
    ] {
        let got = Credentials::reveal(&reopened, id, field).unwrap();
        if want.is_empty() {
            assert_eq!(got, None, "{field:?} of cred {id} 应为 NULL");
        } else {
            assert_eq!(got.as_deref(), Some(want), "{field:?} of cred {id}");
        }
    }
    // 元数据面完整（host 绑定不因迁移丢失）。
    let host = &Hosts::list(&reopened).unwrap()[0];
    assert_eq!(host.credential_id, Some(id_a));
}

// ---------------------------------------------------------------------------
// 三件套②：错误主密码拒绝
// ---------------------------------------------------------------------------

#[test]
fn wrong_master_password_is_rejected_and_stays_locked() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let (id_a, _) = seed_fixed_credentials(&vault);
    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    drop(vault);

    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    assert!(vault.is_locked());
    let err = vault
        .unlock_with_password("totally wrong password")
        .unwrap_err();
    assert!(
        matches!(err, VaultError::BadMasterPassword),
        "错误密码必须报 BadMasterPassword，实际 {err:?}"
    );
    assert!(vault.is_locked(), "解锁失败后必须仍在锁定态");
    assert!(matches!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret),
        Err(VaultError::Locked)
    ));
    // 失败后再用正确密码解锁仍然可用（校验失败不破坏任何状态）。
    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α")
    );
}

// ---------------------------------------------------------------------------
// 三件套③：迁移中断安全（单事务原子性）
// ---------------------------------------------------------------------------

#[test]
fn interrupted_upgrade_rolls_back_and_keeps_keyring_mode() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let (id_a, id_b) = seed_fixed_credentials(&vault);
    // 预埋「迁移中途失败」：把 B 的密文破坏成非法 blob——扫描到它时旧钥开封必败。
    vault
        .connection()
        .execute(
            "UPDATE credentials SET secret_enc = X'000102030405060708090A0B0C0D0E0F' WHERE id = ?1",
            [id_b],
        )
        .unwrap();
    drop(vault);

    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let err = vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap_err();
    assert!(matches!(err, VaultError::Crypto(_)), "实际 {err:?}");

    // 原子性：模式仍是 keyring、无 verifier/salt 残留、旧钥照常可用（A 可解）。
    assert_eq!(vault.mode(), KeyMode::Keyring, "失败升级不得翻转模式");
    assert!(!vault.is_locked(), "失败升级不得动解锁态（旧钥仍在内存）");
    // 模式行仍指 keyring，且无 salt/verifier 残留（派生参数不得半落盘）。
    let mode: String = vault
        .connection()
        .query_row(
            "SELECT value FROM meta WHERE key = 'master_key.mode'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mode, "keyring", "失败升级不得翻转模式行");
    let leftovers: i64 = vault
        .connection()
        .query_row(
            "SELECT count(*) FROM meta WHERE key IN ('master_key.kdf_salt','master_key.verifier')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftovers, 0, "salt/verifier 不得残留");
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α"),
        "失败升级后旧钥必须原样可用"
    );
    assert!(
        storage.load().unwrap().is_some(),
        "失败升级不得清理钥匙链条目（升级尚未发生）"
    );

    // 可重试：清掉损坏行后重跑升级 → 成功（中断安全的闭环：失败不留死局）。
    vault
        .connection()
        .execute("DELETE FROM credentials WHERE id = ?1", [id_b])
        .unwrap();
    let fields = vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    assert_eq!(fields, 3, "A 的三字段");
    drop(vault);
    let reopened = Vault::open_with(dir.path(), &storage).unwrap();
    assert_eq!(reopened.mode(), KeyMode::Password);
    reopened.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert_eq!(
        Credentials::reveal(&reopened, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α")
    );
}

// ---------------------------------------------------------------------------
// 解锁状态机
// ---------------------------------------------------------------------------

#[test]
fn lock_cycle_clears_key_and_reunlock_works() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_password_only(dir.path()).unwrap();
    assert!(vault.is_locked());
    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    let (id_a, _) = seed_fixed_credentials(&vault);

    vault.lock(); // 手动锁定：Master Key 出内存
    assert!(vault.is_locked());
    assert!(matches!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret),
        Err(VaultError::Locked)
    ));
    vault.lock(); // 幂等
    assert!(vault.is_locked());

    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α")
    );
}

#[test]
fn locked_vault_keeps_plain_metadata_usable_but_rejects_keyed_ops() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_password_only(dir.path()).unwrap();
    // 锁定态（尚未设置过主密码）：明文面可用（锁定屏需要读配置）。
    Settings::set_str(&vault, "ui.theme", "dark").unwrap();
    assert_eq!(
        Settings::get_str(&vault, "ui.theme").unwrap().as_deref(),
        Some("dark")
    );
    // 明文实体（hosts 无密文列）写读可用。
    Hosts::create(
        &vault,
        HostInput {
            protocol: Default::default(),
            name: "meta-only".into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.9".into(),
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
    assert_eq!(Hosts::list(&vault).unwrap().len(), 1);
    // 需要密钥的操作一律 Locked。
    assert!(matches!(
        Credentials::create(
            &vault,
            &CredentialInput {
                name: None,
                kind: CredentialKind::Password,
                secret: Some("x".into()),
                key_pub: None,
                passphrase: None,
                totp_secret: None,
            },
        ),
        Err(VaultError::Locked)
    ));
}

#[test]
fn keyring_mode_has_no_lock_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    // keyring 模式：无锁概念——lock() no-op、unlock 拒绝（钥匙链在手随时重开）。
    vault.lock();
    assert!(!vault.is_locked(), "keyring 模式锁不了（无密钥可清）");
    assert!(matches!(
        vault.unlock_with_password(GOOD_PASSWORD),
        Err(VaultError::InvalidInput(_))
    ));
}

#[test]
fn double_upgrade_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    assert!(
        matches!(
            vault.set_master_password("another password!", &mut |_, _| {}),
            Err(VaultError::InvalidInput(_))
        ),
        "已 password 模式再升级必须拒绝"
    );
}

#[test]
fn upgrade_rejects_weak_passwords() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    for weak in ["", "short", "1234567"] {
        let err = vault.set_master_password(weak, &mut |_, _| {}).unwrap_err();
        assert!(
            matches!(err, VaultError::InvalidInput(_)),
            "{weak:?}: {err:?}"
        );
    }
    // 恰好 8 字符（下边界）放行。
    vault
        .set_master_password("12345678", &mut |_, _| {})
        .unwrap();
}

// ---------------------------------------------------------------------------
// Linux fallback：password-only 打开（生产入口 open_auto 的 fallback 分支）
// ---------------------------------------------------------------------------

#[test]
fn fallback_first_unlock_sets_master_password_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    // 首装：无模式记录 → 落 password 模式、锁定态。
    let vault = Vault::open_password_only(dir.path()).unwrap();
    assert_eq!(vault.mode(), KeyMode::Password);
    assert!(vault.is_locked());
    // 首次解锁 = 设置主密码。
    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    let (id_a, _) = seed_fixed_credentials(&vault);
    drop(vault);

    // 重开：仍锁定；同一主密码解锁；数据可解。
    let reopened = Vault::open_password_only(dir.path()).unwrap();
    assert!(reopened.is_locked());
    reopened.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert_eq!(
        Credentials::reveal(&reopened, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α")
    );
}

#[test]
fn fallback_refuses_keyring_mode_vault_when_keychain_dead() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap(); // keyring 模式库
    seed_fixed_credentials(&vault);
    drop(vault);

    // 钥匙链不可用（fallback 打开面）：库的密钥在钥匙链里 → 显式报错不换钥。
    let err = Vault::open_password_only(dir.path())
        .err()
        .expect("keyring-mode vault must refuse password-only open");
    assert!(
        matches!(err, VaultError::MasterKeyUnreachable),
        "实际 {err:?}"
    );
}

// ---------------------------------------------------------------------------
// keyring 错误分类（Linux fallback 判定原语，纯函数跨平台可测）
// ---------------------------------------------------------------------------

#[test]
fn keyring_error_classification() {
    use ottr_vault::master_key::keyring_error_is_unavailable;

    // 服务正常但无条目 → 可用。
    assert!(!keyring_error_is_unavailable(&keyring::Error::NoEntry));
    // 后端不可达（Linux 无 Secret Service 的典型面）→ 不可用。
    let platform: Box<dyn std::error::Error + Send + Sync> = "no secret service".into();
    assert!(keyring_error_is_unavailable(
        &keyring::Error::PlatformFailure(platform)
    ));
    let access: Box<dyn std::error::Error + Send + Sync> = "dbus unavailable".into();
    assert!(keyring_error_is_unavailable(
        &keyring::Error::NoStorageAccess(access)
    ));
    // 条目内容问题（服务在、数据坏）→ 不算不可用，走显式损坏错误面。
    assert!(!keyring_error_is_unavailable(&keyring::Error::BadEncoding(
        vec![0xff]
    )));
    assert!(!keyring_error_is_unavailable(&keyring::Error::TooLong(
        "account".into(),
        255
    )));
    // Display 可用性冒烟。
    let _ = keyring::Error::PlatformFailure("x".into()).to_string();
}

// ---------------------------------------------------------------------------
// settings 访问层（theme/language 迁移与安全配置的落点）
// ---------------------------------------------------------------------------

#[test]
fn settings_roundtrip_and_type_convenience() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();

    assert_eq!(Settings::get(&vault, "ui.theme").unwrap(), None);
    Settings::set_str(&vault, "ui.theme", "dark").unwrap();
    assert_eq!(
        Settings::get_str(&vault, "ui.theme").unwrap().as_deref(),
        Some("dark")
    );
    // upsert 覆盖。
    Settings::set_str(&vault, "ui.theme", "light").unwrap();
    assert_eq!(
        Settings::get_str(&vault, "ui.theme").unwrap().as_deref(),
        Some("light")
    );

    Settings::set_u64(&vault, "security.autolock_minutes", 10).unwrap();
    assert_eq!(
        Settings::get_u64(&vault, "security.autolock_minutes").unwrap(),
        Some(10)
    );
    // 类型不符 → None（get_str 对 number）。
    assert_eq!(
        Settings::get_str(&vault, "security.autolock_minutes").unwrap(),
        None
    );
    // 结构体值（JSON 对象）也可存取。
    Settings::set(
        &vault,
        "ai.provider",
        &serde_json::json!({"name": "openai"}),
    )
    .unwrap();
    assert_eq!(
        Settings::get(&vault, "ai.provider").unwrap(),
        Some(serde_json::json!({"name": "openai"}))
    );
    // 损坏 JSON 显式报错（不静默当未设置）。
    vault
        .connection()
        .execute(
            "UPDATE settings SET value = '{broken' WHERE key = 'ui.theme'",
            [],
        )
        .unwrap();
    assert!(Settings::get(&vault, "ui.theme").is_err());
    // 还原后重开：设置持久（幂等 open）。
    Settings::set_str(&vault, "ui.theme", "light").unwrap();
    drop(vault);
    let reopened = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    assert_eq!(
        Settings::get_str(&reopened, "ui.theme").unwrap().as_deref(),
        Some("light")
    );
}

// ---------------------------------------------------------------------------
// fix 1/5：评审 I-2（扫描非 schema 驱动守卫）+ M-3（库文件 0600）
// ---------------------------------------------------------------------------

/// I-2a 守卫测试：从 sqlite_master/PRAGMA 动态收集全库全部 `*_enc` 列，断言与
/// [`ottr_vault::store::scan_registry`] 完全一致——未来新增 `*_enc` 列（如
/// notify_channels.config_enc）而漏改注册表时，本测试必红（漏登 = 升级后旧钥
/// 删除、该列永久 GCM 认证失败，静默数据损毁）。
#[test]
fn reencrypt_scan_covers_all_enc_columns() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    let conn = vault.connection();

    // 动态收集：全部用户表（排除 sqlite_% 内部表；FTS 影子表无 _enc 列，自然落空）
    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let mut dynamic: Vec<(String, String)> = Vec::new();
    for table in &tables {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for col in columns {
            if col.ends_with("_enc") {
                dynamic.push((table.clone(), col));
            }
        }
    }
    drop(conn);

    // 注册表侧：(table, column) 集合
    let mut registry: Vec<(String, String)> = ottr_vault::store::scan_registry()
        .iter()
        .map(|c| (c.table.to_string(), c.column.to_string()))
        .collect();

    // 全库必须真的存在 _enc 列——否则收集逻辑本身退化（断言不是恒真）
    assert!(
        !dynamic.is_empty(),
        "库中应存在 *_enc 列（credentials 三列）；收集逻辑坏了先修收集"
    );
    dynamic.sort();
    registry.sort();
    assert_eq!(
        dynamic, registry,
        "全库 *_enc 列与重封扫描注册表不一致：新增列必须登记 scan_registry，\
         移除列必须同步清理（漏改 = 升级后旧钥删除、密文永久解不开）"
    );
}

/// M-3：vault.db Unix 权限 0600（密文 + meta 落盘面的最小权限）。
#[cfg(unix)]
#[test]
fn vault_db_file_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let _vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    let mode = std::fs::metadata(dir.path().join("vault.db"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600, "vault.db must be owner-only (0600)");
}

// ---------------------------------------------------------------------------
// 降级（password → keyring）：clear_master_password（no-lock 任务，2026-10-05）
// 崩溃安全核心：先写钥匙链（事务前，失败/崩溃 = 密码模式完好可重试）→
// 单事务重密封 + meta 翻转 → 提交后切内存态。镜像 set_master_password 三件套。
// ---------------------------------------------------------------------------

/// set → clear → reopen：降级后 keyring 模式重开（新钥匙链钥）读数据一致、
/// meta 无 salt/verifier 残留、旧钥匙链条目被新条目覆盖。
#[test]
fn downgrade_set_then_clear_reseals_and_reopens_in_keyring_mode() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let (id_a, id_b) = seed_fixed_credentials(&vault);
    let old_key = storage.load().unwrap();
    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    assert_eq!(vault.mode(), KeyMode::Password);
    drop(vault);

    // 重开（password 模式）→ 解锁 → 降级。open 时残留钥匙链条目被兜底清理
    // （与升级同款），随后降级写回新钥——storage 是降级后的信任根。
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    vault
        .clear_master_password(&storage, &mut |_, _| {})
        .unwrap();

    // 提交后内存态已切：keyring 模式 + 解锁态，同会话数据可解。
    assert_eq!(vault.mode(), KeyMode::Keyring, "降级必须翻转模式");
    assert!(!vault.is_locked(), "keyring 模式无锁概念（open 即解锁）");
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α"),
        "降级后同会话数据必须可解（新钥密封）"
    );
    // meta 翻转：mode=keyring、salt/verifier 清除（与密文同事务，无中间态）。
    let mode: String = vault
        .connection()
        .query_row(
            "SELECT value FROM meta WHERE key = 'master_key.mode'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mode, "keyring", "meta 模式行必须落 keyring");
    let leftovers: i64 = vault
        .connection()
        .query_row(
            "SELECT count(*) FROM meta WHERE key IN ('master_key.kdf_salt','master_key.verifier')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        leftovers, 0,
        "降级必须清除 salt/verifier（密码派生参数不残留）"
    );
    // 钥匙链条目 = 新随机钥（非旧钥、非密码材料）。
    let new_key = storage.load().unwrap().expect("降级必须写回钥匙链");
    assert_ne!(new_key, old_key.expect("升级前 keyring 条目存在"));
    drop(vault);

    // 重开（keyring 模式）：免密解锁、固定凭据集逐字段与迁移前一致。
    let reopened = Vault::open_with(dir.path(), &storage).unwrap();
    assert_eq!(reopened.mode(), KeyMode::Keyring);
    assert!(!reopened.is_locked(), "keyring 模式重开即解锁");
    for (id, field, want) in [
        (id_a, ottr_vault::SecretField::Secret, "s3cret-password-α"),
        (
            id_a,
            ottr_vault::SecretField::Passphrase,
            "folder-passphrase",
        ),
        (
            id_a,
            ottr_vault::SecretField::TotpSecret,
            "JBSWY3DPEHPK3PXP",
        ),
        (
            id_b,
            ottr_vault::SecretField::Secret,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nseed-b\n-----END OPENSSH PRIVATE KEY-----",
        ),
    ] {
        assert_eq!(
            Credentials::reveal(&reopened, id, field)
                .unwrap()
                .as_deref(),
            Some(want),
            "{field:?} of cred {id}"
        );
    }
    let host = &Hosts::list(&reopened).unwrap()[0];
    assert_eq!(host.credential_id, Some(id_a), "元数据面完整");
}

/// 门卫：keyring 模式调用拒绝（InvalidInput——无可降级）；锁定态拒绝（Locked
/// ——重密封需要旧钥）。锁定态拒绝后解锁仍可用（失败不破坏任何状态）。
#[test]
fn downgrade_rejects_keyring_mode_and_locked_state() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    assert!(
        matches!(
            vault.clear_master_password(&storage, &mut |_, _| {}),
            Err(VaultError::InvalidInput(_))
        ),
        "keyring 模式无可降级，必须显式拒绝"
    );

    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    vault.lock();
    assert!(
        matches!(
            vault.clear_master_password(&storage, &mut |_, _| {}),
            Err(VaultError::Locked)
        ),
        "锁定态重密封无从取旧钥，必须拒绝"
    );
    vault.unlock_with_password(GOOD_PASSWORD).unwrap();
    assert!(
        vault
            .clear_master_password(&storage, &mut |_, _| {})
            .is_ok(),
        "解锁后降级可用（锁定拒绝不破坏状态）"
    );
}

/// storage.save 失败 → abort-safe：错误如实上抛、库原样（模式仍 password、
/// 数据仍可用主密码解锁、meta 无残留）——事务尚未开始，什么都没发生。
#[test]
fn downgrade_aborts_when_keychain_save_fails_and_keeps_password_mode() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    let (id_a, _) = seed_fixed_credentials(&vault);
    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();
    // 预埋 salt/verifier 存在（降级事务本来要清掉它们）——abort 后必须原样。
    let salt_before: i64 = vault
        .connection()
        .query_row(
            "SELECT count(*) FROM meta WHERE key IN ('master_key.kdf_salt','master_key.verifier')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(salt_before, 2);

    // 刻意损坏的 storage：save 恒败（模拟钥匙链拒绝访问）。
    struct BrokenStorage;
    impl KeyStorage for BrokenStorage {
        fn load(&self) -> ottr_vault::Result<Option<String>> {
            Ok(None)
        }
        fn save(&self, _secret: &str) -> ottr_vault::Result<()> {
            Err(VaultError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "keychain denied",
            )))
        }
        fn delete(&self) -> ottr_vault::Result<()> {
            Ok(())
        }
    }
    let err = vault
        .clear_master_password(&BrokenStorage, &mut |_, _| {})
        .unwrap_err();
    assert!(matches!(err, VaultError::Io(_)), "实际 {err:?}");

    assert_eq!(vault.mode(), KeyMode::Password, "失败降级不得翻转模式");
    assert!(!vault.is_locked(), "失败降级不得动解锁态");
    let leftovers: i64 = vault
        .connection()
        .query_row(
            "SELECT count(*) FROM meta WHERE key IN ('master_key.kdf_salt','master_key.verifier')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftovers, 2, "失败降级不得清除 salt/verifier");
    assert_eq!(
        Credentials::reveal(&vault, id_a, ottr_vault::SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("s3cret-password-α"),
        "失败降级后旧钥必须原样可用"
    );
    // 可重试：换正常 storage 重跑 → 成功（中断安全闭环）。
    vault
        .clear_master_password(&storage, &mut |_, _| {})
        .unwrap();
    assert_eq!(vault.mode(), KeyMode::Keyring);
}

/// 进度回调：逐字段推进、次数 = 注册表非空字段总数、终值收口 (total, total)。
#[test]
fn downgrade_progress_callbacks_match_registry_total() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = Vault::open_with(dir.path(), &storage).unwrap();
    seed_fixed_credentials(&vault); // A 三字段 + B 一字段 = 4
    vault
        .set_master_password(GOOD_PASSWORD, &mut |_, _| {})
        .unwrap();

    let mut progress = Vec::new();
    vault
        .clear_master_password(&storage, &mut |done, total| {
            progress.push((done, total));
        })
        .unwrap();
    assert_eq!(progress.len(), 4, "回调次数必须 = 重密封字段总数");
    assert_eq!(progress.last(), Some(&(4, 4)), "进度终值必须收口在总数上");
}

/// BL-202：主密码最小长度计量 = Unicode 码点数（`chars().count()`），与前端
/// 预检（SecuritySettings MIN_MASTER_PASSWORD，码点口径）同值同语义。
/// 4 个增补平面字符（emoji，UTF-16 length 恰为 8）必须被权威校验拒绝；
/// 8 个 emoji（8 码点）通过长度门卫、走到升级成功——钉死「不是按 UTF-16
/// 码元也不是按字节数」的口径分叉面。
#[test]
fn master_password_min_len_counts_code_points_not_utf16_units() {
    let four_emoji = "😀😀😀😀"; // 4 码点 / 8 UTF-16 码元 / 16 字节
    assert_eq!(four_emoji.chars().count(), 4);
    assert_eq!(four_emoji.len(), 16);

    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    let err = vault
        .set_master_password(four_emoji, &mut |_, _| {})
        .unwrap_err();
    match err {
        VaultError::InvalidInput(msg) => {
            assert!(
                msg.contains("at least 8"),
                "4 码点必须被最小长度门卫拒绝，实际 {msg}"
            );
        }
        other => panic!("expected InvalidInput, got {other:?}"),
    }

    // 8 码点（同字符类）通过长度门卫：keyring 全新库升级成功、模式翻转。
    let eight_emoji = "😀😀😀😀😀😀😀😀";
    assert_eq!(eight_emoji.chars().count(), 8);
    vault
        .set_master_password(eight_emoji, &mut |_, _| {})
        .expect("8 码点必须通过最小长度门卫");
    assert_eq!(vault.mode(), KeyMode::Password);
}
