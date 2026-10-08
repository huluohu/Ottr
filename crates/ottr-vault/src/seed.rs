//! 走查库播种（Phase 3 Task 7 工具的逻辑核，GUI 走查/验收共用）：
//! 向指定目录播种一个 **password-only 模式**库并写入夹具主机（127.0.0.1:2222 /
//! spike / 密码凭据 + known_hosts verified + monitor_enabled=1），供 GUI 走查
//! 绕开钥匙链 ACL 弹窗（phase1-acceptance R10 环境残留）——password 模式
//! open 即锁定、走 LockScreen 输主密码解锁，**全程零钥匙链访问**。
//!
//! 【缺陷 35（审计截图）根因修复点】known_hosts 预置记录的键**必须**经
//! [`host_endpoint_key`] 构造（连接期 TOFU 策略按同一函数组装查找键：
//! `"{address}:{port}"`，仅 IPv6 加方括号）。曾硬编码 OpenSSH 展示形态
//! `"[127.0.0.1]:2222"`（把 IPv4 当 IPv6 加括号）——连接期查不到这条
//! 「已 verify」记录，首连仍弹确认框（verified 仍弹首连确认）。

use std::path::Path;

use crate::Vault;
use crate::entities::{
    CredentialInput, CredentialKind, Credentials, HostInput, HostProtocol, Hosts, KnownHosts,
    host_endpoint_key,
};

/// 夹具（fixtures/hostkeys）当前主机指纹；spike-sshd.sh 重建夹具且保留
/// hostkeys 目录时不变。夹具换钥应走 changed 流程，本工具不追着改。
pub const FIXTURE_FINGERPRINT: &str = "SHA256:nLaxv/1hXxccQNB7JauQUi63z0YmST4P3AvViyoNCIQ";

/// 播种结果：`(credential_id, host_id)`。
pub struct SeedOutcome {
    pub credential_id: i64,
    pub host_id: i64,
}

/// 播种一个 walkthrough 库（password-only 模式，主密码由调用方给定）。
/// known_hosts 预裁定 verified=1：真夹具指纹 pin，连接不走问询（键必须与
/// 连接期查找键同构，见模块文档）。
pub fn seed_walkthrough_vault(dir: &Path, password: &str) -> Result<SeedOutcome, String> {
    // password-only open：open 即锁定（内存无密钥）；首次 unlock_with_password
    // 一次性写 salt+verifier（store.rs open_password_only 文档）。
    let vault = Vault::open_password_only(dir).map_err(|e| e.to_string())?;
    vault
        .unlock_with_password(password)
        .map_err(|e| e.to_string())?;

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
    .map_err(|e| e.to_string())?;

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
    .map_err(|e| e.to_string())?;

    // TOFU 预裁定（known_hosts verified=1）：真夹具指纹 pin，连接不走问询。
    // 键 = host_endpoint_key（连接期 TOFU 策略的同构查找键——缺陷 35 修复点）。
    let host_key = host_endpoint_key("127.0.0.1", 2222);
    KnownHosts::upsert(&vault, &host_key, FIXTURE_FINGERPRINT).map_err(|e| e.to_string())?;
    KnownHosts::verify(&vault, &host_key, FIXTURE_FINGERPRINT).map_err(|e| e.to_string())?;

    Ok(SeedOutcome {
        credential_id: cred.id,
        host_id: host.id,
    })
}
