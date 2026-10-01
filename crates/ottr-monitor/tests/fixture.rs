//! 真夹具集成（Phase 3 Task 1 Step 4）：连 ottr-sshd 容器（Debian bookworm，
//! `scripts/spike-sshd.sh`）跑 `collect` 三轮——数值合理性区间断言（简报
//! 口径：cpu 0-100、mem 总量为正）+ 差分链路（基线 → 指标）全真。
//! 夹具不可达即 fail 并提示启动命令（remote_edit_fixture 同纪律）。
//!
//! Run: `cargo test -p ottr-monitor --test fixture`

use std::sync::Arc;
use std::time::Duration;

use ottr_monitor::{Metrics, MonitorError, collect, collect_ps, kill_process};
use ottr_ssh::{AuthMethod, SshSession, connect};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");
async fn fixture_or_panic() {
    match tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            panic!("sshd fixture unreachable at {HOST}:{PORT} ({e}) —— 先跑 scripts/spike-sshd.sh")
        }
        Err(_) => panic!(
            "sshd fixture unreachable at {HOST}:{PORT} (timeout) —— 先跑 scripts/spike-sshd.sh"
        ),
    }
}

fn pinned_host_key_policy() -> ottr_ssh::HostKeyPolicy {
    use russh::keys::{HashAlg, parse_public_key_base64};
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e} —— 先跑 scripts/spike-sshd.sh"));
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

/// 三轮真实采集（200ms 间隔）：全部成功、数值落在合理区间、差分链路成立。
#[tokio::test]
async fn collect_three_rounds_values_in_sane_ranges() {
    fixture_or_panic().await;
    let session = connect_fixture().await;

    let mut prev: Option<ottr_monitor::RawSample> = None;
    let mut diffs: Vec<Metrics> = Vec::new();
    for round in 0..3 {
        let sample = tokio::time::timeout(Duration::from_secs(10), collect(&session))
            .await
            .unwrap_or_else(|_| panic!("round {round}: collect timed out"))
            .unwrap_or_else(|e| panic!("round {round}: collect failed: {e}"));
        // mem 总量为正、可用 ≤ 总量（简报口径）
        assert!(
            sample.mem.total_kb > 0,
            "round {round}: mem total must be positive"
        );
        assert!(sample.mem.available_kb <= sample.mem.total_kb);
        // 负载非负有限
        assert!(sample.load.one >= 0.0 && sample.load.one.is_finite());
        // 磁盘至少一个挂载点，占比 0-100，总量为正
        assert!(!sample.disk.is_empty(), "round {round}: df entries");
        for d in &sample.disk {
            assert!(d.total_kb > 0, "round {round}: disk total positive");
            assert!(
                (0.0..=100.0).contains(&d.used_percent),
                "round {round}: disk percent"
            );
        }
        // /proc/stat 计数器单调（活跃系统至少 total 非零）
        assert!(sample.stat.total > 0);

        if let Some(p) = &prev {
            let m = Metrics::from_diff(p, &sample, Duration::from_millis(200))
                .expect("两轮间隔 200ms 差分成立");
            assert!(
                (0.0..=100.0).contains(&m.cpu_percent),
                "round {round}: cpu {} 越界",
                m.cpu_percent
            );
            assert!((0.0..=100.0).contains(&m.mem_used_percent));
            assert!(m.net_rx_bps >= 0.0 && m.net_tx_bps >= 0.0);
            diffs.push(m);
        }
        prev = Some(sample);
        if round < 2 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    assert_eq!(diffs.len(), 2, "首轮基线 + 两轮差分");
}

/// 非 Linux 优雅降级：把复合命令喂给「无 /proc 的输出」——STAT 段空
/// → Unsupported（collect 的判定位单测在 src；此处锁 Display 契约供
/// 命令域终态事件使用）。
#[test]
fn unsupported_error_display() {
    let e = MonitorError::Unsupported {
        detail: "no /proc on remote".into(),
    };
    assert!(e.to_string().contains("no /proc on remote"));
}

// --- Phase 3 Task 2（B4 下半）：进程浏览器（ps 采集 + kill） -----------------

/// 真夹具 ps 采集：行数 > 0（简报口径）+ 行结构合理性（pid 唯一、pid=1 在册、
/// etime 可换算、占比非负）。
#[tokio::test]
async fn collect_ps_rows_over_zero_with_sane_shape() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let rows = tokio::time::timeout(Duration::from_secs(10), collect_ps(&session))
        .await
        .expect("collect_ps timed out")
        .expect("collect_ps failed");
    assert!(!rows.is_empty(), "ps 行数必须 > 0");
    let mut pids: Vec<u32> = rows.iter().map(|r| r.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    assert_eq!(pids.len(), rows.len(), "pid 唯一");
    assert!(rows.iter().any(|r| r.pid == 1), "pid 1（容器 init）必在册");
    for r in &rows {
        assert!(r.cpu_percent >= 0.0 && r.mem_percent >= 0.0);
        assert!(!r.comm.is_empty());
        assert!(
            r.etime_secs > 0 || r.etime == "00:00",
            "etime 可换算: {r:?}"
        );
    }
}

/// kill 全链路（简报口径：kill 一个后台 sleep 进程成功）：exec 起后台
/// `nohup sleep`（exec 通道关闭后存活，已在容器预验证）→ ps 在册 →
/// `kill <pid>`（SIGTERM）→ ps 消失。exit 码即真值，无需二次轮询。
#[tokio::test]
async fn kill_terminates_spawned_sleep() {
    fixture_or_panic().await;
    let session = connect_fixture().await;

    let out = session
        .exec("nohup sleep 1234 >/dev/null 2>&1 & echo $!")
        .await
        .expect("spawn sleep");
    let pid: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("spawn 输出 pid");

    let rows = collect_ps(&session).await.expect("collect_ps");
    assert!(
        rows.iter()
            .any(|r| r.pid == pid && r.comm.contains("sleep")),
        "spawn 的 sleep 必须在册: {pid}"
    );

    kill_process(&session, pid, false)
        .await
        .unwrap_or_else(|e| panic!("kill {pid} failed: {e}"));

    // SIGTERM 对 sleep 即死：确认消失（exit 137/无此进程 = 已不在）
    let check = session
        .exec(&format!("ps -p {pid} -o pid="))
        .await
        .expect("ps -p check");
    assert!(
        String::from_utf8_lossy(&check.stdout).trim().is_empty(),
        "kill 后进程必须消失: {}",
        String::from_utf8_lossy(&check.stdout)
    );
}
