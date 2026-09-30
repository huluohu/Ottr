// 会话管理（Phase 1 Task 7）：在 Phase 0 数据面（合批转发 + 二进制通道）之上
// 补全连接生命周期——
//   * `attach_host_session(host_id, …)`：vault 取主机/凭据（明文只在 Rust 侧解密，
//     前端永不接触），TOFU host key 策略（首连 pending 入库 + 事件问询前端确认，
//     changed 默认拒绝 + 显式接受才放行），传输层 keepalive 60s；
//   * `host_key_decision`：前端确认框的裁定回传（挂起的 connect 就地放行/拒绝）；
//   * `ottr://session-closed` 事件：连接自行断开（对端关闭/keepalive 超时）时
//     通知前端触发重连状态机（关标签的主动 drop 不需要前端反应）。
// `attach_session`（host/port/username/password 直传、指纹 pin）保留为 scripts/
// 驱动脚本的命令面（台账裁定）；UI 侧 ?spike= 页面随多标签重构删除。
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
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession};
use ottr_vault::{Hosts, KnownHostState, KnownHosts};

pub mod keys;
pub mod ssh_config;
pub mod vault;
use crate::vault::VaultState;

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

/// 会话表（Arc 共享：命令面与转发循环收尾任务都要增删）。
type SessionMap = Arc<Mutex<HashMap<String, SessionEntry>>>;

/// 挂起中的 host key 问询（TOFU 确认框交互）。
/// key = `"{host_id}:{fingerprint}"`；value = 裁定回传端（`host_key_decision` 发送）。
/// TOFU 策略回调在 russh 连接专属任务内 `recv_timeout(60s)` 阻塞等待——
/// russh 的握手运行在 `connect_stream` spawn 的独立任务里（见 russh 0.63 源码），
/// 阻塞只挂起该连接自己的握手，这正是「connect 挂起等前端 confirm」的语义；
/// 60s 无裁定即按拒绝处理（超时安全侧）。
type HostKeyAsks = Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<bool>>>>;

#[derive(Default)]
struct AppState {
    sessions: SessionMap,
    host_key_asks: HostKeyAsks,
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

/// attach_host_session 的传输层 keepalive 间隔（简报定值 60s）。
/// russh `Config::keepalive_interval`：每间隔发传输层 keepalive 全局请求
/// （**不进 channel 数据流**，不污染终端）；`keepalive_max`（默认 3）个周期
/// 收不到对端任何数据即 KeepaliveTimeout 断连 → 转发循环退出 → 前端重连状态机。
/// 对端 RST/FIN（容器被 kill 等）不依赖 keepalive，读循环立即感知。
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

/// host key 问询超时（简报定值）：前端确认框挂起 connect 的最长等待。
const HOST_KEY_ASK_TIMEOUT: Duration = Duration::from_secs(60);

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
// 命令：attach（scripts 命令面 / 正式 host 面）/ write / stats / host key 裁定
// ---------------------------------------------------------------------------

/// 连接夹具（密码认证 + 指纹 pin）、开 PTY、起 shell，并启动合批转发循环。
/// 返回会话 id；PTY 输出经 `on_data`（二进制 Raw 帧）推给前端。
/// **scripts/ 驱动脚本命令面**（台账裁定）：直传参数 + Phase 0 语义原样保留
/// （15s 限时、指纹 pin、无 keepalive、无 session-closed 事件）；
/// 正式 UI 走 [`attach_host_session`]（vault 凭据 + TOFU + keepalive）。
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
    open_and_register(
        state.sessions.clone(),
        None,
        &host,
        port,
        &username,
        AuthMethod::Password(password),
        policy,
        None,
        Duration::from_secs(15),
        format!("pinned {pinned}"),
        cols,
        rows,
        on_data,
    )
    .await
}

