//! p4_soak（Phase 4 Task 7 验收 · 稳定性维）：30min 长跑负载进程。
//!
//! 负载构成（对照 Phase 3 monitor_soak 的「采样+转发+录制」，按本阶段改动面
//! 定向为 **cron 调度 + 监控采样并存**——T1 关窗真窗实验的长跑化）：
//! * **2 会话监控采样**：两条真夹具会话各挂 [`run_sampling`] 生产参数
//!   （5s 基准 + ±10% 抖动 + 相位错开），`collect` = 真 SSH exec 复合只读
//!   命令——与 cron 共享同一进程/同一连接面，验证并存无互扰；
//! * **1 cron 调度器**：[`run_cron_scheduler`] 生产参数（20s 心跳+错峰），
//!   双任务 `* * * * *`：
//!   - job 1（host 1，会话在册）→ 每分钟真 exec `echo p4-cron-ok` → **ok 轮**
//!     （真 exec 成功链路长跑化，补 T1 实验「只走 missed 链路」的边界）；
//!   - job 2（host 99，永无会话）→ 每分钟 **missed 轮**（不自动连接裁定面）。
//!   调度核直驱（不经 src-tauri 装配层，装配点由 cron_fixture 覆盖）。
//!
//! 【RSS 口径】进程内 Rust 侧基线（russh+tokio+采样循环+cron 调度核），不含
//! webview；RSS 由外层 `scripts/soak-p4-30m.sh` 以 `ps -o rss=` 采样。
//!
//! 结构化输出约定（外层脚本消费，monitor_soak 同款）：
//! * 首行 `PID=<pid>`（采样目标）；
//! * 进度行（stderr）`[soak] ...`——error 字样仅在真失败行出现，外层据此
//!   计 err_lines；
//! * 末行（stdout）`RESULT mode=p4-soak ... errors=N`；
//! * errors=0 → exit 0，否则 exit 1（外层以退出码 + RESULT 双重判定）。
//!
//! Run: `cargo build --release -p ottr-monitor --example p4_soak`
//!      `target/release/examples/p4_soak [hold_secs=1800] [out_dir=/tmp/p4-t7]`
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_monitor::cron::{
    BoxedCronExec, CronExecOutput, CronExecResolver, CronJobView, CronLoopConfig, CronRunRecord,
    CronRunStatus, run_cron_scheduler,
};
use ottr_monitor::{LoopConfig, SamplingEnd, collect, run_sampling};
use ottr_ssh::{AuthMethod, SshSession};
use tokio_util::sync::CancellationToken;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

fn pinned_policy() -> ottr_ssh::HostKeyPolicy {
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

async fn connect_fixture(who: &str) -> Arc<SshSession> {
    let mut last = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        match tokio::time::timeout(
            Duration::from_secs(15),
            ottr_ssh::connect(
                HOST,
                PORT,
                USER,
                AuthMethod::Password(PASSWORD.into()),
                pinned_policy(),
            ),
        )
        .await
        {
            Ok(Ok(s)) => return Arc::new(s),
            Ok(Err(e)) => last = Some(e.to_string()),
            Err(_) => last = Some("connect timed out (15s)".into()),
        }
    }
    panic!(
        "connect fixture for {who} (3 attempts): {}",
        last.expect("at least one attempt")
    );
}

