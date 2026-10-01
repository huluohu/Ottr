//! 端口转发的会话断线恢复全链路（Phase 2 Task 1 Step 3，简报裁定路径）：
//!
//! 转发 active → **stop 容器** → 会话消亡（session_down，生产接线 =
//! session.rs 收尾任务在 `ottr://session-closed` 同源路径调用）→ 转发落
//! **error** → **start 容器** → 重连（新会话，on_session_up 语义）→ enabled 且
//! auto_reconnect 的转发**自动恢复 active**、字节泵可再用。
//!
//! 夹具未启动时跳过（同 ottr-ssh forward_fixture 纪律）。docker stop/start
//! 会重启共享夹具容器——本测试单独成文件（cargo 跨测试二进制串行），避免与
//! 其他夹具测试互踩。
//!
//! Run: `cargo test -p ottr --test forward_manager_fixture`

use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ottr_ssh::forward::{ForwardKind, ForwardSpec, ForwardState};
use ottr_ssh::{AuthMethod, HostKeyPolicy, RemoteForwardRouter};
use ottr_vault::{ForwardKind as VaultKind, HostInput, PortForwardInput, PortForwards, Vault};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const CONTAINER: &str = "ottr-sshd";

/// 夹具指纹 pin（fixtures/known_hosts）。
fn pinned_host_key_policy() -> HostKeyPolicy {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let marker = format!("[{HOST}]:{PORT}");
    let base64 = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"))
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line has base64 column")
        .to_string();
    let pinned = russh::keys::parse_public_key_base64(&base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(russh::keys::HashAlg::Sha256).to_string();
    let pinned_for_cb = pinned_fp.clone();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_for_cb)
}

async fn fixture_up() -> bool {
    tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok()
}

fn docker(args: &[&str]) {
    let out = Command::new("docker")
        .args(args)
        .output()
        .expect("docker CLI");
    assert!(
        out.status.success(),
        "docker {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 等夹具端口恢复可连（docker start 后 sshd 就绪）。
async fn wait_fixture(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok() {
            // sshd 就绪窗口：TCP 能连后仍可能差半拍，再验一次稳定连通。
            tokio::time::sleep(Duration::from_millis(300)).await;
            return tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

fn local_spec() -> ForwardSpec {
    ForwardSpec {
        kind: ForwardKind::Local,
        bind_addr: "127.0.0.1".into(),
        bind_port: 0,
        target_host: Some("localhost".into()),
        target_port: Some(PORT),
    }
}

/// 建连（挂 router，-R 同款入口）。
async fn connect_session(router: &RemoteForwardRouter) -> Arc<ottr_ssh::SshSession> {
    Arc::new(
        ottr_ssh::connect_with_keepalive(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
            None,
            Some(router.clone()),
        )
        .await
        .expect("connect fixture"),
    )
}

/// 泵验证：连转发口读 sshd banner（direct-tcpip 到容器 2222，sshd 先发版本串）。
async fn pump_probe(bound: u16) -> String {
    use tokio::io::AsyncReadExt;
    let mut sock = tokio::net::TcpStream::connect((HOST, bound))
        .await
        .expect("connect forward port");
    let mut banner = vec![0u8; 32];
    let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut banner))
        .await
        .expect("banner read timeout")
        .expect("banner read");
    String::from_utf8_lossy(&banner[..n]).to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn forward_recovers_after_container_restart() {
    if !fixture_up().await {
        println!("SKIP forward_recovers_after_container_restart: fixture down");
        return;
    }

    // vault（InMemoryStorage 临时目录）：主机 + enabled 转发行。
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_with(dir.path(), &ottr_vault::master_key::InMemoryStorage::new())
        .expect("open in-memory vault");
    let host_id = ottr_vault::Hosts::create(
        &vault,
        HostInput {
            name: "fx".into(),
            group_id: None,
            tags: vec![],
            address: HOST.into(),
            port: PORT as i64,
            username: Some(USER.into()),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
        },
    )
    .unwrap()
    .id;
    let row = PortForwards::create(
        &vault,
        &PortForwardInput {
            host_id,
            kind: VaultKind::Local,
            bind_addr: "127.0.0.1".into(),
            bind_port: 0,
            target_host: Some("localhost".into()),
            target_port: Some(PORT),
            enabled: true,
            auto_reconnect: true,
        },
    )
    .unwrap();

    // --- 第一次会话：启动转发 → active → 泵可用 ---
    let manager = ottr_lib::ForwardManager::default();
    let router1 = RemoteForwardRouter::new();
    let session1 = connect_session(&router1).await;
    let run1 = manager
        .start(
            row.id,
            host_id,
            "sess-1",
            row.auto_reconnect,
            local_spec(),
            Arc::clone(&session1),
            router1,
        )
        .await;
    assert_eq!(run1.state, ForwardState::Active, "首次启动即 active");
    assert_ne!(run1.bound_port, 0);
    let banner = pump_probe(run1.bound_port).await;
    assert!(
        banner.starts_with("SSH-2.0"),
        "泵必须有 sshd banner: {banner:?}"
    );

    // --- stop 容器 → 会话消亡 → session_down → error ---
    docker(&["stop", CONTAINER]);
    // 生产等价：session.rs 收尾任务在转发循环退出后调用 session_down（此处
    // 直接驱动同一入口——断线检测本身由 Phase 1 T7 链路承担，已在库内验证）。
    let handled = manager.session_down("sess-1");
    assert_eq!(handled, 1);
    let after_down = manager.snapshot(row.id).unwrap();
    assert_eq!(
        after_down.state,
        ForwardState::Error("session closed".into()),
        "会话断开 → 转发必须落 error"
    );
    // 字节计数留痕（断线前的泵活动可见）
    assert_eq!(after_down.connections, 1);

    // --- start 容器 → 重连（on_session_up 语义）→ 自动恢复 active ---
    docker(&["start", CONTAINER]);
    assert!(
        wait_fixture(Duration::from_secs(40)).await,
        "夹具容器必须在 40s 内恢复"
    );
    let router2 = RemoteForwardRouter::new();
    let session2 = connect_session(&router2).await; // 重连成功
    let run2 = manager
        .start(
            row.id,
            host_id,
            "sess-2",
            row.auto_reconnect,
            local_spec(),
            Arc::clone(&session2),
            router2,
        )
        .await; // on_session_up 对 enabled 行的重启面
    assert_eq!(
        run2.state,
        ForwardState::Active,
        "重连后必须自动恢复 active"
    );
    // 新实例的泵重新可用
    let banner2 = pump_probe(run2.bound_port).await;
    assert!(
        banner2.starts_with("SSH-2.0"),
        "恢复后的泵可用: {banner2:?}"
    );
    let stats2 = manager.snapshot(row.id).unwrap();
    assert_eq!(stats2.state, ForwardState::Active);
    assert!(stats2.rx_bytes > 0, "恢复后的字节计数在走: {stats2:?}");

    // 收尾（测试健壮性）：取消运行、断开两个会话。
    manager.stop(row.id);
    let _ = session1.disconnect().await;
    let _ = session2.disconnect().await;
}
