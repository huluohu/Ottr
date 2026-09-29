// Spike #2（Task 4）：PTY 双向流 + 二进制 IPC 通道定案 + 击键延迟测量。
//
// 数据面（输出方向，PTY → 前端）：
//   russh channel 读循环 → 合批器（4ms 或 64KB 先到者，实验定值见下）→
//   `Channel<InvokeResponseBody>` + `InvokeResponseBody::Raw(bytes)` —— 二进制帧，
//   前端收到 `ArrayBuffer`（见 docs/phase0-report.md 定案）。禁 JSON/base64，永不丢弃字节。
// 输入方向（击键 → PTY）：`write_session(id, bytes)`，spike 台账裁定允许 JSON 数组。
//
// Task 7 预埋：Rust 侧转发计数（forwarded_bytes/frames/input_bytes/writes/pty_read_bytes），
// 经 `session_stats` 命令可读；`OTTR_BATCH_DEBUG=1` 时逐批打 debug 日志。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use russh::ChannelMsg;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession};

// ---------------------------------------------------------------------------
// 合批器参数（Task 7 复用同一语义）
// ---------------------------------------------------------------------------

/// 合批窗口：首字节到达后最多等这么久（有字节即写、窗口为最长等待）。
/// 默认 4ms —— spike 实验（2026-09-29，100 字符 @20ms，详见 docs/phase0-report.md）：
/// 16ms 时 p50=40/p95=106ms（不达标）；4ms 时 p50=8/p95=12ms；0ms（到即写）
/// p50=5/p95=13ms 但完全失去合并能力。4ms 以可忽略的延迟税保留突发合并。
/// 可用 `OTTR_BATCH_WINDOW_MS` 覆盖（Task 7 调优沿用同一旋钮）。
const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// 合批上限：窗口内攒到 64KB 立即 flush，不等窗口到期。
const BATCH_LIMIT: usize = 64 * 1024;

/// 运行时生效窗口（`OTTR_BATCH_WINDOW_MS` 覆盖；0 = 每条消息到即 flush）。
fn batch_window() -> Duration {
    std::env::var("OTTR_BATCH_WINDOW_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(BATCH_WINDOW)
}

// ---------------------------------------------------------------------------
// 主机指纹 pin（来自 fixtures/known_hosts，spike 不允许静默跳过校验）
// ---------------------------------------------------------------------------

/// 写入时的夹具指纹常量；运行时优先从仓库夹具文件重新解析（防夹具重生成后漂移）。
const PINNED_FP_FALLBACK: &str = "SHA256:nLaxv/1hXxccQNB7JauQUi63z0YmST4P3AvViyoNCIQ";

/// known_hosts 首条记录 → `SHA256:<unpadded-std-b64(sha256(key_blob))>` 指纹。
fn known_hosts_fingerprint(content: &str) -> Option<String> {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let b64 = match (parts.next(), parts.next(), parts.next()) {
            (Some(_host), Some(_ktype), Some(b64)) if parts.next().is_none() => b64,
            _ => continue,
        };
        if let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(b64) {
            use base64::engine::general_purpose::STANDARD as B64;
            use sha2::Digest;
            let digest = sha2::Sha256::digest(&blob);
            return Some(format!(
                "SHA256:{}",
                B64.encode(digest).trim_end_matches('=')
            ));
        }
    }
    None
}

/// spike 主机密钥策略：指纹必须精确等于 pin 值，其余一律拒绝。
fn pinned_host_key_policy() -> (HostKeyPolicy, String) {
    let expected = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .ok()
    .and_then(|c| known_hosts_fingerprint(&c))
    .unwrap_or_else(|| PINNED_FP_FALLBACK.to_string());
    let expected_for_cb = expected.clone();
    let policy: HostKeyPolicy = Arc::new(move |fingerprint: &str| fingerprint == expected_for_cb);
    (policy, expected)
}

// ---------------------------------------------------------------------------
// 会话表与计数器（Task 7 字节计数预埋）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SessionCounters {
    /// PTY 原始读出字节（合批前）。
    pty_read_bytes: AtomicU64,
    /// 合批后向前端转发的字节（= 各 Raw 帧长度之和）。
    forwarded_bytes: AtomicU64,
    /// 向前端发送的帧数（合批次数）。
    frames: AtomicU64,
    /// 前端写向 PTY 的字节（击键级）。
    input_bytes: AtomicU64,
    /// write_session 调用次数。
    writes: AtomicU64,
}

struct SessionEntry {
    /// PTY 写端（russh `make_writer()`，与读循环共享同一通道）。
    writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>,
    counters: Arc<SessionCounters>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize)]
struct SessionStats {
    pty_read_bytes: u64,
    forwarded_bytes: u64,
    frames: u64,
    input_bytes: u64,
    writes: u64,
}