/// 监控采样 worker：真 collect 生产循环（hold 即限时），返回 (emit 数, 终态)。
async fn sampling_worker(
    tag: &'static str,
    session: Arc<SshSession>,
    cancel: CancellationToken,
    deadline: Instant,
) -> (u64, SamplingEnd) {
    let count = Arc::new(AtomicU64::new(0));
    let c = Arc::clone(&count);
    let end = tokio::time::timeout_at(
        tokio::time::Instant::from_std(deadline),
        run_sampling(
            tag,
            LoopConfig::production(Duration::from_secs(5)),
            cancel,
            move || {
                let s = Arc::clone(&session);
                async move { collect(&s).await }
            },
            move |m| {
                let c = Arc::clone(&c);
                async move {
                    let n = c.fetch_add(1, Ordering::Relaxed) + 1;
                    // 每 60 次 emit 一条进度（≈300s，外层 CSV 趋势粒度）
                    if n % 60 == 0 {
                        eprintln!(
                            "[soak] {tag} sample #{n} cpu={:.1}% mem={:.1}%",
                            m.cpu_percent, m.mem_used_percent
                        );
                    }
                }
            },
        ),
    )
    .await;
    let end = match end {
        Ok(end) => end,
        // hold 兜底（monitor_soak 同款：cancel 未及的同刻竞态，语义同为到点收摊）
        Err(_) => SamplingEnd::Cancelled,
    };
    (count.load(Ordering::Relaxed), end)
}

fn main() {
    // 第一行：pid（外层脚本采样目标）。Rust stdout 行缓冲，换行即出。
    println!("PID={}", std::process::id());
    let mut args = std::env::args().skip(1);
    let hold: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1800);
    let _out_dir = PathBuf::from(args.next().unwrap_or_else(|| "/tmp/p4-t7".into()));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // 外层硬顶：hold + 120s（含收尾）——收尾挂死不许无限占用（硬超时纪律）。
    // 【注】timeout 的 Sleep 构造点即取 runtime 句柄——必须在 block_on 内构造，
    // 不能作为 block_on 的实参在外部求值。
    let r = runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(hold + 120), run(hold)).await });
    let (result, ok) = match r {
        Ok(pair) => pair,
        Err(_) => (
            "mode=p4-soak WALL_TIMEOUT (shutdown exceeded hold+120s)".to_string(),
            false,
        ),
    };
    println!("RESULT {result}");
    std::process::exit(if ok { 0 } else { 1 });
}

