//! 真机 E2E 夹具（2026-11-04 精灵球多主机隔离验收）：建「两台主机 + 一个
//! 公钥凭据 + 一个本地 mock AI provider」的配置。
//!
//! 与 [`seed_totp_credential`] 同款定位：走 vault 的**正规 API** 建凭据
//! （密文面不手写），主机行与 settings 走各自存储面。
//!
//! 产出（隔离验收用）：
//!   * 主机 `mock-A` = 127.0.0.1:2223（记录型 mock sshd，日志 /tmp/orb-A.log）
//!   * 主机 `mock-B` = 127.0.0.1:2224（记录型 mock sshd，日志 /tmp/orb-B.log）
//!   * 两者共用一个公钥凭据（仓库夹具 `fixtures/spike_ed25519`，mock 白名单同源）
//!   * AI provider 指向本地 mock AI 端点（http://127.0.0.1:18081/v1）
//!
//! 用法：
//! ```text
//! XDG_DATA_HOME=/tmp/ottr-orb-verify/data ./target/debug/examples/seed_orb_verify
//! ```

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    CredentialInput, CredentialKind, Credentials, HostInput, HostProtocol, Hosts, Secrets,
    Settings, Vault,
};

/// mock sshd 的固定账号（与 `crates/ottr-ssh/examples/mock_recording_server.rs` 同口径）。
const MOCK_USER: &str = "spike";
/// 本地 mock AI 端点（scripts/mock-ai-server.py）。
const MOCK_AI_BASE: &str = "http://127.0.0.1:18081/v1";

fn main() -> Result<(), String> {
    let data_dir =
        std::env::var("XDG_DATA_HOME").map_err(|_| "XDG_DATA_HOME not set".to_string())?;
    let vault_dir = format!("{data_dir}/com.ottr.app");

    // 无系统钥匙链的环境（测试机常无 gnome-keyring）→ vault 落主密码模式且锁着；
    // 夹具需要能解锁（真机上通常是钥匙链模式，这段是 no-op）。
    let vault =
        Vault::open_auto(std::path::Path::new(&vault_dir)).map_err(|e| format!("open: {e}"))?;
    if let Ok(pw) = std::env::var("OTTR_VAULT_PASSWORD") {
        let _ = vault.unlock_with_password(&pw);
    }

    // 公钥凭据：私钥 = 仓库夹具（mock sshd 白名单同源）。
    let key_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/spike_ed25519");
    let private_key = std::fs::read_to_string(key_path).map_err(|e| format!("read key: {e}"))?;
    let public_key = std::process::Command::new("ssh-keygen")
        .args(["-y", "-f", key_path])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .ok_or("derive public key via ssh-keygen")?;

    let cred = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Key,
            name: Some("mock-key".into()),
            secret: Some(private_key),
            key_pub: Some(public_key),
            passphrase: None,
            totp_secret: None,
            totp_digits: None,
            totp_period: None,
        },
    )
    .map_err(|e| format!("create credential: {e}"))?;

    let mut host_ids = Vec::new();
    for (name, port) in [("mock-A", 2223_i64), ("mock-B", 2224)] {
        let h = Hosts::create(
            &vault,
            HostInput {
                name: name.into(),
                group_id: None,
                tags: vec![],
                address: "127.0.0.1".into(),
                port,
                username: Some(MOCK_USER.into()),
                protocol: HostProtocol::Ssh,
                credential_id: Some(cred.id),
                jump_chain_id: None,
                encoding_override: None,
                theme_override: None,
                monitor_enabled: false,
                is_production: false,
                notes: Some("多主机隔离验收夹具".into()),
            },
        )
        .map_err(|e| format!("create host {name}: {e}"))?;
        host_ids.push((name, h.id));
    }

    // AI provider（明文面 settings）：指向本地 mock 端点。
    let providers = serde_json::json!([{
        "id": "orb-mock",
        "name": "本地 mock AI",
        "kind": "openai-compatible",
        "baseURL": MOCK_AI_BASE,
        "model": "mock-model",
        "enabled": true,
    }]);
    Settings::set(&vault, "ai_providers", &providers).map_err(|e| format!("ai_providers: {e}"))?;
    Settings::set(&vault, "ai.enabled", &serde_json::json!(true))
        .map_err(|e| format!("ai.enabled: {e}"))?;
    // mock AI 端点免 key（openai 兼容且空串不发 Authorization 头）。
    let _ = Secrets::set(&vault, "ai.apikey.orb-mock", "");

    println!("credential_id={}", cred.id);
    for (name, id) in &host_ids {
        println!("host {name} id={id}");
    }
    println!("ai_base={MOCK_AI_BASE}");
    let _ = InMemoryStorage::new(); // 保持依赖引用（本夹具不需要钥匙串读）
    Ok(())
}
