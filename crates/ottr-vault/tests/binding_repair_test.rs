//! 凭据绑定修复（2026-11-03，v1.6.2 数据事故）：
//!
//! **事故**：0026 迁移为加 `kind='agent'` 重建 `credentials` 表（DROP + RENAME）。
//! 而 `hosts.credential_id` 上挂着 `REFERENCES credentials(id) ON DELETE SET NULL`
//! —— SQLite 在 `foreign_keys=ON` 时 DROP 父表会**立即执行 SET NULL 动作**，
//! 把用户所有主机的凭据绑定静默清空（升级后所有主机都连不上）。
//!
//! 本测试钉住三件事：
//!   1. **迁移不再清空绑定**——表重建期外键强制必须关闭（根因修复）；
//!   2. **修复器能按名称匹配把绑定找回来**（exact / contains / 中文二字片段）；
//!   3. **歧义即放弃**——一个主机名命中多个凭据时不动它（宁可让用户手动，
//!      也不能把主机绑到错误凭据上：绑错的症状是认证失败，会误导排查方向）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    CredentialInput, CredentialKind, CredentialPatch, Credentials, HostInput, HostProtocol, Hosts,
    Vault,
};

/// 钥匙串 mock：**全测试共用一个**——重开同一个库时主密钥要从钥匙串里取，
/// 每次新建 InMemoryStorage 会丢钥匙（KeyringLost）。
fn shared_storage() -> &'static InMemoryStorage {
    static S: std::sync::OnceLock<InMemoryStorage> = std::sync::OnceLock::new();
    S.get_or_init(InMemoryStorage::new)
}

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, shared_storage()).expect("open vault")
}

