//! seed_vault（Phase 3 Task 7 验收 · GUI 走查工具）：向指定目录播种一个
//! **password-only 模式**库并写入夹具主机（127.0.0.1:2222 / spike / 密码
//! 凭据 + known_hosts verified + monitor_enabled=1），供 GUI 走查绕开
//! 钥匙链 ACL 弹窗（phase1-acceptance R10 环境残留：重建的二进制 CDHash
//! 变更触发 SecurityAgent 登录密码问询，自动化无法输入）——password 模式
//! open 即锁定、走 LockScreen 输主密码解锁，**全程零钥匙链访问**。
//!
//! 【走查后恢复】调用方自行备份/还原 app 数据目录（本工具只碰给定的
//! vault 目录，不触碰钥匙链与其它文件）。
//!
//! Run: `cargo build --release -p ottr-vault --example seed_vault`
//!      `target/release/examples/seed_vault <vault_dir> [password=ottr-t7]`
use std::path::PathBuf;

use ottr_vault::entities::{
    CredentialInput, CredentialKind, Credentials, HostInput, HostProtocol, Hosts, KnownHosts,
};
use ottr_vault::Vault;

const FIXTURE_FP: &str = "SHA256:nLaxv/1hXxccQNB7JauQUi63z0YmST4P3AvViyoNCIQ";
const HOST_KEY: &str = "[127.0.0.1]:2222";

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = match args.next() {
        Some(d) => PathBuf::from(d),
        None => {
            eprintln!("usage: seed_vault <vault_dir> [password=ottr-t7]");
            std::process::exit(2);
        }
    };
    let password = args.next().unwrap_or_else(|| "ottr-t7".into());

    // password-only open：open 即锁定（内存无密钥）；首次 unlock_with_password
    // 一次性写 salt+verifier（store.rs open_password_only 文档）。
    let vault = Vault::open_password_only(&dir).expect("open_password_only");
    vault.unlock_with_password(&password).expect("set master password");

    let cred = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Password,
            secret: Some("spike-pass".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: None,
        },
    )
    .expect("create credential");

    let host = Hosts::create(
        &vault,
        HostInput {
            name: "t12-prod".into(),
            group_id: None,
            tags: vec![],
            address: "127.0.0.1".into(),
            port: 2222,
            username: Some("spike".into()),
            protocol: HostProtocol::Ssh,
            credential_id: Some(cred.id),
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: true,
            is_production: false,
            notes: None,
        },
    )
    .expect("create host");

    // TOFU 预裁定（known_hosts verified=1）：真夹具指纹 pin，连接不走问询。
    KnownHosts::upsert(&vault, HOST_KEY, FIXTURE_FP).expect("upsert known_hosts");
    KnownHosts::verify(&vault, HOST_KEY, FIXTURE_FP).expect("verify known_hosts");

    println!(
        "seeded vault at {} (password mode) credential_id={} host_id={} ({HOST_KEY} verified)",
        dir.display(),
        cred.id,
        host.id
    );
}
