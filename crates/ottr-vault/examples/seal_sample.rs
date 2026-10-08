//! Task 17 四维验收·安全维：真实 vault.db 落盘密文抽检样本生成。
//!
//! 用生产同款 seal 路径（`Vault::open_with` + `Credentials::create` +
//! `Secrets::set`，密钥走 [`InMemoryStorage`]——与 keyring 模式同一加密层，
//! 仅钥匙存取面不同）写一个真实 SQLite 文件：含密码凭据（secret/passphrase/
//! totp_secret 三字段）与 AI api key 密封 KV。随后由验收脚本用 sqlite3 直查
//! 该文件：明文样本必须零命中、`*_enc` BLOB 必须存在。
//!
//! 运行：`cargo run -p ottr-vault --example seal_sample`（样本文件
//! /tmp/ottr-t17/seal-sample/vault.db；stdout 打印写入的明文样本供 grep 对照）。

use ottr_vault::entities::{CredentialInput, CredentialKind, Credentials};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{Vault, secrets};

const SECRET_SAMPLE: &str = "ottr-t17-sample-password-spike-pass";
const PASSPHRASE_SAMPLE: &str = "ottr-t17-sample-passphrase";
const TOTP_SAMPLE: &str = "JBSWY3DPEHPK3PXP-t17";
const APIKEY_SAMPLE: &str = "sk-t17-demo-0123456789abcdef";

fn main() {
    let dir = "/tmp/ottr-t17/seal-sample";
    std::fs::create_dir_all(dir).expect("create dir");
    // 清理旧样本（open 会拒「已初始化但 key 不匹配」之类的脏状态）
    for f in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        let p = format!("{dir}/{f}");
        std::fs::remove_file(&p).ok();
    }
    let vault =
        Vault::open_with(std::path::Path::new(dir), &InMemoryStorage::new()).expect("open vault");
    let cred = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Password,
            secret: Some(SECRET_SAMPLE.into()),
            key_pub: Some("ssh-ed25519 AAAA t17-sample".into()),
            passphrase: Some(PASSPHRASE_SAMPLE.into()),
            totp_secret: Some(TOTP_SAMPLE.into()),
        },
    )
    .expect("create credential");
    secrets::Secrets::set(&vault, "ai.apikey.deepseek", APIKEY_SAMPLE).expect("seal apikey");
    println!("credential id={} created; secrets sealed", cred.id);
    println!("sample_secret={SECRET_SAMPLE}");
    println!("sample_passphrase={PASSPHRASE_SAMPLE}");
    println!("sample_totp={TOTP_SAMPLE}");
    println!("sample_apikey={APIKEY_SAMPLE}");
    drop(vault);
    println!("sample_db={dir}/vault.db");
}