fn snapshot(counters: &SessionCounters) -> SessionStats {
    SessionStats {
        pty_read_bytes: counters.pty_read_bytes.load(Ordering::Relaxed),
        forwarded_bytes: counters.forwarded_bytes.load(Ordering::Relaxed),
        frames: counters.frames.load(Ordering::Relaxed),
        input_bytes: counters.input_bytes.load(Ordering::Relaxed),
        writes: counters.writes.load(Ordering::Relaxed),
    }
}

// ---------------------------------------------------------------------------
// 命令：attach / write / stats / spike
// ---------------------------------------------------------------------------

/// 连接夹具（密码认证 + 指纹 pin）、开 PTY、起 shell，并启动合批转发循环。
/// 返回会话 id；PTY 输出经 `on_data`（二进制 Raw 帧）推给前端。
#[tauri::command]
async fn attach_session(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let (policy, pinned) = pinned_host_key_policy();
    // spike 观测：attach 偶发整体停滞（1/5 频率），故每步限时并打点定位。
    // 连接类操作不该无限等待——正式版同样需要这些超时（Task 5+ 沿用）。
    let session: SshSession = tokio::time::timeout(
        Duration::from_secs(15),
        ottr_ssh::connect(&host, port, &username, AuthMethod::Password(password), policy),
    )
    .await
    .map_err(|_| format!("connect timed out after 15s (pinned {pinned})"))?
    .map_err(|e| format!("connect failed (pinned {pinned}): {e}"))?;
    eprintln!("[attach] connected {username}@{host}:{port}");

    let mut channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(cols, rows))
        .await
        .map_err(|_| "open_pty timed out after 10s".to_string())?
        .map_err(|e| format!("open_pty failed: {e}"))?;
    eprintln!("[attach] pty open ({cols}x{rows})");
    tokio::time::timeout(Duration::from_secs(10), channel.request_shell(true))
        .await
        .map_err(|_| "request_shell timed out after 10s".to_string())?
        .map_err(|e| format!("request_shell failed: {e}"))?;
    eprintln!("[attach] shell running");

    let id = format!("pty-{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
    let counters = Arc::new(SessionCounters::default());
    let writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(channel.make_writer())));
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), SessionEntry {
            writer,
            counters: Arc::clone(&counters),
        });

    // 读循环持有 channel 与 session（session 保活 = 连接保活）。
    let session_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let _keepalive = session;
        forward_pty_loop(&mut channel, &on_data, &counters, &session_id).await;
    });
    Ok(id)
}

/// 击键写入（输入方向，字节直传 PTY；spike 台账：传输编码允许 JSON 数组）。
#[tauri::command]
async fn write_session(
    state: State<'_, AppState>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let (writer, counters) = {
        let sessions = state.sessions.lock().unwrap();
        let entry = sessions
            .get(&id)
            .ok_or_else(|| format!("no such session: {id}"))?;
        (Arc::clone(&entry.writer), Arc::clone(&entry.counters))
    };
    let n = bytes.len();
    writer
        .lock()
        .await
        .write_all(&bytes)
        .await
        .map_err(|e| format!("pty write failed: {e}"))?;
    counters.input_bytes.fetch_add(n as u64, Ordering::Relaxed);
    counters.writes.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Task 7 字节计数读数（Rust 侧转发计数）。
#[tauri::command]
fn session_stats(state: State<'_, AppState>, id: String) -> Result<SessionStats, String> {
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(&id)
        .map(|e| snapshot(&e.counters))
        .ok_or_else(|| format!("no such session: {id}"))
}

/// 延迟测量取数通道：前端测完 POST JSON，这里合并 Rust 侧计数后落盘。
/// 路径可用 `OTTR_SPIKE_REPORT` 覆盖，默认 /tmp/ottr-latency.json（驱动脚本轮询此文件）。
#[tauri::command]
fn spike_report_latency(state: State<'_, AppState>, payload: String) -> Result<String, String> {
    let mut report: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("bad report json: {e}"))?;
    let sessions = state.sessions.lock().unwrap();
    let rust_side: serde_json::Map<String, serde_json::Value> = sessions
        .iter()
        .map(|(id, e)| {
            let stats = snapshot(&e.counters);
            (
                id.clone(),
                serde_json::to_value(&stats).unwrap_or_default(),
            )
        })
        .collect();
    report["rust"] = serde_json::json!({
        "batch_window_ms": batch_window().as_millis() as u64,
        "batch_limit_bytes": BATCH_LIMIT,
        "sessions": rust_side,
    });

    let path = std::env::var("OTTR_SPIKE_REPORT").unwrap_or_else(|_| "/tmp/ottr-latency.json".into());
    std::fs::write(&path, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {path}: {e}"))?;
    Ok(path)
}

/// 自动化排障：前端关键阶段打点 → dev log（页面侧无 stdout，这条是唯一可观测通道）。
#[tauri::command]
fn spike_log(msg: String) {
    eprintln!("[spike-page] {msg}");
}

