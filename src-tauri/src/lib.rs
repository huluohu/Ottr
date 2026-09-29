// Spike #2（Task 4）：PTY 双向流 + 二进制 IPC 通道定案 + 击键延迟测量。
// Spike #3（Task 7）：100MB 吞吐/背压测量 + 会话取消（drop_session）+ M-2 失败策略。
//
// 数据面（输出方向，PTY → 前端）：
//   russh channel 读循环 → 合批器（4ms 或 64KB 先到者，实验定值见下）→
//   `Channel<InvokeResponseBody>` + `InvokeResponseBody::Raw(bytes)` —— 二进制帧，
//   前端收到 `ArrayBuffer`（见 docs/phase0-report.md 定案）。禁 JSON/base64，永不丢弃字节。
// 输入方向（击键 → PTY）：`write_session(id, bytes)`，spike 台账裁定允许 JSON 数组。
// 会话取消（Task 7）：`drop_session(id)` → 移除表项 + 通知转发循环就地取消 +
//   disconnect（russh Handle::drop 不关连接，必须显式断，见 SshSession::disconnect 文档）。
//
// Task 7 字节账目：Rust 侧转发计数（forwarded_bytes/frames/input_bytes/writes/pty_read_bytes）
// + send 失败显式计数（send_failed_bytes/send_failed_frames/failed —— M-2 失败策略，
// flush_batch 文档）经 `session_stats` 可读；`OTTR_BATCH_DEBUG=1` 时逐批打 debug 日志。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use russh::ChannelMsg;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession};

// ---------------------------------------------------------------------------
// 合批器参数（Task 7 复用同一语义）
// ---------------------------------------------------------------------------

/// 合批窗口：首字节到达后最多等这么久（有字节即写、窗口为最长等待）。
/// 默认 4ms —— spike 实验（2026-09-29，100 字符 @20ms，详见 docs/phase0-report.md §2）：
/// 16ms 洁净复测同样达标（p95=23/29）；4ms 时 p50=8/p95=10–14ms（余量 3.5–5×）；
/// 0ms（到即写）p50=5/p95=13ms 但完全失去合并能力。4ms 以可忽略的延迟税保留突发合并。
/// 可用 `OTTR_BATCH_WINDOW_MS` 覆盖（Task 7 吞吐场景窗口实验沿用同一旋钮）。
const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// 合批上限：窗口内攒到 256KB 立即 flush，不等窗口到期。
/// 默认 256KB —— Task 7 实测定值（task-7-report.md §4）：64KB 无节流在 100MB
/// 洪流下触发 tauri Channel 静默停摆（~54MB 处整流冻结，wry#1644 同机制）；
/// 256KB 帧 + 16ms flush 间隔两跑账目零差、14 MiB/s、冻结 0。
/// 可用 `OTTR_BATCH_LIMIT_KB` 覆盖（实验/调试用）。
const BATCH_LIMIT: usize = 256 * 1024;

/// 运行时生效窗口（`OTTR_BATCH_WINDOW_MS` 覆盖；0 = 每条消息到即 flush）。
fn batch_window() -> Duration {
    std::env::var("OTTR_BATCH_WINDOW_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(BATCH_WINDOW)
}

/// 运行时生效合批上限（`OTTR_BATCH_LIMIT_KB` 覆盖，向下取整到字节）。
fn batch_limit() -> usize {
    std::env::var("OTTR_BATCH_LIMIT_KB")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kb| (kb as usize) * 1024)
        .filter(|v| *v > 0)
        .unwrap_or(BATCH_LIMIT)
}

