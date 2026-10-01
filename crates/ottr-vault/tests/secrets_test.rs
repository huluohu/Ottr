//! secrets 表 TDD（Task 13）：AI provider api key 等敏感配置的密封 KV。
//! 纪律同既有 vault 测试：InMemoryStorage + tempfile，绝不触碰真实钥匙链。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{Secrets, Vault, VaultError};

fn open_mem() -> Vault {
    Vault::open_with(
        &tempfile::tempdir().unwrap().keep(),
        &InMemoryStorage::new(),
    )
    .expect("open in-memory vault")
}

#[test]
fn set_get_roundtrip() {
    let vault = open_mem();
    Secrets::set(&vault, "ai.apikey.p1", "sk-test-123").unwrap();
    assert_eq!(Secrets::get(&vault, "ai.apikey.p1").unwrap().as_deref(), Some("sk-test-123"));
    assert!(Secrets::contains(&vault, "ai.apikey.p1").unwrap());
    assert!(!Secrets::contains(&vault, "ai.apikey.p2").unwrap());
    assert_eq!(Secrets::get(&vault, "missing").unwrap(), None);
}

#[test]
fn secret_is_sealed_at_rest() {
    // 直查库文件：明文不落盘，密文 ≠ 明文（WAL 模式下主文件与 -wal 副文件都查）
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    Secrets::set(&vault, "ai.apikey.p1", "sk-PLAINTEXT-VALUE").unwrap();
    let mut raw = Vec::new();
    for side in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        if let Ok(bytes) = std::fs::read(dir.path().join(side)) {
            raw.extend_from_slice(&bytes);
        }
    }
    let raw_str = String::from_utf8_lossy(&raw);
    assert!(!raw_str.contains("sk-PLAINTEXT-VALUE"), "明文不得出现在库文件里");
    // 键名本身是逻辑名（非敏感），允许出现（检索/删除按 key 定位）
    assert!(raw_str.contains("ai.apikey.p1"), "键名（逻辑名）应可检索");
}

#[test]
fn upsert_overwrites_same_key_single_row() {
    let vault = open_mem();
    Secrets::set(&vault, "k", "v1").unwrap();
    Secrets::set(&vault, "k", "v2").unwrap();
    assert_eq!(Secrets::get(&vault, "k").unwrap().as_deref(), Some("v2"));
    let conn = vault.connection();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM secrets WHERE key = 'k'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "upsert 不新增行");
}

#[test]
fn delete_then_get_none_and_not_found_on_repeat() {
    let vault = open_mem();
    Secrets::set(&vault, "k", "v").unwrap();
    Secrets::delete(&vault, "k").unwrap();
    assert_eq!(Secrets::get(&vault, "k").unwrap(), None);
    assert!(matches!(
        Secrets::delete(&vault, "k"),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn empty_key_rejected() {
    let vault = open_mem();
    assert!(matches!(
        Secrets::set(&vault, "  ", "v"),
        Err(VaultError::InvalidInput(_))
    ));
}

#[test]
fn locked_vault_rejects_secret_io() {
    // password 模式 open 即锁定：密文面读写一律 Locked（settings 明文面不受影响）
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_password_only(dir.path()).unwrap();
    assert!(vault.is_locked());
    assert!(matches!(
        Secrets::set(&vault, "k", "v"),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        Secrets::get(&vault, "k"),
        Err(VaultError::Locked)
    ));
}

#[test]
fn tampered_ciphertext_fails_explicitly() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    Secrets::set(&vault, "k", "v").unwrap();
    {
        let conn = vault.connection();
        conn.execute("UPDATE secrets SET value_enc = X'00' WHERE key = 'k'", [])
            .unwrap();
    }
    assert!(matches!(
        Secrets::get(&vault, "k"),
        Err(VaultError::Crypto(_))
    ));
}

/// T11 守卫的语义面回归：secrets.value_enc 必须随主密码升级重密封——
/// 升级（旧钥销毁语义）后新钥能解出原值；漏登 scan_registry 时此测试必红。
#[test]
fn master_password_upgrade_reseals_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &InMemoryStorage::new()).unwrap();
    Secrets::set(&vault, "ai.apikey.p1", "sk-before-upgrade").unwrap();

    let resealed = vault
        .set_master_password("correct horse battery staple", &mut |_done, _total| {})
        .unwrap();
    assert!(resealed >= 1, "secrets 至少贡献 1 个重密封字段");
    assert_eq!(
        Secrets::get(&vault, "ai.apikey.p1").unwrap().as_deref(),
        Some("sk-before-upgrade"),
        "升级后同实例（新钥）直接可解"
    );

    // 重开（password 模式锁定）→ 解锁 → 仍可解（持久面验证）
    drop(vault);
    let reopened = Vault::open_password_only(dir.path()).unwrap();
    assert!(reopened.is_locked());
    reopened
        .unlock_with_password("correct horse battery staple")
        .unwrap();
    assert_eq!(
        Secrets::get(&reopened, "ai.apikey.p1").unwrap().as_deref(),
        Some("sk-before-upgrade")
    );
}

#[test]
fn rowids_never_reused_for_secrets() {
    // AAD 绑定 rowid → 永不复用纪律（T4 评审 I-1）在 secrets 表同样成立
    let vault = open_mem();
    Secrets::set(&vault, "k1", "v1").unwrap();
    Secrets::set(&vault, "k2", "v2").unwrap();
    Secrets::delete(&vault, "k2").unwrap();
    Secrets::set(&vault, "k3", "v3").unwrap();
    let conn = vault.connection();
    let (id_k1, id_k3): (i64, i64) = conn
        .query_row(
            "SELECT max(CASE WHEN key='k1' THEN id END), max(CASE WHEN key='k3' THEN id END) FROM secrets",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(id_k3 > id_k1, "删除后新行 id 必须严格递增（AUTOINCREMENT）");
}
