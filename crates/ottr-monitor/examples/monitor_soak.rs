//! monitor_soak（Phase 3 Task 7 验收 · 稳定性维）：30min 长跑负载进程。
//!
//! 负载构成（对照 Phase 2 soak-30m 的「2 会话 SFTP + FTP 循环」，按本阶段
//! 改动面定向为资产管理三件套）：
//! * **2 会话监控采样**：两条真夹具会话各挂 [`run_sampling`] 生产参数
//!   （5s 基准 + ±10% 抖动 + 相位错开），`collect` = 真 SSH exec 复合只读
//!   命令——B4 监控主链路（采集→差分→emit）满速长跑；
//! * **1 转发**：第三条会话上真 `forward::start_forward` 起 -L 本地转发
//!   （目标 = 容器 sshd 127.0.0.1:2222），每 60s 经隧道做一次**完整 SSH
//!   握手**（`russh_impl::connect_stream` → `exec whoami` == spike）验证
//!   转发面持续可用（Phase 2 forward_fixture「L 隧道之上完整握手」的长跑化）；
//! * **1 录制**：会话 0 的 PTY shell 起周期输出循环，排空任务把每批输出
//!   tee 进 asciinema v2 事件编码（[`event_line`]）+ [`Stripper`] 剥离落盘
//!   0600——【口径】录制负载取**格式层+剥离层真代码路径**（ottr-term）；
//!   app 层 RecordingHandle 的通道/写盘线程/入库逻辑属 recording_fixture
//!   测试覆盖面，soak 不复刻（本进程无 vault 依赖，独立于 App）。
//!
//! 【RSS 口径】进程内 Rust 侧基线（russh+tokio+采样循环+编码器），不含
//! webview；RSS 由外层 `scripts/soak-p3-30m.sh` 以 `ps -o rss=` 采样。
//!
//! 结构化输出约定（外层脚本消费）：
//! * 首行 `PID=<pid>`（采样目标）；
//! * 进度行（stderr）`[soak] ...`——error 字样仅在真失败行出现，外层据此
//!   计 err_lines；
//! * 末行（stdout）`RESULT mode=monitor-soak ... errors=N`；
//! * errors=0 → exit 0，否则 exit 1（外层以退出码 + RESULT 双重判定）。
//!
//! Run: `cargo build --release -p ottr-monitor --example monitor_soak`
//!      `target/release/examples/monitor_soak [hold_secs=1800] [out_dir=/tmp/ottr-t7]`
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_monitor::{LoopConfig, SamplingEnd, collect, run_sampling};
use ottr_ssh::forward::{
    ForwardKind, ForwardSpec, ForwardStats, RemoteForwardRouter, start_forward,
};
use ottr_ssh::russh_impl::connect_stream;
use ottr_ssh::{AuthMethod, SshSession};
use ottr_term::asciinema::{CastHeader, event_line};
use ottr_term::stripper::{Stripper, TextSink};
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 剥离文本字节数累计 sink（soak 只验证剥离管线活着，不留文本本体）。
#[derive(Default)]
struct ByteCount(usize);
impl TextSink for ByteCount {
    fn text(&mut self, s: &str) {
        self.0 += s.len();
    }
}

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

async fn connect_fixture(who: &str) -> SshSession {
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
            Ok(Ok(s)) => return s,
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
                    // 每 20 次 emit 一条进度（≈100s，外层 CSV 趋势粒度）
                    if n % 20 == 0 {
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
        // hold 兜底（正常路径 cancel 先到、循环 Cancelled；此处=cancel 未及的
        // 同刻竞态——语义同为「到点收摊」，静默记 Cancelled）
        Err(_) => SamplingEnd::Cancelled,
    };
    (count.load(Ordering::Relaxed), end)
}

fn main() {
    // 第一行：pid（外层脚本采样目标）。Rust stdout 行缓冲，换行即出。
    println!("PID={}", std::process::id());
    let mut args = std::env::args().skip(1);
    let hold: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1800);
    let out_dir = PathBuf::from(args.next().unwrap_or_else(|| "/tmp/ottr-t7".into()));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    // 外层硬顶：hold + 120s（含收尾）——收尾挂死不许无限占用（硬超时纪律）。
    // 【注】timeout 的 Sleep 构造点即取 runtime 句柄——必须在 block_on 内构造，
    // 不能作为 block_on 的实参在外部求值。
    let r = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(hold + 120), run(hold, out_dir)).await
    });
    let (result, ok) = match r {
        Ok(pair) => pair,
        Err(_) => (
            "mode=monitor-soak WALL_TIMEOUT (shutdown exceeded hold+120s)".to_string(),
            false,
        ),
    };
    println!("RESULT {result}");
    std::process::exit(if ok { 0 } else { 1 });
}