/// 从 vault 主机条目发起连接（Task 7 会话管理命令面，前端只传 host_id）：
/// address/port/username/credential_id 全部 Rust 侧解析，凭据明文经
/// `Credentials::reveal` 只在 Rust 侧解密——**前端永不接触明文凭据**；
/// host key 走 TOFU 确认策略（[`tofu_host_key_policy`]）；传输层 keepalive 60s。
#[tauri::command]
async fn attach_host_session(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    app: AppHandle,
    host_id: i64,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let host = Hosts::get(&vault.0, host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("host id={host_id} not found"))?;
    let username = host
        .username
        .clone()
        .ok_or_else(|| format!("host id={host_id} has no username"))?;
    let credential_id = host
        .credential_id
        .ok_or_else(|| format!("host id={host_id} has no credential bound"))?;
    // 明文凭据只在此（Rust 侧）出现；key 凭据的临时 PEM 由 guard 持有至连接完成
    let (auth, _temp_key_guard) = keys::resolve_credential_auth(&vault, credential_id).await?;
    let port = u16::try_from(host.port)
        .map_err(|_| format!("host id={host_id}: port {} out of range", host.port))?;
    let policy = tofu_host_key_policy(
        Arc::clone(&vault.0),
        app.clone(),
        host_id,
        host.name.clone(),
        // TOFU 信任锚 = 网络端点（0004 迁移）：known_hosts 按端点记账，删主机
        // 重建 / 同端点多记录共享同一份信任（防 MITM 语义，见 host_endpoint_key）。
        ottr_vault::host_endpoint_key(&host.address, host.port),
        Arc::clone(&state.host_key_asks),
    );
    // connect 限时 = host key 问询窗口 60s + 网络预算 15s（问询期间握手合法挂起）
    open_and_register(
        state.sessions.clone(),
        Some(app),
        &host.address,
        port,
        &username,
        auth,
        policy,
        Some(KEEPALIVE_INTERVAL),
        Duration::from_secs(75),
        format!("{}@{}:{}", username, host.address, port),
        cols,
        rows,
        on_data,
    )
    .await
}

/// attach_host_session 的 host key 策略：known_hosts 记账 + 前端确认交互（TOFU）。
/// 记账键 = host 端点（0004 迁移，Task 8 义务①）：`host_key = "address:port"`，
/// 同端点共用一条信任记录。状态机（known_hosts state，见 ottr-vault KnownHosts 文档）：
/// * 无记录 → pending 入库（TOFU 留痕，拒绝也留）+ `ottr://host-key-ask`(kind=first)；
/// * 记录存在、指纹一致且 `ok` → 静默放行；
/// * 记录存在、指纹一致且 `pending` → 同问询（kind=pending，历史未决重问）；
/// * 记录存在、指纹**不一致** → 换钥检测：mark_changed 打标 + kind=changed 强提醒
///   （默认拒绝——这是 spec §10 防 MITM 的核心路径，Task 8 前同主机换钥被误判为首见）；
/// * `changed`（指纹一致但状态未恢复）→ kind=changed 强提醒。
///
/// 裁定经 `host_key_decision` 回传：接受=true 放行（库态转 ok、信任锚接管为本次
/// 指纹，由该命令落账，changed_at 保留），拒绝 / 60s 超时=false → 连接以
/// HostKeyRejected 失败；行内信任锚保持旧指纹（mark_changed 不覆盖）。
///
/// 阻塞语义：回调在 russh `connect_stream` spawn 的连接专属任务内执行，
/// `recv_timeout(60s)` 只挂起该连接自己的握手（connect 命令挂起等前端 confirm），
/// 不占公共 worker；超时按拒绝处理（安全侧默认）。
fn tofu_host_key_policy(
    vault: Arc<ottr_vault::Vault>,
    app: AppHandle,
    host_id: i64,
    host_name: String,
    host_key: String,
    asks: HostKeyAsks,
) -> HostKeyPolicy {
    Arc::new(move |fingerprint: &str| {
        let known = match KnownHosts::get(&vault, &host_key) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("[host-key] known_hosts read failed: {e}");
                return false;
            }
        };
        // 问询：登记回传端 → 事件问前端 → 挂起等裁定/超时。
        let ask = |kind: &'static str| -> bool {
            let (tx, rx) = std::sync::mpsc::channel();
            let key = format!("{host_id}:{fingerprint}");
            // 同键并发问询（双开同一主机）：顶掉旧端（旧等待方随 sender 被替换而判拒）
            if let Some(old) = asks.lock().unwrap().insert(key, tx) {
                drop(old);
            }
            if let Err(e) = app.emit(
                "ottr://host-key-ask",
                HostKeyAskPayload {
                    host_id,
                    host_name: host_name.clone(),
                    fingerprint: fingerprint.to_string(),
                    kind,
                },
            ) {
                eprintln!("[host-key] emit ask failed: {e}");
                return false;
            }
            // block_in_place（评审 M-1）：recv_timeout 最长 60s 阻塞；本回调运行在
            // russh run loop 任务（russh-util spawn = tokio::spawn）里，包裹后该
            // worker 被标记 blocking、其余任务可被其余 worker 领走，不占死共享池。
            matches!(
                tokio::task::block_in_place(|| rx.recv_timeout(HOST_KEY_ASK_TIMEOUT)),
                Ok(true)
            )
        };
        // 先分类（None → "first"），再落账：
        //   * 首见 → TOFU pending 入库（入库后记录是 pending，顺序颠倒会让首连问询
        //     带上错误的 kind）；
        //   * 换钥（有记录、指纹不一致）→ mark_changed 打标（保留旧信任锚）。检测即
        //     落值：用户拒绝也留下「何时检测到变更」的痕迹，changed_at 不因放弃而丢失。
        let kind = host_key_ask_kind(known.as_ref(), fingerprint);
        let rotated = matches!(&known, Some(k) if k.fingerprint != fingerprint);
        if kind == Some("first") {
            if let Err(e) = KnownHosts::upsert(&vault, &host_key, fingerprint) {
                eprintln!("[host-key] upsert failed: {e}");
                return false;
            }
        } else if rotated {
            if let Err(e) = KnownHosts::mark_changed(&vault, &host_key, fingerprint) {
                eprintln!("[host-key] mark_changed failed: {e}");
                return false;
            }
        }
        match kind {
            None => true,            // state=ok 且指纹一致 → 静默放行
            Some(kind) => ask(kind), // first / pending / changed → 前端问询
        }
    })
}