/// flush 节流：两次 flush 之间的最小间隔。**默认 16ms**（`OTTR_FLUSH_MIN_INTERVAL_MS`
/// 覆盖；显式设 0 = 关闭节流）。
///
/// 默认值来源（Task 7 实测，task-7-report.md §4）：tauri `Channel::send` 是入队即
/// 返回语义、无反压信号，无节流时 webview 取数管线在洪流下静默停摆（一次丢帧 =
/// 全流冻结，wry#1644 同机制）；16ms（≈16MB/s @256KB 帧）是实测通过边界之下、
/// 32MB/s（必停滞）之上的保守验证值——E6/E6b 账目零差、冻结 0、100MB 全量 8.6s。
/// 交互场景不受影响：击键间隔 ≥16ms 时节流永不生效（Task 4 延迟红线复测无回归）。
fn flush_min_interval() -> Option<Duration> {
    match std::env::var("OTTR_FLUSH_MIN_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(0) => None,
        Some(ms) => Some(Duration::from_millis(ms)),
        None => Some(Duration::from_millis(16)),
    }
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
    /// 【M-2 失败策略】on_data.send 失败而**丢弃**的帧数（不计入 forwarded/frames）。
    send_failed_frames: AtomicU64,
    /// 【M-2 失败策略】on_data.send 失败而**丢弃**的字节数。
    /// 账目恒等式：pty_read_bytes == forwarded_bytes + send_failed_bytes + 批内残余。
    send_failed_bytes: AtomicU64,
    /// 【M-2 失败策略】会话级失败标志：任何 send 失败后置位，session_stats 可读。
    failed: AtomicBool,
}

struct SessionEntry {
    /// PTY 写端（russh `make_writer()`，与读循环共享同一通道）。
    writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>,
    counters: Arc<SessionCounters>,
    /// 取消信号：`drop_session` 触发，转发循环 select 到即就地退出（进程端任务取消）。
    cancel: Arc<Notify>,
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
    send_failed_frames: u64,
    send_failed_bytes: u64,
    failed: bool,
}

fn snapshot(counters: &SessionCounters) -> SessionStats {
    SessionStats {
        pty_read_bytes: counters.pty_read_bytes.load(Ordering::Relaxed),
        forwarded_bytes: counters.forwarded_bytes.load(Ordering::Relaxed),
        frames: counters.frames.load(Ordering::Relaxed),
        input_bytes: counters.input_bytes.load(Ordering::Relaxed),
        writes: counters.writes.load(Ordering::Relaxed),
        send_failed_frames: counters.send_failed_frames.load(Ordering::Relaxed),
        send_failed_bytes: counters.send_failed_bytes.load(Ordering::Relaxed),
        failed: counters.failed.load(Ordering::Relaxed),
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
    let cancel = Arc::new(Notify::new());
    let writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(channel.make_writer())));
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), SessionEntry {
            writer,
            counters: Arc::clone(&counters),
            cancel: Arc::clone(&cancel),
        });

    // 读循环持有 channel 与 session；循环退出（正常关闭/取消/IPC 失效）后统一断连：
    // russh Handle::drop 不关闭连接，不显式 disconnect 会让 sshd 上的 shell 与 TCP 悬挂。
    let session_id = id.clone();
    tauri::async_runtime::spawn(async move {
        forward_pty_loop(&mut channel, &on_data, &counters, &session_id, &cancel).await;
        if let Err(e) = session.disconnect().await {
            eprintln!("[batcher:{session_id}] disconnect on exit failed: {e}");
        }
    });
    Ok(id)
}

/// 关闭会话（Task 7 Step 4 可中断性；Task 5+ 的「关标签」接线点）。
/// 同步移除会话表项（此后 `session_stats` 报 no such session），并通知转发循环
/// 取消——循环就地退出（批内残余字节随之丢弃，账目按 `pty_read − forwarded −
/// send_failed = 批内残余` 显式失衡），随后统一 disconnect、连接关闭。
#[tauri::command]
async fn drop_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let entry = state
        .sessions
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    entry.cancel.notify_one();
    Ok(())
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
        "batch_limit_bytes": batch_limit(),
        "flush_min_interval_ms": flush_min_interval().map(|d| d.as_millis() as u64).unwrap_or(0),
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

// ---------------------------------------------------------------------------
// Task 11 / Spike #7：keyring 读写（service 用 "ottr.spike" 与正式数据隔离）
// ---------------------------------------------------------------------------

/// spike 固定 service/account；account 只是条目第二键，取固定值即可。
const KEYRING_SERVICE: &str = "ottr.spike";
const KEYRING_ACCOUNT: &str = "spike-account";

#[tauri::command]
fn spike_keyring_set(value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    entry.set_password(&value).map_err(|e| format!("set: {e}"))
}

