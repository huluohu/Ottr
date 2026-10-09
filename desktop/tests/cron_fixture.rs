//! cron 定时任务真夹具集成（Phase 4 Task 1 Step 4）：**真 exec 通道 + 真
//! 分钟级调度**（同容器双连 = 两台「主机」的 batch_fixture 口径，这里只用
//! 一台 + 一台「永不连接」的离线主机），把真 exec 喂给 [`run_cron_scheduler`]：
//! * 每分钟任务 `* * * * *`（whoami）跨 2 个分钟边界 → **2 轮触发 → 2 条
//!   cron_runs 历史**（ok / exit 0 / 输出 spike / digest 一致 / ts 相邻 60s）；
//! * 离线主机任务同表 → 触发即 **missed**（如实入库，不自动连接——简报裁定
//!   #3 的真链路证据）；
//! * 「2 轮 → 通知 1 条（聚合语义）」的另一半在 TS 管线（限频 key
//!   `cron:{host}:{job}`，frontend/cron/events.test.ts 钉死）——本测试钉的是 Rust
//!   侧「每轮都发事件」的事实（事件流 2 条 + 管线聚合 1 条 = 端到端口径）。
//!
//! 宿主裁定注记：本测试直驱调度核（与生产同一 [`run_cron_scheduler`]），
//! 生产的 spawn 点（commands/cron.rs）跑在 Rust 运行时上、与 webview 解耦；
//! 「关窗到托盘照跑」的真窗实验见 task-1-report §6。
//!
//! 夹具不可达即 SKIP（batch_fixture 同纪律）。
//!
//! Run: `cargo test -p ottr --test cron_fixture`（真分钟等待 ≤150s；
//! 测试纪律 = perl alarm 外层硬超时）
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_cron::{
    BoxedCronExec, CronClock, CronExecOutput, CronExecResolver, CronJobView, CronJobsProvider,
    CronLoopConfig, CronRunRecord, CronRunSink, CronRunStatus, run_cron_scheduler,
};
use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};
use ottr_vault::cron_jobs::{CronJobInput, CronJobs, CronRunInput, CronRuns};
use ottr_vault::{HostInput, Hosts, Vault};
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
    use russh::keys::{HashAlg, parse_public_key_base64};
    let content = std::fs::read_to_string(KNOWN_HOSTS).expect("read fixtures/known_hosts");
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .expect("known_hosts has fixture entry");
    let base64 = line.split_whitespace().nth(2).expect("known_hosts shape");
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

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// 端到端主测试：真连接 + 真 `* * * * *` 两轮 + 离线 missed。
#[tokio::test(flavor = "multi_thread")]
async fn cron_every_minute_two_rounds_two_runs_and_offline_missed() {
    if !fixture_up().await {
        println!("SKIP cron_every_minute_two_rounds: fixture down —— 先跑 scripts/spike-sshd.sh");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(
        Vault::open_with(dir.path(), &ottr_vault::master_key::InMemoryStorage::new())
            .expect("open temp vault"),
    );
    // 主机两行：在线（真会话）+ 离线（仅行）
    let online_host = Hosts::create(
        &vault,
        HostInput {
            protocol: Default::default(),
            name: "fx-online".into(),
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
            is_production: false,
            notes: None,
        },
    )
    .unwrap()
    .id;
    let offline_host = Hosts::create(
        &vault,
        HostInput {
            protocol: Default::default(),
            name: "fx-offline".into(),
            group_id: None,
            tags: vec![],
            address: "10.255.255.1".into(),
            port: 22,
            username: Some("nobody".into()),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap()
    .id;

    let session = Arc::new(connect_fixture().await);
    let job_online = CronJobs::create(
        &vault,
        &CronJobInput {
            host_id: online_host,
            schedule: "* * * * *".into(),
            script: "whoami".into(),
            channels: vec![],
            enabled: true,
        },
    )
    .unwrap();
    let job_offline = CronJobs::create(
        &vault,
        &CronJobInput {
            host_id: offline_host,
            schedule: "* * * * *".into(),
            script: "whoami".into(),
            channels: vec![],
            enabled: true,
        },
    )
    .unwrap();

    // 会话表替身（生产 = SessionMap 扫 host_id；测试 = 预建映射，batch_fixture 同款）
    let mut sessions: HashMap<i64, Arc<SshSession>> = HashMap::new();
    sessions.insert(online_host, Arc::clone(&session));
    let sessions = Arc::new(sessions);

    let jobs_vault = Arc::clone(&vault);
    let jobs: CronJobsProvider = Arc::new(move || {
        CronJobs::list(&jobs_vault)
            .unwrap_or_default()
            .into_iter()
            .map(|j| CronJobView {
                id: j.id,
                host_id: j.host_id,
                schedule: j.schedule,
                enabled: j.enabled,
            })
            .collect()
    });
    let exec: CronExecResolver = {
        let sessions = Arc::clone(&sessions);
        let vault = Arc::clone(&vault);
        Arc::new(move |job: &CronJobView| {
            let session = sessions.get(&job.host_id).cloned().ok_or_else(|| {
                format!("no live session for host {} (not connected)", job.host_id)
            })?;
            let script = CronJobs::get(&vault, job.id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("job {} deleted", job.id))?
                .script;
            Ok(Box::pin(async move {
                let out = session.exec(&script).await.map_err(|e| e.to_string())?;
                Ok(CronExecOutput {
                    exit_code: out.exit_status.map(i64::from),
                    stdout: out.stdout,
                    stderr: out.stderr,
                })
            }) as BoxedCronExec)
        })
    };

    // sink = 生产收尾路径的测试复刻：cron_runs 落行（digest 随行）+ 事件计数
    static EVENTS: AtomicU64 = AtomicU64::new(0);
    let sink: CronRunSink = {
        let vault = Arc::clone(&vault);
        Arc::new(move |record: CronRunRecord| {
            EVENTS.fetch_add(1, Ordering::SeqCst);
            // core 已合并 stdout/stderr 并截断；digest 对最终文本算（commands/cron.rs 同口径）
            let digest = if record.output.is_empty() {
                None
            } else {
                use sha2::Digest;
                Some(format!(
                    "{:x}",
                    sha2::Sha256::digest(record.output.as_bytes())
                ))
            };
            CronRuns::insert(
                &vault,
                &CronRunInput {
                    cron_id: record.cron_id,
                    status: match record.status {
                        CronRunStatus::Ok => "ok",
                        CronRunStatus::Failed => "failed",
                        CronRunStatus::Timeout => "timeout",
                        CronRunStatus::Missed => "missed",
                    }
                    .into(),
                    exit_code: record.exit_code,
                    output_digest: digest,
                    output_path: None,
                    duration_ms: record.duration_ms as i64,
                    ts: record.ts,
                },
            )
            .expect("persist cron run");
        })
    };

    // 真时钟 + 10s 心跳（生产 20s；测试取短让触发延迟上界更紧）
    let clock: CronClock = Arc::new(now_secs);
    let config = CronLoopConfig {
        heartbeat: Duration::from_secs(10),
        exec_timeout: Duration::from_secs(30),
        output_cap: 64 * 1024,
        phase_seed: "cron-fixture".into(),
    };
    let started_at = now_secs();
    let handle = tokio::spawn(run_cron_scheduler(
        CancellationToken::new(),
        config,
        clock,
        jobs,
        exec,
        sink,
    ));

    // 真分钟等待：两个分钟边界 + 心跳/错峰余量（≤150s 硬上限防挂死）
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        let online_runs = CronRuns::list_for_job(&vault, job_online.id, 50)
            .unwrap()
            .len();
        let offline_runs = CronRuns::list_for_job(&vault, job_offline.id, 50)
            .unwrap()
            .len();
        if online_runs >= 2 && offline_runs >= 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "150s 内未凑齐（online={online_runs} offline={offline_runs}）——调度核或 exec 链路故障"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    handle.abort();

    // 在线任务：2 轮 → 2 条 ok 历史（输出 spike、exit 0、digest 一致、ts 相邻）
    let runs = CronRuns::list_for_job(&vault, job_online.id, 50).unwrap();
    // ≥2 = 简报「每分钟任务 2 轮 → 历史 2 条」；凑齐后的心跳窗口内多出一轮
    // （poll→abort 毫秒级缝隙撞上分界）不属故障，全量校验照样成立。
    assert!(runs.len() >= 2, "至少两轮两条历史: {}", runs.len());
    for r in &runs {
        assert_eq!(r.status, "ok");
        assert_eq!(r.exit_code, Some(0));
        let digest = r.output_digest.as_deref().expect("ok run has digest");
        let expected = {
            use sha2::Digest;
            format!("{:x}", sha2::Sha256::digest(b"spike\n"))
        };
        assert_eq!(digest, expected, "digest 对输出正文（whoami=spike 含换行）");
        assert!(r.ts >= started_at, "全部发生在测试窗口内");
    }
    let gap = (runs[0].ts - runs[1].ts).abs();
    assert!(
        (50..=70).contains(&gap),
        "最近两轮 ts 相邻一分钟: gap={gap}s"
    );

    // 离线任务：触发即 missed（如实入库）
    let offline = CronRuns::list_for_job(&vault, job_offline.id, 50).unwrap();
    assert!(!offline.is_empty(), "离线主机任务必须落 missed 历史");
    assert!(offline.iter().all(|r| r.status == "missed"));
    assert!(offline.iter().all(|r| r.exit_code.is_none()));

    // 事件流：每轮一条（Rust 侧事实；TS 管线聚合语义见 frontend/cron/events.test.ts）
    let events = EVENTS.load(Ordering::SeqCst);
    assert!(events >= 3, "事件数（online 2 + offline ≥1）= {events}");
}