/// known_hosts 记录 + 本次出示指纹 → 下一步动作（可测纯分类）：
/// `None` = 静默放行（指纹一致且 state=ok）；`Some(kind)` = 需前端确认的种类：
/// * 无记录 = "first"（TOFU 首问；pending 入库由调用方负责）；
/// * 指纹一致 + pending = "pending"（历史未决重问）；
/// * 其余（changed 状态 / **指纹不一致=换钥**）= "changed"（强提醒，默认拒绝）。
fn host_key_ask_kind(
    known: Option<&ottr_vault::KnownHost>,
    fingerprint: &str,
) -> Option<&'static str> {
    match known {
        None => Some("first"),
        Some(k) if k.fingerprint == fingerprint && k.state == KnownHostState::Ok => None,
        Some(k) if k.fingerprint == fingerprint && k.state == KnownHostState::Pending => {
            Some("pending")
        }
        Some(_) => Some("changed"),
    }
}

/// `ottr://host-key-ask` 事件载荷（serde snake_case）。
#[derive(Clone, serde::Serialize)]
struct HostKeyAskPayload {
    host_id: i64,
    host_name: String,
    fingerprint: String,
    /// "first"（首见 TOFU）/ "pending"（历史问询未决重问）/ "changed"（强提醒，默认拒绝）
    kind: &'static str,
}

/// 前端确认框裁定回传：`accept=true` 先落账 `KnownHosts::verify`（state→ok、
/// verified=1、**信任锚接管为本次指纹、changed_at 保留**——变更历史不随信任
/// 恢复抹除），再放行挂起的 connect。落账键 = host 端点（0004 迁移）：按
/// host_id 现查 address/port 组装，与策略层写入口径一致。
/// 无挂起问询（已超时/已裁定）返回错误——落账已发生（接受路径），下次
/// 连接直接放行，无害。
#[tauri::command]
fn host_key_decision(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    host_id: i64,
    fingerprint: String,
    accept: bool,
) -> Result<(), String> {
    let key = format!("{host_id}:{fingerprint}");
    let tx = state.host_key_asks.lock().unwrap().remove(&key);
    // host 行可能在问询挂起期间被删：无端点可落账，按拒绝收尾（不悬挂等待方）。
    let host_key = match Hosts::get(&vault.0, host_id) {
        Ok(Some(host)) => ottr_vault::host_endpoint_key(&host.address, host.port),
        Ok(None) => {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(false);
            }
            return Err(format!("host id={host_id} not found for host key decision"));
        }
        Err(e) => {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(false);
            }
            return Err(format!("host id={host_id} read failed: {e}"));
        }
    };
    if accept {
        if let Err(e) = KnownHosts::verify(&vault.0, &host_key, &fingerprint) {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(false);
            }
            return Err(e.to_string());
        }
    }
    match tx {
        Some(tx) => {
            let _ = tx.send(accept);
            Ok(())
        }
        None => Err(format!(
            "no pending host key ask for host {host_id} (expired or already decided)"
        )),
    }
}