#[tauri::command]
fn spike_keyring_get() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    entry.get_password().map_err(|e| format!("get: {e}"))
}

#[tauri::command]
fn spike_keyring_del() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    // keyring v3：delete_credential（v2 的 delete_password 已改名）。
    entry.delete_credential().map_err(|e| format!("del: {e}"))
}

// ---------------------------------------------------------------------------
// Task 11 / Spike #8：系统通知（tauri-plugin-notification，Rust 侧 API）
// ---------------------------------------------------------------------------

/// 发系统通知。macOS 首次调用触发系统授权框；未授权时 show() 仍成功、通知被
/// 系统静默丢弃——本命令只能证明「插件 API 调用成功」，弹窗与点击回焦列入
/// T13 runbook 人工验证（Windows Toast 应用身份 / Linux libnotify 同理）。
#[tauri::command]
fn spike_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("notify: {e}"))
}

/// Task 11 取数通道：spike 页 POST JSON 落盘（keyring/notify 页复用）。
/// 路径白名单 /tmp/ottr-*.json（spike 报告约定目录，防 webview 任意写文件）；
/// 含 `..` 一律拒绝（否则 /tmp/ottr-../../x.json 可同时满足前后缀逃逸白名单）。
#[tauri::command]
fn spike_report_file(path: String, payload: String) -> Result<String, String> {
    if !path.starts_with("/tmp/ottr-") || !path.ends_with(".json") || path.contains("..") {
        return Err(format!("report path not allowed: {path}"));
    }
    let report: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("bad report json: {e}"))?;
    std::fs::write(&path, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {path}: {e}"))?;
    Ok(path)
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
// 取消：select 在 `cancel`（drop_session）上，到即就地退出（打 `session dropped`）。
// ---------------------------------------------------------------------------

#[allow(unused_assignments)] // last_flush 的最后一次赋值在 break 路径上不被读取（预期）
async fn forward_pty_loop(
    channel: &mut russh::Channel<russh::client::Msg>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    session_id: &str,
    cancel: &Notify,
) {
    // russh 类型在此泄漏为 spike-pragmatic（见 ottr-ssh SshTransport 文档：
    // Channel 是 trait 边界上唯一泄漏点，正式版由包装类型消除）。
    let limit = batch_limit();
    let mut buf: Vec<u8> = Vec::with_capacity(limit);
    let mut deadline: Option<Instant> = None;
    let mut last_flush: Option<Instant> = None;

    // flush 前按 `flush_min_interval` 节流（背压旋钮，默认关）：间隔不足就等足。
    // 等待期间 russh channel 不被读取，SSH 窗口收紧 → sshd 端 cat 阻塞 → 端到端背压。
    macro_rules! paced_flush {
        () => {{
            if let Some(min) = flush_min_interval() {
                if let Some(t) = last_flush {
                    let elapsed = t.elapsed();
                    if elapsed < min {
                        tokio::time::sleep(min - elapsed).await;
                    }
                }
            }
            last_flush = Some(Instant::now());
            flush_batch(&mut buf, &mut deadline, limit, on_data, counters, session_id).await
        }};
    }

    // send 失败 = 前端通道不可达（M-2 失败策略，见 flush_batch）：终止循环。
    loop {
        let msg = match deadline {
            Some(d) => {
                let remaining = d.saturating_duration_since(Instant::now());
                tokio::select! {
                    m = channel.wait() => m,
                    _ = tokio::time::sleep(remaining) => {
                        if !paced_flush!() {
                            break;
                        }
                        continue;
                    }
                    _ = cancel.notified() => {
                        // 会话被丢弃（关标签/drop_session）：进程端任务就地取消。
                        // 批内残余字节随之丢弃（不再转发）——账目恒等式显式失衡：
                        // pty_read − forwarded − send_failed = 批内残余。
                        eprintln!("[batcher:{session_id}] session dropped");
                        break;
                    }
                }
            }
            None => tokio::select! {
                m = channel.wait() => m,
                _ = cancel.notified() => {
                    eprintln!("[batcher:{session_id}] session dropped");
                    break;
                }
            },
        };

        match msg {
        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
            counters.pty_read_bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
            if buf.is_empty() {
                deadline = Some(Instant::now() + batch_window());
            }
                buf.extend_from_slice(&data);
                if buf.len() >= limit {
                    if !paced_flush!() {
                        break;
                    }
                }
            }
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) => {
                if !paced_flush!() {
                    break;
                }
            }
            Some(ChannelMsg::Close) | None => {
                paced_flush!();
                eprintln!("[batcher:{session_id}] pty closed");
                break;
            }
            _ => {}
        }
    }
}

