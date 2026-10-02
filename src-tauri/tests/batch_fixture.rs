//! 批量执行真夹具集成（Phase 3 Task 4 Step 3）：**同容器双连 = 两台主机**
//! （裁定口径——ottr-sshd 允许任意多并发 SSH 连接，两台 SshSession 即两主机，
//! 免第二容器），把真 exec 通道喂给 [`run_batch`] 并发池：
//! * 双主机 `whoami` → 两台 ok、输出同文（= 前端「多数派折叠」的全同组）；
//! * `echo $((41+1))` / `echo $((41+2))` → 42 / 43 两样输出（= 前端差异高亮
//!   场景的真数据面；diff 计算本身在前端纯函数，见 src/batch/diff.test.ts）；
//! * `sleep 5` + 1s 超时 → timeout 结算（真实远端慢命令被单主机超时截断）。
//!
//! 夹具不可达即 SKIP 并提示启动命令（forward_manager_fixture 同纪律；
//! monitor/tests/fixture.rs 用 panic 口径——此处选 SKIP 以免阻塞全仓回归）。
//!
//! Run: `cargo test -p ottr --test batch_fixture`
use std::sync::Arc;
use std::time::Duration;

use ottr_lib::{run_batch, BatchResultEvent, BatchStatus, BatchTargetInput, ExecResolver};
use ottr_ssh::{connect, AuthMethod, HostKeyPolicy, SshSession};
use tokio_util::sync::CancellationToken;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

async fn fixture_up() -> bool {
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

fn pinned_host_key_policy() -> HostKeyPolicy {
    use russh::keys::{parse_public_key_base64, HashAlg};
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .expect("read fixtures/known_hosts —— 先跑 scripts/spike-sshd.sh");
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let base64 = line
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line shape");
    let pinned = parse_public_key_base64(base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_fp)
}

async fn connect_fixture() -> SshSession {
    let mut last = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        match connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        )
        .await
        {
            Ok(s) => return s,
            Err(e) => last = Some(e),
        }
    }
    panic!(
        "connect fixture (3 attempts): {}",
        last.expect("at least one attempt")
    );
}

/// 两台「主机」的 resolver：session_id → 各自的真实连接（生产 session_resolver
/// 的测试替身——会话表查 Arc 换成了预建 Arc 映射，池语义与命令域完全一致）。
fn two_host_resolver(a: Arc<SshSession>, b: Arc<SshSession>) -> ExecResolver {
    Arc::new(move |t: &BatchTargetInput| {
        let session = match t.session_id.as_str() {
            "s1" => Arc::clone(&a),
            "s2" => Arc::clone(&b),
            other => return Err(format!("no live session: {other}")),
        };
        let cmd = t.command.clone();
        Ok(Box::pin(async move {
            session.exec(&cmd).await.map_err(|e| e.to_string())
        }))
    })
}

fn sink_ignore() -> Arc<dyn Fn(BatchResultEvent) + Send + Sync> {
    Arc::new(|_| {})
}

fn target(host_id: i64, name: &str, session_id: &str, command: &str) -> BatchTargetInput {
    BatchTargetInput {
        host_id,
        name: name.to_string(),
        session_id: session_id.to_string(),
        command: command.to_string(),
    }
}

fn stdout_of(e: &BatchResultEvent) -> String {
    e.stdout.trim().to_string()
}

/// 双主机 whoami：两台 ok、同输出（spike 用户）；并发 2 真实并行。
#[tokio::test(flavor = "multi_thread")]
async fn batch_whoami_two_hosts_both_ok() {
    if !fixture_up().await {
        println!("SKIP batch_whoami_two_hosts_both_ok: fixture down —— 先跑 scripts/spike-sshd.sh");
        return;
    }
    let s1 = Arc::new(connect_fixture().await);
    let s2 = Arc::new(connect_fixture().await);
    let results = run_batch(
        "batch-fx-1".into(),
        vec![
            target(1, "fx-a", "s1", "whoami"),
            target(2, "fx-b", "s2", "whoami"),
        ],
        two_host_resolver(s1, s2),
        2,
        Duration::from_secs(10),
        CancellationToken::new(),
        sink_ignore(),
    )
    .await;
    assert_eq!(results.len(), 2, "两台各一条结果");
    for r in &results {
        assert_eq!(r.status, BatchStatus::Ok, "{:?}: {:?}", r.name, r.error);
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(stdout_of(r), "spike", "两台同用户 = 输出全同（多数派组）");
    }
}

/// 差异场景真数据面：同一模板语义、每主机命令变体 → 42 / 43 两样输出
/// （前端 diffOutputs 对这两条结果应判「与多数派不同」各 1 台）。
#[tokio::test(flavor = "multi_thread")]
async fn batch_arithmetic_outputs_diverge_42_vs_43() {
    if !fixture_up().await {
        println!(
            "SKIP batch_arithmetic_outputs_diverge_42_vs_43: fixture down —— 先跑 scripts/spike-sshd.sh"
        );
        return;
    }
    let s1 = Arc::new(connect_fixture().await);
    let s2 = Arc::new(connect_fixture().await);
    let results = run_batch(
        "batch-fx-2".into(),
        vec![
            target(1, "fx-a", "s1", "echo $((41+1))"),
            target(2, "fx-b", "s2", "echo $((41+2))"),
        ],
        two_host_resolver(s1, s2),
        2,
        Duration::from_secs(10),
        CancellationToken::new(),
        sink_ignore(),
    )
    .await;
    let outs: Vec<String> = results.iter().map(stdout_of).collect();
    assert!(outs.contains(&"42".to_string()), "实际输出: {outs:?}");
    assert!(outs.contains(&"43".to_string()), "实际输出: {outs:?}");
    assert_ne!(outs[0], outs[1], "两台输出必须不同（差异高亮数据面）");
    assert!(results.iter().all(|r| r.status == BatchStatus::Ok));
}

/// 单主机超时：远端 `sleep 5`，池超时 1s → timeout 结算，另一台不受牵连。
#[tokio::test(flavor = "multi_thread")]
async fn batch_timeout_one_host_does_not_block_other() {
    if !fixture_up().await {
        println!(
            "SKIP batch_timeout_one_host_does_not_block_other: fixture down —— 先跑 scripts/spike-sshd.sh"
        );
        return;
    }
    let s1 = Arc::new(connect_fixture().await);
    let s2 = Arc::new(connect_fixture().await);
    let started = std::time::Instant::now();
    let results = run_batch(
        "batch-fx-3".into(),
        vec![
            target(1, "slow", "s1", "sleep 5"),
            target(2, "fast", "s2", "echo quick"),
        ],
        two_host_resolver(s1, s2),
        2,
        Duration::from_secs(1),
        CancellationToken::new(),
        sink_ignore(),
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "超时必须截断等待: {:?}",
        started.elapsed()
    );
    let slow = results
        .iter()
        .find(|r| r.host_id == 1)
        .expect("slow result");
    let fast = results
        .iter()
        .find(|r| r.host_id == 2)
        .expect("fast result");
    assert_eq!(slow.status, BatchStatus::Timeout);
    assert_eq!(fast.status, BatchStatus::Ok);
    assert_eq!(stdout_of(fast), "quick");
}