/// 连接生命周期骨架（[`attach_session`] 与 [`attach_host_session`] 共用）：
/// connect（限时）→ open_pty（10s）→ request_shell（10s）→ 注册会话表 →
/// 起合批转发循环。循环退出（对端关闭 / drop_session 取消 / IPC 失败）统一收尾：
/// 清会话表项 + （可选）`ottr://session-closed` 事件 + 显式 disconnect
/// （russh `Handle::drop` 不关连接，必须显式断，见 SshSession::disconnect 文档）。
/// `keepalive`：交互式长连传 Some；spike 命令面传 None 保持 Phase 0 语义不变。
#[allow(clippy::too_many_arguments)]
async fn open_and_register(
    sessions: SessionMap,
    close_event: Option<AppHandle>,
    address: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    policy: HostKeyPolicy,
    keepalive: Option<Duration>,
    connect_timeout: Duration,
    err_ctx: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    // spike 观测：attach 偶发整体停滞（1/5 频率），故每步限时并打点定位。
    let session: SshSession = tokio::time::timeout(
        connect_timeout,
        ottr_ssh::connect_with_keepalive(address, port, username, auth, policy, keepalive),
    )
    .await
    .map_err(|_| format!("connect timed out after {}s ({err_ctx})", connect_timeout.as_secs()))?
    .map_err(|e| format!("connect failed ({err_ctx}): {e}"))?;
    eprintln!("[attach] connected {username}@{address}:{port}");

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
    sessions.lock().unwrap().insert(
        id.clone(),
        SessionEntry {
            writer,
            counters: Arc::clone(&counters),
            cancel: Arc::clone(&cancel),
        },
    );

    // 读循环持有 channel 与 session；循环退出后统一收尾：清表（此后 session_stats
    // 报 no such session；drop_session 对已消失的 id 幂等报错，前端容忍）→
    // session-closed 事件（前端重连状态机的触发点）→ disconnect。
    let session_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let reason = forward_pty_loop(&mut channel, &on_data, &counters, &session_id, &cancel).await;
        sessions.lock().unwrap().remove(&session_id);
        if let Some(app) = &close_event {
            let _ = app.emit(
                "ottr://session-closed",
                SessionClosedPayload {
                    id: session_id.clone(),
                    reason,
                },
            );
        }
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
            (id.clone(), serde_json::to_value(&stats).unwrap_or_default())
        })
        .collect();
    report["rust"] = serde_json::json!({
        "batch_window_ms": batch_window().as_millis() as u64,
        "batch_limit_bytes": batch_limit(),
        "flush_min_interval_ms": flush_min_interval().map(|d| d.as_millis() as u64).unwrap_or(0),
        "sessions": rust_side,
    });

    let path =
        std::env::var("OTTR_SPIKE_REPORT").unwrap_or_else(|_| "/tmp/ottr-latency.json".into());
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
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
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
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
        .send(InvokeResponseBody::Json(
            serde_json::to_string(&b64).unwrap(),
        ))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 合批转发循环：有字节即写、窗口（默认 4ms）为最长等待；64KB 先到者立即 flush。
// 取消：select 在 `cancel`（drop_session）上，到即就地退出（打 `session dropped`）。
// 返回退出原因：Cancelled（drop_session）/ Closed（对端关闭）/ IpcFailed（前端
// 通道不可达）——`ottr://session-closed` 事件的载荷（Cancelled = 主动关闭，前端
// 重连状态机不应反应；Closed/IpcFailed = 连接丢失，触发自动重连）。
// ---------------------------------------------------------------------------

/// 会话关闭原因（`ottr://session-closed` 载荷，serde snake_case）。
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum SessionCloseReason {
    /// drop_session 主动取消（关标签/手动断开）。
    Cancelled,
    /// 对端关闭（shell 退出 / 连接断开 / keepalive 超时）。
    Closed,
    /// 前端 IPC 通道 send 失败（M-2 失败策略）。
    IpcFailed,
}

#[derive(Clone, serde::Serialize)]
struct SessionClosedPayload {
    id: String,
    reason: SessionCloseReason,
}