async fn run(hold: u64) -> (String, bool) {
    let deadline = Instant::now() + Duration::from_secs(hold);
    let mut errors = 0usize;

    // --- 会话 0/1：监控采样（与 cron 调度同进程并存） -----------------------
    let session0 = connect_fixture("monitor0").await;
    let session1 = connect_fixture("monitor1").await;
    eprintln!("[soak] monitor sessions 0/1 connected");

    let cancel0 = CancellationToken::new();
    let cancel1 = CancellationToken::new();
    let t0 = tokio::spawn(sampling_worker(
        "soak-s0",
        Arc::clone(&session0),
        cancel0.clone(),
        deadline,
    ));
    let t1 = tokio::spawn(sampling_worker(
        "soak-s1",
        Arc::clone(&session1),
        cancel1.clone(),
        deadline,
    ));

    // --- cron 调度器：双任务 * * * * *（ok 链路 + missed 链路） -------------
    // job 1 → host 1（会话 0 在册，真 exec）；job 2 → host 99（永无会话 → missed）。
    let cron_ok = Arc::new(AtomicU64::new(0));
    let cron_missed = Arc::new(AtomicU64::new(0));
    let cron_other = Arc::new(AtomicU64::new(0));
    let sessions = vec![Arc::clone(&session0)];
    let exec: CronExecResolver = Arc::new(move |job: &CronJobView| {
        // host 1 = 会话 0（生产 = session_for_host 在册表；此处按 host_id 映射）
        let session = match job.host_id {
            1 => Some(Arc::clone(&sessions[0])),
            _ => None, // host 99 无在册会话 → Err = missed（不自动连接）
        };
        let Some(session) = session else {
            return Err(format!("no live session for host {}", job.host_id));
        };
        let fut: BoxedCronExec = Box::pin(async move {
            let out = session
                .exec("echo p4-cron-ok")
                .await
                .map_err(|e| e.to_string())?;
            Ok(CronExecOutput {
                exit_code: out.exit_status.map(i64::from),
                stdout: out.stdout,
                stderr: out.stderr,
            })
        });
        Ok(fut)
    });
    let sink_ok = Arc::clone(&cron_ok);
    let sink_missed = Arc::clone(&cron_missed);
    let sink_other = Arc::clone(&cron_other);
    let on_run: ottr_monitor::cron::CronRunSink =
        Arc::new(move |record: CronRunRecord| match record.status {
            CronRunStatus::Ok => {
                let n = sink_ok.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!(
                    "[soak] cron ok #{n} (cron_id={} ts={})",
                    record.cron_id, record.ts
                );
            }
            CronRunStatus::Missed => {
                let n = sink_missed.fetch_add(1, Ordering::Relaxed) + 1;
                eprintln!(
                    "[soak] cron missed #{n} (cron_id={} ts={})",
                    record.cron_id, record.ts
                );
            }
            other => {
                sink_other.fetch_add(1, Ordering::Relaxed);
                eprintln!("[soak] error: cron job {} ended {other:?}", record.cron_id);
            }
        });
    let cron_cancel = CancellationToken::new();
    let cron_task = tokio::spawn(run_cron_scheduler(
        cron_cancel.clone(),
        CronLoopConfig::production(),
        Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64
        }),
        Arc::new(move || {
            vec![
                CronJobView {
                    id: 1,
                    host_id: 1,
                    schedule: "* * * * *".into(),
                    enabled: true,
                },
                CronJobView {
                    id: 2,
                    host_id: 99,
                    schedule: "* * * * *".into(),
                    enabled: true,
                },
            ]
        }),
        exec,
        on_run,
    ));

    // --- hold 到点：停调度 → 停采样 → 断会话 → 汇总 -------------------------
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    cron_cancel.cancel();
    cancel0.cancel();
    cancel1.cancel();
    let _ = session0.disconnect().await;
    let _ = session1.disconnect().await;

    let cron_end = tokio::time::timeout(Duration::from_secs(30), cron_task).await;
    match cron_end {
        // CronLoopEnd 现只有 Cancelled 一路（错误不终结循环——单任务失败不拖垮调度器）
        Ok(Ok(ottr_monitor::cron::CronLoopEnd::Cancelled)) => {}
        Ok(Err(_)) => {
            errors += 1;
            eprintln!("[soak] error: cron task panicked");
        }
        Err(_) => {
            errors += 1;
            eprintln!("[soak] error: cron loop join timed out");
        }
    }

    let (samples0, end0) = tokio::time::timeout(Duration::from_secs(30), t0)
        .await
        .unwrap_or_else(|_| {
            errors += 1;
            eprintln!("[soak] error: sampling s0 join timed out");
            Ok((0, SamplingEnd::Cancelled))
        })
        .unwrap_or_else(|_| {
            errors += 1;
            eprintln!("[soak] error: sampling s0 panicked");
            (0, SamplingEnd::Cancelled)
        });
    let (samples1, end1) = tokio::time::timeout(Duration::from_secs(30), t1)
        .await
        .unwrap_or_else(|_| {
            errors += 1;
            eprintln!("[soak] error: sampling s1 join timed out");
            Ok((0, SamplingEnd::Cancelled))
        })
        .unwrap_or_else(|_| {
            errors += 1;
            eprintln!("[soak] error: sampling s1 panicked");
            (0, SamplingEnd::Cancelled)
        });
    for (tag, end) in [("s0", end0), ("s1", end1)] {
        match end {
            SamplingEnd::Cancelled => {}
            other => {
                errors += 1;
                eprintln!("[soak] error: sampling {tag} ended {other:?}");
            }
        }
    }
    let ok_n = cron_ok.load(Ordering::Relaxed);
    let missed_n = cron_missed.load(Ordering::Relaxed);
    let other_n = cron_other.load(Ordering::Relaxed);
    errors += other_n as usize;

    let result = format!(
        "mode=p4-soak hold={hold}s samples0={samples0} samples1={samples1} cron_ok={ok_n} cron_missed={missed_n} cron_other={other_n} errors={errors}"
    );
    (result, errors == 0)
}
