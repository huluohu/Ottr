//! 真钥匙链手动验证（Task 3 纪律：CI/自动化测试不碰真钥匙链，本 example 是
//! 唯一的 keyring 真实读写验证点，本机跑一次并记录输出到 task report）。
//!
//! ```sh
//! cargo run -p ottr-vault --example keyring_manual
//! ```
//!
//! service 用 `ottr.dev.manual-check`（与正式数据 `ottr.dev` 隔离），跑完自清理。

use ottr_vault::master_key::{KeyStorage, KeyringStorage, MasterKey};

const SERVICE: &str = "ottr.dev.manual-check";

fn main() {
    // 起跑前清残留，保证每次验证从零开始。
    KeyringStorage::new(SERVICE).delete().expect("pre-clean");

    let storage = KeyringStorage::new(SERVICE);

    // 1. 无条目 → 生成 32B 随机并入钥匙链。
    let first = MasterKey::load_with_storage(&storage).expect("generate into keychain");
    let stored = storage
        .load()
        .expect("keychain read")
        .expect("entry exists");
    let decoded = hex::decode(&stored).expect("stored secret is hex");
    assert_eq!(
        decoded.as_slice(),
        first.key().as_slice(),
        "keychain entry matches MasterKey"
    );
    println!("PASS 1 generate: 64-hex entry written to keychain service={SERVICE}");
    println!("      entry head: {}… (前 8 字符)", &stored[..8]);

    // 2. 二次 load 复用（真钥匙链往返）。
    let second = MasterKey::load_with_storage(&storage).expect("reuse from keychain");
    assert_eq!(
        first.key(),
        second.key(),
        "second load must reuse the same key"
    );
    println!("PASS 2 reuse: second load returned the identical 32B key");

    // 3. 密钥链条目真的在场（可从系统钥匙链工具侧目检：service=ottr.dev.manual-check）。
    let again = storage
        .load()
        .expect("keychain read")
        .expect("entry still there");
    assert_eq!(again, stored, "entry unchanged after reuse");
    println!("PASS 3 persisted: entry stable across reads");

    // 4. 清理 + 幂等删除。
    storage.delete().expect("delete entry");
    assert!(
        storage.load().expect("read after delete").is_none(),
        "entry gone"
    );
    storage
        .delete()
        .expect("delete is idempotent (NoEntry is Ok)");
    println!("PASS 4 cleanup: entry deleted; second delete is a no-op");

    println!(
        "\nAll keyring manual checks passed. 建议在「钥匙串访问」App 搜索 \
             {SERVICE} 目检条目是否已清。"
    );
}