#[allow(unused_assignments)] // last_flush 的最后一次赋值在 break 路径上不被读取（预期）
async fn forward_pty_loop(
    channel: &mut russh::Channel<russh::client::Msg>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    session_id: &str,
    cancel: &Notify,
) -> SessionCloseReason {
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
            flush_batch(
                &mut buf,
                &mut deadline,
                limit,
                on_data,
                counters,
                session_id,
            )
            .await
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
                            return SessionCloseReason::IpcFailed;
                        }
                        continue;
                    }
                    _ = cancel.notified() => {
                        // 会话被丢弃（关标签/drop_session）：进程端任务就地取消。
                        // 批内残余字节随之丢弃（不再转发）——账目恒等式显式失衡：
                        // pty_read − forwarded − send_failed = 批内残余。
                        eprintln!("[batcher:{session_id}] session dropped");
                        return SessionCloseReason::Cancelled;
                    }
                }
            }
            None => tokio::select! {
                m = channel.wait() => m,
                _ = cancel.notified() => {
                    eprintln!("[batcher:{session_id}] session dropped");
                    return SessionCloseReason::Cancelled;
                }
            },
        };

        match msg {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                counters
                    .pty_read_bytes
                    .fetch_add(data.len() as u64, Ordering::Relaxed);
                if buf.is_empty() {
                    deadline = Some(Instant::now() + batch_window());
                }
                buf.extend_from_slice(&data);
                if buf.len() >= limit && !paced_flush!() {
                    return SessionCloseReason::IpcFailed;
                }
            }
            Some(ChannelMsg::ExitStatus { .. }) => {}
            Some(ChannelMsg::Eof) => {
                if !paced_flush!() {
                    return SessionCloseReason::IpcFailed;
                }
            }
            Some(ChannelMsg::Close) | None => {
                paced_flush!();
                eprintln!("[batcher:{session_id}] pty closed");
                return SessionCloseReason::Closed;
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
            counters
                .forwarded_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            if std::env::var_os("OTTR_BATCH_DEBUG").is_some() {
                eprintln!("[batcher:{session_id}] flush {n} bytes");
            }
            true
        }
        Err(e) => {
            counters
                .send_failed_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.send_failed_frames.fetch_add(1, Ordering::Relaxed);
            counters.failed.store(true, Ordering::Relaxed);
            eprintln!(
                "[batcher:{session_id}] session dropped (ipc send failed, {n} bytes lost): {e}"
            );
            false
        }
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Task 11 / Spike #8：系统通知（macOS 首次调用触发系统授权）。
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            // Task 5：vault 打开并托管（app_data_dir + 钥匙链 Master Key）。
            // 在此失败即启动失败——数据层不可用时主机/凭据功能整体不可用，
            // 显式报错优于让每个命令各自失败。
            let vault_state = vault::init(app.handle())
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(vault_state);

            // A10（Task 1）：系统主题监听。前端主通道是 matchMedia(prefers-color-scheme)
            // （src/theme/ThemeContext.tsx）；这里补 Rust 侧兜底推送 `ottr://system-theme`
            // （payload: "light"/"dark"）——Linux WebKitGTK 对系统明暗动态跟随不可靠，
            // 由窗口 ThemeChanged 事件兜底。初始值无需推送：前端挂载时读 matchMedia。
            if let Some(win) = app.get_webview_window("main") {
                let watcher = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(theme) = event {
                        let _ = watcher.emit("ottr://system-theme", theme.to_string());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            attach_session,
            attach_host_session,
            host_key_decision,
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
            spike_report_file,
            // vault（Task 5 接线，命令名契约见 src/vault/api.ts 文件头）
            vault::hosts_list,
            vault::hosts_get,
            vault::hosts_create,
            vault::hosts_update,
            vault::hosts_delete,
            vault::hosts_list_by_group,
            vault::hosts_search,
            vault::credentials_list,
            vault::credentials_get,
            vault::credentials_create,
            vault::credentials_update,
            vault::credentials_delete,
            vault::credentials_reveal,
            vault::host_groups_list,
            vault::host_groups_create,
            vault::host_groups_update,
            vault::host_groups_delete,
            vault::snippets_list,
            vault::snippets_get,
            vault::snippets_search,
            vault::snippets_create,
            vault::snippets_update,
            vault::snippets_delete,
            vault::known_hosts_list,
            vault::known_hosts_upsert,
            vault::known_hosts_verify,
            vault::known_hosts_mark_changed,
            vault::import_ssh_config,
            vault::export_hosts_csv,
            // 密钥管理（Task 6，A4；命令名契约见 src/vault/api.ts keys 段）
            keys::key_generate,
            keys::key_inspect,
            keys::key_export,
            keys::key_deploy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// 测试（host key TOFU 分类 + 落账语义；无需 Tauri 运行时）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn known_host(host_key: &str, fingerprint: &str, state: KnownHostState) -> ottr_vault::KnownHost {
        ottr_vault::KnownHost {
            host_key: host_key.into(),
            fingerprint: fingerprint.into(),
            first_seen: 0,
            verified: false,
            changed_at: None,
            state,
        }
    }

    #[test]
    fn host_key_classification_matches_known_hosts_states() {
        let hk = "10.0.0.1:22";
        let fp = "SHA256:x";
        // 无记录 → TOFU 首问；指纹一致+ok → 静默放行；一致+pending → 重问；
        // changed / **指纹不一致（换钥）** → 强提醒
        assert_eq!(host_key_ask_kind(None, fp), Some("first"));
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Ok)), fp),
            None
        );
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Pending)), fp),
            Some("pending")
        );
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Changed)), fp),
            Some("changed")
        );
        // 换钥（Task 8 义务①核心分类）：无论旧状态，指纹不一致一律 changed 强提醒
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, "SHA256:old", KnownHostState::Ok)), fp),
            Some("changed")
        );
    }

    /// TOFU 全流程落账语义（vault 直查，InMemoryStorage master key），按端点记账：
    /// 首见 upsert=pending → verify=ok → 换钥 mark_changed（changed_at 落值、
    /// 旧锚保留）→ 用户显式接受再 verify：state 回 ok、信任锚接管新指纹、
    /// **changed_at 保留**（「何时出过事」不随信任恢复抹除，Task 6 裁定 #4）。
    #[test]
    fn host_key_tofu_lifecycle_preserves_changed_at_after_reaccept() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        let hk = "10.0.0.1:22";

        let first = KnownHosts::upsert(&vault, hk, "SHA256:fp").unwrap();
        assert_eq!(first.state, KnownHostState::Pending);
        // 「first」kind 只在策略闭包里于 upsert 之前由 None 分类得出
        // （见 host_key_classification_matches_known_hosts_states）；
        // 已入库的 pending 记录重问时是 "pending"。
        assert_eq!(host_key_ask_kind(Some(&first), "SHA256:fp"), Some("pending"));

        let verified = KnownHosts::verify(&vault, hk, "SHA256:fp").unwrap();
        assert_eq!(verified.state, KnownHostState::Ok);
        assert!(verified.verified);
        assert_eq!(host_key_ask_kind(Some(&verified), "SHA256:fp"), None, "ok 后静默放行");

        // 换钥：同端点同一条记录，changed 强提醒；信任锚保留旧指纹。
        let changed = KnownHosts::mark_changed(&vault, hk, "SHA256:rotated").unwrap();
        assert_eq!(changed.state, KnownHostState::Changed);
        assert_eq!(changed.fingerprint, "SHA256:fp", "旧信任锚保留");
        assert_eq!(
            host_key_ask_kind(Some(&changed), "SHA256:rotated"),
            Some("changed")
        );
        let changed_at = changed.changed_at.expect("mark_changed 落值");

        let reaccepted = KnownHosts::verify(&vault, hk, "SHA256:rotated").unwrap();
        assert_eq!(reaccepted.state, KnownHostState::Ok);
        assert!(reaccepted.verified);
        assert_eq!(reaccepted.fingerprint, "SHA256:rotated", "接受后信任锚接管新指纹");
        assert_eq!(reaccepted.changed_at, Some(changed_at), "changed_at 保留");
    }

    /// 同 host 换钥全链路（Task 8 义务①核心回归，vault 直查）：
    /// 换钥后的指纹在**同一端点记录**上触发 changed，而不是像旧 schema
    /// （fingerprint 主键）那样查无记录、被当成新一轮 TOFU 首见。
    #[test]
    fn same_host_key_rotation_lands_on_changed_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        let hk = "web.example:22";

        KnownHosts::upsert(&vault, hk, "SHA256:A").unwrap();
        KnownHosts::verify(&vault, hk, "SHA256:A").unwrap();

        // 服务器出示新指纹：分类必须是 changed（不是 first）
        assert_eq!(host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"), Some("changed"));
        let flagged = KnownHosts::mark_changed(&vault, hk, "SHA256:B").unwrap();
        assert_eq!(flagged.state, KnownHostState::Changed);
        // 拒绝后重连：仍是 changed 强提醒（信任锚还在旧钥匙上，指纹依旧不一致）
        assert_eq!(host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"), Some("changed"));
        assert_eq!(KnownHosts::list(&vault).unwrap().len(), 1, "换钥不新增记录");
    }
}