/// 二进制通道定案探针：同一 `Channel<InvokeResponseBody>` 上发三种帧，
/// 前端记录 `typeof`/长度做对账——
/// 1) `Raw`(16B)：走 eval 直执行路径（<1024B 阈值）；
/// 2) `Raw`(2048B)：走 fetch 二进制路径（octet-stream）；
/// 3) `Json`(base64 字符串)：对照组——若走 JSON 字符串方案前端会收到什么。
#[tauri::command]
async fn spike_probe_channel(on_probe: Channel<InvokeResponseBody>) -> Result<(), String> {
    let small: Vec<u8> = (0u8..16).collect();
    let big: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&small);

    on_probe
        .send(InvokeResponseBody::Raw(small))
        .map_err(|e| e.to_string())?;
    on_probe
        .send(InvokeResponseBody::Raw(big))
        .map_err(|e| e.to_string())?;
    on_probe
        .send(InvokeResponseBody::Json(serde_json::to_string(&b64).unwrap()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 合批转发循环：有字节即写、窗口（默认 4ms）为最长等待；64KB 先到者立即 flush。
// ---------------------------------------------------------------------------

async fn forward_pty_loop(
    channel: &mut russh::Channel<russh::client::Msg>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    session_id: &str,
) {
    // russh 类型在此泄漏为 spike-pragmatic（见 ottr-ssh SshTransport 文档：
    // Channel 是 trait 边界上唯一泄漏点，正式版由包装类型消除）。
    let mut buf: Vec<u8> = Vec::with_capacity(BATCH_LIMIT);
    let mut deadline: Option<Instant> = None;

    loop {
        let msg = match deadline {
            Some(d) => {
                let remaining = d.saturating_duration_since(Instant::now());
                match tokio::time::timeout(remaining, channel.wait()).await {
                    Err(_elapsed) => {
                        flush_batch(&mut buf, &mut deadline, on_data, counters, session_id).await;
                        continue;
                    }
                    Ok(m) => m,
                }
            }
            None => channel.wait().await,
        };

        match msg {
        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
            counters.pty_read_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
            if buf.is_empty() {
                deadline = Some(Instant::now() + batch_window());
            }
                buf.extend_from_slice(&data);
                if buf.len() >= BATCH_LIMIT {
                    flush_batch(&mut buf, &mut deadline, on_data, counters, session_id).await;
                }
            }
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) => {
                flush_batch(&mut buf, &mut deadline, on_data, counters, session_id).await;
            }
            Some(ChannelMsg::Close) | None => {
                flush_batch(&mut buf, &mut deadline, on_data, counters, session_id).await;
                eprintln!("[batcher:{session_id}] pty closed");
                break;
            }
            _ => {}
        }
    }
}

async fn flush_batch(
    buf: &mut Vec<u8>,
    deadline: &mut Option<Instant>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    session_id: &str,
) {
    *deadline = None;
    if buf.is_empty() {
        return;
    }
    let n = buf.len();
    let payload = std::mem::replace(buf, Vec::with_capacity(BATCH_LIMIT));
    match on_data.send(InvokeResponseBody::Raw(payload)) {
        Ok(()) => {
            counters.forwarded_bytes.fetch_add(n as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            if std::env::var_os("OTTR_BATCH_DEBUG").is_some() {
                eprintln!("[batcher:{session_id}] flush {n} bytes");
            }
        }
        Err(e) => eprintln!("[batcher:{session_id}] send failed ({n} bytes dropped by ipc): {e}"),
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // 自动化驱动入口：OTTR_SPIKE=latency 时把页面导航到 ?spike=latency，
            // 前端据此自动打字测量并回传报告（scripts/spike-latency.sh）。
            // eval 可能在页面首次加载 commit 前被 webview 丢弃，故带守卫重试：
            // 导航成功后表达式变成 no-op，重复 eval 无害。
            // 窗口置顶 + 抢焦点：后台/遮挡窗口会被 WebKit 节流计时器，
            // 曾导致测量页整场停滞（240s 无报告）。
            if std::env::var("OTTR_SPIKE").as_deref() == Ok("latency") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_focus();
                    tauri::async_runtime::spawn(async move {
                        for i in 0..480 {
                            let ok = win
                                .eval(
                                    "if(!location.search.includes('spike=latency'))location.replace('http://localhost:1420/?spike=latency')",
                                )
                                .is_ok();
                            if !ok {
                                break;
                            }
                            if i % 20 == 0 {
                                let _ = win.eval(
                                    "window.__TAURI_INTERNALS__.invoke('spike_log', { msg: 'nav-retry ' + location.search })",
                                );
                            }
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            attach_session,
            write_session,
            session_stats,
            spike_report_latency,
            spike_probe_channel,
            spike_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
