//! Spike #5 验收：打真实夹具验证两级跳板链与断点定位（B7「可视化跳板链」核心）。
//!
//! 拓扑（台账裁定：夹具自跳两次——容器内 sshd 监听 0.0.0.0，127.0.0.1:2222
//! 容器内自可达，账号/密码相同，russh 客户端由本项目实现，无需容器内有 ssh CLI）：
//!
//! ```text
//! host ──ssh── [容器:2222] ──direct-tcpip→127.0.0.1:2222 + ssh── [容器:2222]
//!        hop0           hop1 (从 hop0 视角解析)      ──direct-tcpip→ target
//! ```
//!
//! 断点定位：链 = [夹具, {127.0.0.1:2299（无服务）}]。第一跳可达，
//! direct-tcpip 在容器内连 2299 被拒 → CHANNEL_OPEN_FAILURE →
//! `HopFailed { index: 1 }`，红线：3 秒内返回，不是笼统超时。
//!
//! 主机密钥：从 `fixtures/known_hosts` pin 指纹（与 examples/real_fixture.rs 同法）。
//!
//! Run: `cargo run -p ottr-ssh --example jump_spike`
//! Expected: 两跳链上 `whoami -> spike`；断点定位 `<3s` 内报 `hop 1`。

use std::sync::Arc;
use std::time::{Duration, Instant};

use ottr_ssh::{AuthMethod, HopSpec, JumpError, SshSession, jump};
use russh::ChannelMsg;
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const DEAD_PORT: u16 = 2299; // 容器内无服务（断点定位靶子）
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 的公钥并生成指纹 pin 策略。
fn pinned_host_key_policy() -> (ottr_ssh::HostKeyPolicy, String) {
    let content =
        std::fs::read_to_string(KNOWN_HOSTS).unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
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
    let policy: ottr_ssh::HostKeyPolicy = Arc::new(move |fingerprint: &str| {
        if fingerprint == pinned_fp_for_cb {
            true
        } else {
            eprintln!("HOST KEY MISMATCH: got {fingerprint}, pinned {pinned_fp_for_cb}");
            false
        }
    });
    (policy, pinned_fp)
}

fn fixture_hop(policy: &ottr_ssh::HostKeyPolicy, port: u16) -> HopSpec {
    HopSpec {
        host: HOST.into(),
        port,
        username: USER.into(),
        auth: AuthMethod::Password(PASSWORD.into()),
        host_key: Arc::clone(policy),
    }
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

    // ---- Step 2：两级跳板（夹具自跳两次），target 上跑 whoami ----
    let started = Instant::now();
    let session = jump::connect(
        vec![fixture_hop(&policy, PORT), fixture_hop(&policy, PORT)],
        fixture_hop(&policy, PORT),
    )
    .await
    .map_err(|e| -> ottr_ssh::Error {
        // example 顶层：JumpError 经 Display 落入 Protocol 文案，保留跳序号。
        ottr_ssh::Error::Protocol {
            message: e.to_string(),
            source: Some(Box::new(e)),
        }
    })?;
    println!(
        "two-hop chain established in {:?}; final hop fingerprint: {}",
        started.elapsed(),
        session.host_key_fingerprint().expect("host key recorded"),
    );
    let who = run_whoami(&session).await?;
    println!("[jump chain: {HOST}:{PORT} -> {HOST}:{PORT} -> {HOST}:{PORT}] whoami -> {who}");
    session.disconnect().await?;

    // ---- Step 3：断点定位（第二跳指向容器内无服务的 2299）----
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        jump::connect(
            vec![fixture_hop(&policy, PORT), fixture_hop(&policy, DEAD_PORT)],
            fixture_hop(&policy, PORT),
        ),
    )
    .await;
    let elapsed = started.elapsed();

    match result {
        Err(_) => panic!("breakpoint detection exceeded the 3s red line ({elapsed:?})"),
        Ok(Ok(_)) => panic!("chain through dead port {DEAD_PORT} must not succeed"),
        Ok(Err(err @ JumpError::HopFailed { index, .. })) => {
            println!("breakpoint located: hop {index} failed in {elapsed:?} (budget 3s): {err}");
            if index != 1 {
                panic!("expected HopFailed at index 1, got {index}");
            }
            if elapsed >= Duration::from_secs(3) {
                panic!("breakpoint detection took {elapsed:?}, exceeding the 3s red line");
            }
        }
    }

    println!("ok: two-hop chain works, breakpoint located within budget");
    Ok(())
}
