//! Task 17 四维验收·性能维：击键回显延迟复测（p95 < 50ms 红线）。
//!
//! Phase 0 的 `?spike=latency` 测量页已随 T7 单路径重构删除，本示例承接复测：
//! **走正式转发路径** [`ottr_lib::forward_pty_loop`]（4ms 合批窗 → 会话 Decoder
//! → IPC `Channel<InvokeResponseBody>::Raw` 帧回调），对容器化 sshd 夹具
//! （scripts/spike-sshd.sh，127.0.0.1:2222）开 PTY shell → `cat > /dev/null`
//! （内核 tty 逐键回显，无提示符噪声）→ 单字符乒乓：写字符 → 等回显帧到达，
//! `Instant::now()` 记「写入 → 帧回调首字节」。
//!
//! 【口径声明】相比 Phase 0 测量页（term.write 回调口径），本测量止步于 IPC
//! 帧回调——不含 webview JS 派发与 xterm.js parse/render。Phase 0 实测该前端
//! 段为亚毫秒~毫秒级（term.write 10k 行 35ms，单字符可忽略），红线 50ms 的
//! 主导项（网络 RTT + PTY + 4ms 合批 + IPC）全部在测。两口径数字在报告中
//! 分开呈现，不混判。
//!
//! 自适应预热（对齐 Phase 0 方法）：先发 50 字符预热（连接/解码冷启动），
//! 再正式采样 100 字符；单字符 500ms 超时即失败退出。
//!
//! 场景（`cargo run -p ottr --example latency_fixture`）：
//! stdout 末行输出 JSON 摘要（p50/p95/min/max/mean + 样本落盘路径）。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{forward_pty_loop, SessionCounters, TextTail};
use ottr_term::encoding::{Encoding, StreamDecoder};

use ottr_ssh::{connect, AuthMethod, HostKeyPolicy};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

const WARMUP: usize = 50;
const SAMPLES: usize = 100;
const PER_CHAR_TIMEOUT: Duration = Duration::from_millis(500);
const SAMPLES_PATH: &str = "/tmp/ottr-t17/latency-samples.json";

/// 回显帧捕获：累计字节 + 每帧到达时刻（帧粒度，乒乓等待只看累计值越界）。
#[derive(Default)]
struct Capture {
    total: usize,
    arrivals: Vec<(usize, Instant)>, // (累计字节, 到达时刻)
}

fn pinned_host_key_policy() -> HostKeyPolicy {
    use russh::keys::{parse_public_key_base64, HashAlg, PublicKey};
    let content =
        std::fs::read_to_string(KNOWN_HOSTS).unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let b64 = line.split_whitespace().nth(2).expect("malformed line");
    let pinned: PublicKey = parse_public_key_base64(b64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_fp) as HostKeyPolicy
}

