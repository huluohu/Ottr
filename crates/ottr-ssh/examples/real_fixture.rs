//! Spike #1 验收：连接 Task 2 容器化真实夹具（127.0.0.1:2222），
//! 走 password 与 publickey 两条认证路径，各跑一次远端 `whoami`。
//!
//! 主机密钥校验：从 `fixtures/known_hosts`（Task 2 产物）读取 pin 的
//! `ssh-ed25519` 公钥并比对指纹，不匹配即拒绝——不允许静默跳过校验。
//!
//! Run: `cargo run -p ottr-ssh --example real_fixture`
//! Expected: 打印两次 `spike` 与 `host key fingerprint: SHA256:…`。

use std::sync::Arc;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
use russh::ChannelMsg;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");
const CLIENT_KEY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/spike_ed25519");

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 的公钥并生成指纹 pin 策略。
fn pinned_host_key_policy() -> (HostKeyPolicy, String) {
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));

    let base64 = line
        .split_whitespace()
        .nth(2)
        .unwrap_or_else(|| panic!("malformed known_hosts line: {line}"));
    let pinned: PublicKey = parse_public_key_base64(base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();

    let pinned_fp_for_cb = pinned_fp.clone();
    let policy: HostKeyPolicy = Arc::new(move |fingerprint: &str| {
        if fingerprint == pinned_fp_for_cb {
            true
        } else {
            eprintln!("HOST KEY MISMATCH: got {fingerprint}, pinned {pinned_fp_for_cb}");
            false
        }
    });
    (policy, pinned_fp)
}

/// 打开 PTY 通道并在其上执行 `whoami`，返回去首尾空白的输出。
async fn run_whoami(session: &SshSession) -> ottr_ssh::Result<String> {
    let mut channel = session.open_pty(120, 40).await?;
    channel.exec(false, "whoami").await?;

    let mut out = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { .. } => {}
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

#[tokio::main]
async fn main() -> ottr_ssh::Result<()> {
    let (policy, pinned_fp) = pinned_host_key_policy();
    println!("pinned host key fingerprint (from known_hosts): {pinned_fp}");

    // 路径一：密码认证。
    let session = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.to_string()),
        Arc::clone(&policy),
    )
    .await?;
    let fingerprint = session
        .host_key_fingerprint()
        .expect("host key must be recorded");
    println!("host key fingerprint: {fingerprint}");
    let who = run_whoami(&session).await?;
    println!("[password auth] {USER}@{HOST}:{PORT} whoami -> {who}");
    drop(session);

    // 路径二：公钥认证（fixtures/spike_ed25519，无口令）。
    let session = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Key {
            path: CLIENT_KEY.into(),
            passphrase: None,
        },
        policy,
    )
    .await?;
    let fingerprint = session
        .host_key_fingerprint()
        .expect("host key must be recorded");
    println!("host key fingerprint: {fingerprint}");
    let who = run_whoami(&session).await?;
    println!("[key auth] {USER}@{HOST}:{PORT} whoami -> {who}");

    Ok(())
}