/// flush 一批到前端。返回 false = send 失败，调用方**必须**终止转发循环。
///
/// 【M-2 失败策略（T4 台账挂账：此前 send 失败仅 eprintln，字节静默丢失且循环
/// 空转继续丢）】send 失败意味着前端通道已不可达（webview 关闭/通道断开），
/// 重试无意义、继续循环只会静默丢字节并烧 CPU。三步定案：
/// ① 失败字节计入显式计数 `send_failed_bytes/frames`——账目恒等式
///    `pty_read == forwarded + send_failed + 批内残余` 失衡可见，绝不静默；
/// ② 置会话级失败标志 `failed`（`session_stats` 可读，前端轮询可见——spike 阶段
///    无推送通道，轮询即「上报前端」）；
/// ③ 返回 false 让转发循环终止，连接随后统一 disconnect（进程端任务取消）。
async fn flush_batch(
    buf: &mut Vec<u8>,
    deadline: &mut Option<Instant>,
    limit: usize,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    session_id: &str,
) -> bool {
    *deadline = None;
    if buf.is_empty() {
        return true;
    }
    let n = buf.len();
    let payload = std::mem::replace(buf, Vec::with_capacity(limit));
    match on_data.send(InvokeResponseBody::Raw(payload)) {
        Ok(()) => {
            counters.forwarded_bytes.fetch_add(n as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            if std::env::var_os("OTTR_BATCH_DEBUG").is_some() {
                eprintln!("[batcher:{session_id}] flush {n} bytes");
            }
            true
        }
        Err(e) => {
            counters.send_failed_bytes.fetch_add(n as u64, Ordering::Relaxed);
            counters.send_failed_frames.fetch_add(1, Ordering::Relaxed);
            counters.failed.store(true, Ordering::Relaxed);
            eprintln!("[batcher:{session_id}] session dropped (ipc send failed, {n} bytes lost): {e}");
            false
        }
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
        // Task 11 / Spike #8：系统通知（macOS 首次调用触发系统授权）。
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            // 自动化驱动入口：OTTR_SPIKE=latency|throughput 时把页面导航到对应
            // ?spike=… 模式（Task 4/7 测量页），OTTR_SPIKE_INTERRUPT=1 追加中断参数
            // （Task 7 Step 4 自动中断验证）。前端据此自动测量并回传报告
            // （scripts/spike-latency.sh、scripts/spike-throughput.sh）。
            // eval 可能在页面首次加载 commit 前被 webview 丢弃，故带守卫重试：
            // 导航成功后表达式变成 no-op，重复 eval 无害。
            // 窗口置顶 + 抢焦点：后台/遮挡窗口会被 WebKit 节流计时器，
            // 曾导致测量页整场停滞（240s 无报告）。
            let spike_mode = std::env::var("OTTR_SPIKE")
                .ok()
                .filter(|m| matches!(m.as_str(), "latency" | "throughput" | "keyring" | "notify"));
            if let Some(mode) = spike_mode {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_focus();
                    let extra = if std::env::var("OTTR_SPIKE_INTERRUPT").as_deref() == Ok("1") {
                        "&interrupt=1"
                    } else {
                        ""
                    };
                    let target = format!("http://localhost:1420/?spike={mode}{extra}");
                    let guard = format!(
                        "if(!location.search.includes('spike={mode}'))location.replace('{target}')"
                    );
                    tauri::async_runtime::spawn(async move {
                        for i in 0..480 {
                            let ok = win.eval(&guard).is_ok();
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
            drop_session,
            session_stats,
            spike_report_latency,
            spike_probe_channel,
            spike_log,
            spike_keyring_set,
            spike_keyring_get,
            spike_keyring_del,
            spike_notify,
            spike_report_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