async fn run(hold: u64, out_dir: PathBuf) -> (String, bool) {
    let deadline = Instant::now() + Duration::from_secs(hold);
    let mut errors = 0usize;

    // --- 会话 0/1：监控采样（会话 0 加挂 PTY 录制负载） --------------------
    let session0 = Arc::new(connect_fixture("monitor0").await);
    let session1 = Arc::new(connect_fixture("monitor1").await);
    eprintln!("[soak] monitor sessions 0/1 connected");

    // 录制文件（0600 创建即收紧；app 层 open_private_new 同语义）
    std::fs::create_dir_all(&out_dir).expect("create out dir");
    let rec_path = out_dir.join("soak-rec.cast");
    #[cfg(unix)]
    let rec_file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&rec_path)
    };
    #[cfg(not(unix))]
    let rec_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&rec_path);
    let mut rec_file = rec_file.expect("create recording file");
    writeln!(
        rec_file,
        "{}",
        CastHeader::new(120, 40, now_secs()).header_line()
    )
    .expect("write v2 header");

    // PTY + 周期输出：与 src-tauri attach 同序（open_pty → request_shell →
    // make_writer 写入），每步限时（phase0 attach 停滞教训）。
    let mut channel = tokio::time::timeout(Duration::from_secs(10), session0.open_pty(120, 40))
        .await
        .expect("open_pty timed out")
        .expect("open_pty");
    tokio::time::timeout(Duration::from_secs(10), channel.request_shell(true))
        .await
        .expect("request_shell timed out")
        .expect("request_shell");
    {
        let mut writer = channel.make_writer();
        tokio::time::timeout(
            Duration::from_secs(10),
            writer.write_all(b"exec sh -c 'while :; do echo soak-$(date +%s); sleep 10; done'\r\n"),
        )
        .await
        .expect("pty write timed out")
        .expect("pty write");
    }
    eprintln!("[soak] session0 pty shell + output loop running");

    // 排空 + tee：每批输出 → v2 事件编码（真 event_line）+ Stripper 剥离。
    let rec_started = Instant::now();
    let drain = tokio::spawn(async move {
        let mut events = 0u64;
        let mut raw_bytes = 0u64;
        let mut stripped = ByteCount::default();
        let mut stripper = Stripper::new();
        while let Some(msg) = channel.wait().await {
            if let russh::ChannelMsg::ExtendedData { data, .. } | russh::ChannelMsg::Data { data } =
                msg
            {
                let t = rec_started.elapsed().as_secs_f64();
                raw_bytes += data.len() as u64;
                stripper.feed(&data, &mut stripped);
                let text = String::from_utf8_lossy(&data);
                if writeln!(rec_file, "{}", event_line(t, &text)).is_err() {
                    eprintln!("[soak] error: recording write failed (io)");
                    break;
                }
                events += 1;
                if events % 60 == 0 {
                    eprintln!("[soak] rec events #{events} raw={raw_bytes}B");
                }
            }
        }
        let _ = rec_file.flush();
        (events, raw_bytes, stripped.0)
    });

    // --- 采样任务 ×2（真生产参数；后台 task——主流程并发跑转发探针） --------
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

    // --- 转发：真 start_forward -L + 每 60s 隧道内完整握手探针 -------------
    let fwd_session = Arc::new(connect_fixture("forward").await);
    let router = RemoteForwardRouter::new();
    let stats = ForwardStats::shared();
    let fwd_cancel = CancellationToken::new();
    let running = start_forward(
        Arc::clone(&fwd_session),
        &router,
        ForwardSpec {
            kind: ForwardKind::Local,
            bind_addr: "127.0.0.1".into(),
            bind_port: 0, // 动态分配，探针读 bound_port
            target_host: Some("127.0.0.1".into()),
            target_port: Some(PORT),
        },
        Arc::clone(&stats),
        fwd_cancel.clone(),
    )
    .await
    .unwrap_or_else(|e| panic!("start_forward: {e}"));
    let bound = running.bound_port;
    eprintln!("[soak] -L forward active on 127.0.0.1:{bound}");

    let mut probes = 0u64;
    let mut probe_errors = 0u64;
    loop {
        tokio::select! {
            _ = fwd_cancel.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
        }
        if Instant::now() >= deadline {
            break;
        }
        let attempt = tokio::time::timeout(Duration::from_secs(20), async {
            let tcp = tokio::net::TcpStream::connect((HOST, bound)).await?;
            let sess = connect_stream(
                tcp,
                USER,
                AuthMethod::Password(PASSWORD.into()),
                pinned_policy(),
            )
            .await?;
            let out = sess.exec("whoami").await?;
            sess.disconnect().await?;
            Ok::<String, ottr_ssh::Error>(String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .await;
        match attempt {
            Ok(Ok(who)) if who == USER => {
                probes += 1;
                let snap = stats.snapshot();
                eprintln!(
                    "[soak] fwd probe #{probes} ok tx={} rx={} conn={}",
                    snap.tx_bytes, snap.rx_bytes, snap.connections
                );
            }
            Ok(Ok(who)) => {
                probe_errors += 1;
                errors += 1;
                eprintln!("[soak] error: fwd probe whoami got {who:?}");
            }
            Ok(Err(e)) => {
                probe_errors += 1;
                errors += 1;
                eprintln!("[soak] error: fwd probe failed: {e}");
            }
            Err(_) => {
                probe_errors += 1;
                errors += 1;
                eprintln!("[soak] error: fwd probe timed out (20s)");
            }
        }
    }
    fwd_cancel.cancel();

    // --- 收尾：停采样 → 断会话（排空自然结束）→ 汇总 -----------------------
    cancel0.cancel();
    cancel1.cancel();
    let _ = session0.disconnect().await;
    let _ = session1.disconnect().await;
    let _ = fwd_session.disconnect().await;
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
    let (rec_events, rec_raw, rec_stripped) =
        match tokio::time::timeout(Duration::from_secs(30), drain).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                errors += 1;
                eprintln!("[soak] error: drain task panicked");
                (0, 0, 0)
            }
            Err(_) => {
                errors += 1;
                eprintln!("[soak] error: drain did not finish within 30s");
                (0, 0, 0)
            }
        };

    let result = format!(
        "mode=monitor-soak hold={hold}s samples0={samples0} samples1={samples1} rec_events={rec_events} rec_raw_bytes={rec_raw} rec_stripped_bytes={rec_stripped} fwd_probes={probes} fwd_probe_errors={probe_errors} errors={errors}"
    );
    (result, errors == 0)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