fn make_credential(v: &Vault, name: &str) -> i64 {
    let c = Credentials::create(
        v,
        &CredentialInput {
            kind: CredentialKind::Password,
            name: Some(name.into()),
            secret: Some("pw".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: None,
            totp_digits: None,
            totp_period: None,
        },
    )
    .expect("create credential");
    c.id
}

fn make_host(v: &Vault, name: &str, credential_id: Option<i64>) -> i64 {
    let h = Hosts::create(
        v,
        HostInput {
            name: name.into(),
            group_id: None,
            tags: vec![],
            address: format!("10.0.0.{}", name.len()),
            port: 22,
            username: Some("deploy".into()),
            protocol: HostProtocol::Ssh,
            credential_id,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
            is_production: false,
        },
    )
    .expect("create host");
    h.id
}

/// 模拟「v1.6.2 中招」：把某台主机的凭据绑定清成 NULL（等价于被外键
/// `ON DELETE SET NULL` 清空后的状态）。
fn clear_binding(v: &Vault, host_id: i64) {
    let conn = v.connection();
    conn.execute(
        "UPDATE hosts SET credential_id = NULL WHERE id = ?1",
        [host_id],
    )
    .expect("clear binding");
}

/// 读回某台主机当前绑定的凭据 id。
fn binding_of(v: &Vault, host_id: i64) -> Option<i64> {
    let conn = v.connection();
    conn.query_row(
        "SELECT credential_id FROM hosts WHERE id = ?1",
        [host_id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .expect("read binding")
}

#[test]
fn migration_0026_preserves_credential_bindings() {
    // 根因回归钉（真实路径）：**从 v1.6.0 的库升级到 v1.6.2** 时，0026 重建
    // credentials 表不得清空 hosts.credential_id。
    //
    // 做法：把库回退成 0026 之前的样子（schema_version=25 + 旧 CHECK 的
    // credentials 表），建一条带绑定的主机，再重新打开让迁移器跑 0026/0027/0028
    // —— 绑定必须还在。
    let dir = tempfile::tempdir().expect("tmp");
    {
        let v = open_vault(dir.path());
        let conn = v.connection();
        // 回到 0025 的表形状（kind 不含 'agent'）+ 版本号 25。
        conn.pragma_update(None, "foreign_keys", "OFF").expect("fk off");
        conn.execute_batch(
            "CREATE TABLE credentials_v25 (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind TEXT NOT NULL CHECK (kind IN ('password','key','totp','ftp','ftps')),
                 secret_enc BLOB, key_pub TEXT, passphrase_enc BLOB,
                 totp_secret_enc BLOB, totp_digits INTEGER, totp_period INTEGER,
                 name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO credentials_v25 SELECT id, kind, secret_enc, key_pub, passphrase_enc,
                 totp_secret_enc, totp_digits, totp_period, name, created_at, updated_at
                 FROM credentials;
             DROP TABLE credentials;
             ALTER TABLE credentials_v25 RENAME TO credentials;
             DROP TABLE IF EXISTS binding_repairs;
             UPDATE meta SET value = '25' WHERE key = 'schema_version';",
        )
        .expect("downgrade schema to v25");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk on");
    }

    // 用 v25 形状的库建凭据 + 绑定（模拟用户升级前的库）。
    {
        let v = open_vault(dir.path());
        // open 会跑迁移（25 → 28），所以这里直接在 v25 库里手工插：先关掉
        // 迁移（把版本改回 25 已在上面做完，但 open 又会跑 26 起）——
        // 故改为：让 open 跑完迁移，再用它的表建数据、再把版本号压回 25。
        let cred = make_credential(&v, "deploy-pw");
        let host = make_host(&v, "web-1", Some(cred));
        assert_eq!(binding_of(&v, host), Some(cred));
        // 记录这次绑定的凭据 id，供升级后比对。
        let conn = v.connection();
        conn.execute(
            "UPDATE meta SET value = '25' WHERE key = 'schema_version'",
            [],
        )
        .expect("set version back to 25");
        // 0026 需要把 credentials 还原成 v25 形状（上面已被迁移成 v27 形状，
        // 这里再退一次，保证升级路径与真实场景一致）。
        conn.pragma_update(None, "foreign_keys", "OFF").expect("fk off");
        conn.execute_batch(
            "CREATE TABLE credentials_v25b (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind TEXT NOT NULL CHECK (kind IN ('password','key','totp','ftp','ftps')),
                 secret_enc BLOB, key_pub TEXT, passphrase_enc BLOB,
                 totp_secret_enc BLOB, totp_digits INTEGER, totp_period INTEGER,
                 name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO credentials_v25b SELECT id, kind, secret_enc, key_pub, passphrase_enc,
                 totp_secret_enc, totp_digits, totp_period, name, created_at, updated_at
                 FROM credentials;
             DROP TABLE credentials;
             ALTER TABLE credentials_v25b RENAME TO credentials;",
        )
        .expect("restore v25 credentials shape");
        conn.pragma_update(None, "foreign_keys", "ON").expect("fk on");
    }

    // 重新打开 → 迁移器跑 0026（重建 credentials 表）。
    let v = open_vault(dir.path());
    let conn = v.connection();
    let bound: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM hosts WHERE credential_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .expect("count bound");
    assert_eq!(
        bound, 1,
        "0026 迁移重建 credentials 表不得清空 hosts.credential_id（v1.6.2 事故）"
    );
}

#[test]
fn repair_restores_binding_by_name() {
    let dir = tempfile::tempdir().expect("tmp");
    let v = open_vault(dir.path());

    let c_office = make_credential(&v, "办公电脑");
    let c_nas = make_credential(&v, "NAS");
    let c_58 = make_credential(&v, "58");

    let h_office = make_host(&v, "办公Ubuntu", Some(c_office));
    let h_nas_local = make_host(&v, "NAS-local", Some(c_nas));
    let h_nas_remote = make_host(&v, "NAS-remote", Some(c_nas));
    let h_58 = make_host(&v, "9.58", Some(c_58));

    // 模拟中招：绑定全被清空。
    for h in [h_office, h_nas_local, h_nas_remote, h_58] {
        clear_binding(&v, h);
    }

    let report = ottr_vault::store::restore_lost_credential_bindings(&v.connection()).expect("repair");
    assert_eq!(report.restored.len(), 4, "四台都应恢复：{report:?}");
    assert!(report.unmatched_hosts.is_empty(), "{report:?}");

    assert_eq!(binding_of(&v, h_office), Some(c_office), "中文二字片段匹配");
    assert_eq!(binding_of(&v, h_nas_local), Some(c_nas), "子串匹配");
    assert_eq!(binding_of(&v, h_nas_remote), Some(c_nas), "同一凭据可绑多台");
    assert_eq!(binding_of(&v, h_58), Some(c_58), "数字名子串匹配");
}

#[test]
fn repair_skips_ambiguous_hosts() {
    let dir = tempfile::tempdir().expect("tmp");
    let v = open_vault(dir.path());

    // 两个凭据名都能匹配上 "web" —— 歧义，不能瞎绑。
    let c1 = make_credential(&v, "web-prod");
    let _c2 = make_credential(&v, "web-test");
    let h = make_host(&v, "web", Some(c1));
    clear_binding(&v, h);

    let report = ottr_vault::store::restore_lost_credential_bindings(&v.connection()).expect("repair");
    assert!(report.restored.is_empty(), "歧义不应自动恢复：{report:?}");
    assert_eq!(report.unmatched_hosts, vec![h], "应记为待人工处理");
    assert_eq!(binding_of(&v, h), None, "歧义主机保持未绑定");
}

#[test]
fn repair_is_noop_when_bindings_intact() {
    let dir = tempfile::tempdir().expect("tmp");
    let v = open_vault(dir.path());
    let cred = make_credential(&v, "office");
    let host = make_host(&v, "office-box", Some(cred));

    let report = ottr_vault::store::restore_lost_credential_bindings(&v.connection()).expect("repair");
    assert!(report.restored.is_empty(), "绑定完好时不得改动：{report:?}");
    assert_eq!(binding_of(&v, host), Some(cred));
}

#[test]
fn repair_keeps_unrelated_credentials_untouched() {
    let dir = tempfile::tempdir().expect("tmp");
    let v = open_vault(dir.path());

    // 无名凭据（name 为空）—— 不该被任何主机名误匹配。
    let c = Credentials::create(
        &v,
        &CredentialInput {
            kind: CredentialKind::Password,
            name: None,
            secret: Some("pw".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: None,
            totp_digits: None,
            totp_period: None,
        },
    )
    .expect("create credential");
    let h = make_host(&v, "office-box", Some(c.id));
    clear_binding(&v, h);

    let report = ottr_vault::store::restore_lost_credential_bindings(&v.connection()).expect("repair");
    assert!(report.restored.is_empty(), "无名凭据不参与匹配：{report:?}");
    assert_eq!(binding_of(&v, h), None);
}

#[test]
fn credential_patch_does_not_clear_binding() {
    // 顺手钉住：改凭据（改名/改密）不得动主机绑定（曾担心重建表之外的路）。
    let dir = tempfile::tempdir().expect("tmp");
    let v = open_vault(dir.path());
    let cred = make_credential(&v, "old-name");
    let host = make_host(&v, "box", Some(cred));

    Credentials::update(
        &v,
        cred,
        &CredentialPatch {
            kind: None,
            name: Some(Some("new-name".into())),
            secret: None,
            key_pub: None,
            passphrase: None,
            totp_secret: None,
            totp_digits: None,
            totp_period: None,
        },
    )
    .expect("patch credential");

    assert_eq!(binding_of(&v, host), Some(cred), "改凭据不动主机绑定");
}