async fn run() -> Result<String, String> {
    eprintln!("[latency] connect spike@127.0.0.1:2222 (host key pinned)");
    let session = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.into()),
        pinned_host_key_policy(),
    )
    .await
    .map_err(|e| format!("connect: {e}"))?;
    let mut channel = session
        .open_pty(120, 40)
        .await
        .map_err(|e| format!("open_pty: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell: {e}"))?;
    eprintln!("[latency] pty 120x40 + shell running");

    let capture = Arc::new(Mutex::new(Capture::default()));
    let capture_cb = Arc::clone(&capture);
    let on_data = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Raw(bytes) = body {
            let mut c = capture_cb.lock().unwrap();
            c.total += bytes.len();
            let total = c.total;
            c.arrivals.push((total, Instant::now()));
        }
        Ok(())
    });
    let counters = SessionCounters::default();
    let decoder = Arc::new(Mutex::new(StreamDecoder::new(Encoding::Utf8)));
    let cancel = Arc::new(Notify::new());
    let cancel_handle = Arc::clone(&cancel);
    let mut writer =
        Box::new(channel.make_writer()) as Box<dyn tokio::io::AsyncWrite + Unpin + Send>;
    let forward = tauri::async_runtime::spawn(async move {
        let text_tail = TextTail::new();
        // 录制槽位（Task 5）：夹具驱动不录制，传空槽位（同一代码路径契约）。
        let recorder_slot: ottr_lib::RecorderSlot = Arc::new(std::sync::Mutex::new(None));
        forward_pty_loop(
            &mut channel,
            &on_data,
            &counters,
            &decoder,
            &text_tail,
            &recorder_slot,
            "latency-fixture",
            &cancel_handle,
            &ottr_lib::SessionResizeSlot::default(),
        )
        .await
    });

    use tokio::io::AsyncWriteExt;

    // 起 cat（tty 回显输入；cat 本身不产生输出，提示符噪声止于首行）
    writer
        .write_all(b"cat > /dev/null\n")
        .await
        .map_err(|e| format!("write: {e}"))?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    /// 单字符乒乓：写入后等累计回显字节越过 `expect_total`，返回时延。
    async fn ping(
        writer: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
        capture: &Mutex<Capture>,
        ch: u8,
        expect_total: usize,
    ) -> Result<Duration, String> {
        let t0 = Instant::now();
        writer
            .write_all(&[ch])
            .await
            .map_err(|e| format!("write: {e}"))?;
        writer.flush().await.map_err(|e| format!("flush: {e}"))?;
        let deadline = t0 + PER_CHAR_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                return Err(format!("echo timeout for byte {ch:#x}"));
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
            if capture.lock().unwrap().total >= expect_total {
                return Ok(t0.elapsed());
            }
        }
    }

    // 自适应预热（连接/解码/调度冷启动）
    let mut expect = capture.lock().unwrap().total;
    for _ in 0..WARMUP {
        expect += 1;
        ping(writer.as_mut(), &capture, b'x', expect).await?;
    }
    eprintln!("[latency] warmup x{WARMUP} done");

    // 正式采样：可打印 ASCII（避开控制字符），乒乓间隔自然形成
    let mut latencies_ms: Vec<f64> = Vec::with_capacity(SAMPLES);
    for i in 0..SAMPLES {
        let ch = b'a' + (i % 26) as u8;
        expect += 1;
        let d = ping(writer.as_mut(), &capture, ch, expect).await?;
        latencies_ms.push(d.as_secs_f64() * 1000.0);
    }

    // 收尾：Ctrl-C 停 cat，退 shell
    let _ = writer.write_all(b"\x03").await;
    let _ = writer.write_all(b"exit\n").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.notify_one();
    let _ = forward.await;

    latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = latencies_ms.len();
    let pct = |p: f64| latencies_ms[((n - 1) as f64 * p).round() as usize];
    let mean: f64 = latencies_ms.iter().sum::<f64>() / n as f64;
    let summary = format!(
        "{{\"samples\":{n},\"p50_ms\":{:.1},\"p95_ms\":{:.1},\"min_ms\":{:.1},\"max_ms\":{:.1},\"mean_ms\":{:.1},\"threshold_p95_ms\":50,\"samples_path\":\"{SAMPLES_PATH}\"}}",
        pct(0.50),
        pct(0.95),
        latencies_ms[0],
        latencies_ms[n - 1],
        mean,
    );
    let body = format!(
        "{{\"warmup\":{WARMUP},\"p50_ms\":{:.2},\"p95_ms\":{:.2},\"min_ms\":{:.2},\"max_ms\":{:.2},\"mean_ms\":{:.2},\"all_ms\":{}}}",
        pct(0.50),
        pct(0.95),
        latencies_ms[0],
        latencies_ms[n - 1],
        mean,
        latencies_ms
            .iter()
            .map(|v| format!("{v:.2}"))
            .collect::<Vec<_>>()
            .join(","),
    );
    std::fs::create_dir_all("/tmp/ottr-t17").ok();
    std::fs::write(SAMPLES_PATH, body).map_err(|e| format!("write samples: {e}"))?;
    Ok(summary)
}

fn main() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match rt.block_on(run()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => {
            eprintln!("[latency] FAIL: {e}");
            std::process::exit(1);
        }
    }
}
