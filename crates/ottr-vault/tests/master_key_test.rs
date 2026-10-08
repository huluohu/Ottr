//! master key TDD（Task 3 Loop 3）：生成→存储读取一致、二次 load 复用、
//! 损坏条目→明确错误、Argon2id 派生原语（Linux 无钥匙链 fallback / 主密码模式）。
//! 纪律：一律 InMemoryStorage——真钥匙链只在 examples/keyring_manual.rs 手动验证。

use ottr_vault::VaultError;
use ottr_vault::master_key::{InMemoryStorage, KeyStorage, MasterKey, derive_key_argon2id};

#[test]
fn generated_key_matches_storage() {
    let storage = InMemoryStorage::new();
    let master = MasterKey::load_with_storage(&storage).expect("first load generates");

    // 钥匙链条目（hex）解码后必须与 MasterKey 持有的字节一致。
    let stored = storage.load().unwrap().expect("key saved to storage");
    let decoded = hex::decode(stored.trim()).unwrap();
    assert_eq!(decoded.len(), 32);
    assert_eq!(decoded.as_slice(), master.key().as_slice());
}

#[test]
fn second_load_reuses_key() {
    let storage = InMemoryStorage::new();
    let first = MasterKey::load_with_storage(&storage).unwrap();
    let raw_after_generate = storage.load().unwrap().clone();

    let second = MasterKey::load_with_storage(&storage).unwrap();
    assert_eq!(first.key(), second.key(), "二次 load 必须复用同一把 key");
    // 复用不重写条目（生成路径只发生一次）。
    assert_eq!(
        storage.load().unwrap().as_deref(),
        raw_after_generate.as_deref()
    );
}

#[test]
fn corrupted_entry_gives_clear_error() {
    // 非十六进制垃圾。
    let garbage = InMemoryStorage::with_raw("ottr-corrupted-by-external-tool!!");
    match MasterKey::load_with_storage(&garbage) {
        Err(VaultError::CorruptedMasterKey) => {}
        other => panic!(
            "垃圾条目应报 CorruptedMasterKey，实际 {:?}",
            other.map(|_| ()).is_err()
        ),
    }

    // 合法十六进制但长度不对（32B key 必须 64 hex 字符）。
    let short = InMemoryStorage::with_raw("aabbcc");
    match MasterKey::load_with_storage(&short) {
        Err(VaultError::CorruptedMasterKey) => {}
        other => panic!(
            "短条目应报 CorruptedMasterKey，实际 {:?}",
            other.map(|_| ()).is_err()
        ),
    }
}

#[test]
fn argon2id_derive_is_deterministic_and_distinct() {
    let salt = b"ottr-fallback-salt";
    let a = derive_key_argon2id("correct horse battery staple", salt).unwrap();
    let b = derive_key_argon2id("correct horse battery staple", salt).unwrap();
    assert_eq!(a, b, "同密码+同盐必须确定性派生");
    assert_eq!(a.len(), 32);

    let wrong_pw = derive_key_argon2id("wrong password", salt).unwrap();
    assert_ne!(a, wrong_pw, "不同密码必须派生不同 key");
    let wrong_salt = derive_key_argon2id("correct horse battery staple", b"other-salt").unwrap();
    assert_ne!(a, wrong_salt, "不同盐必须派生不同 key");
}

#[test]
fn master_key_feeds_vault_crypto_roundtrip() {
    // 层级闭环：storage 里的 key 经 MasterKey 进 Cipher，同一 storage 两次 open
    // 的 Vault 必须能互相解密对方的密文（证明 key 复用贯通整条链路）。
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();

    let vault = ottr_vault::Vault::open_with(dir.path(), &storage).unwrap();
    let blob = vault
        .cipher()
        .unwrap()
        .seal(b"secret-bytes", "credentials:1:secret")
        .unwrap();
    drop(vault);

    let reopened = ottr_vault::Vault::open_with(dir.path(), &storage).unwrap();
    assert_eq!(
        reopened
            .cipher()
            .unwrap()
            .open(&blob, "credentials:1:secret")
            .unwrap(),
        b"secret-bytes"
    );
}
