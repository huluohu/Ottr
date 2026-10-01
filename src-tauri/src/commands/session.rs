//! 会话命令域（Task 0 拆分，纯搬家）：attach（scripts 直传面 / vault host 面）/
//! host key TOFU 策略与裁定 / write / stats / tail / drop / quit / disconnect_all
//! + 合批转发循环（forward_pty_loop / flush_batch）+ shell 集成自动注入。
//! 共享状态经 `super::state`；vault 门卫/密钥解析复用 crate::vault、crate::keys、
//! crate::security（零逻辑改动）。
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use russh::ChannelMsg;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession};
use ottr_term::encoding::{Encoding, StreamDecoder};
use ottr_vault::{Hosts, KnownHostState, KnownHosts, Settings};

use super::encoding::{encoding_from_str, EncodingHintPayload};
use super::state::{
    batch_limit, batch_window, flush_min_interval, snapshot, AppState, HostKeyAsks,
    SessionCounters, SessionEntry, SessionMap, SessionStats, TextTail, HOST_KEY_ASK_TIMEOUT,
    KEEPALIVE_INTERVAL, LANG_PROBE_CMD, LANG_PROBE_TIMEOUT, SESSION_SEQ,
};
use crate::keys;
use crate::vault::VaultState;

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
// 命令：attach（scripts 命令面 / 正式 host 面）/ write / stats / host key 裁定
// ---------------------------------------------------------------------------

/// 连接夹具（密码认证 + 指纹 pin）、开 PTY、起 shell，并启动合批转发循环。
/// 返回会话 id；PTY 输出经 `on_data`（二进制 Raw 帧）推给前端。
/// **scripts/ 驱动脚本命令面**（台账裁定）：直传参数 + Phase 0 语义原样保留
/// （15s 限时、指纹 pin、无 keepalive、无 session-closed 事件）；
/// 正式 UI 走 [`attach_host_session`]（vault 凭据 + TOFU + keepalive）。
#[tauri::command]
pub(crate) async fn attach_session(
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
        Encoding::Utf8,
        false,
        false,
    )
    .await
}

/// 从 vault 主机条目发起连接（Task 7 会话管理命令面，前端只传 host_id）：
/// address/port/username/credential_id 全部 Rust 侧解析，凭据明文经
/// `Credentials::reveal` 只在 Rust 侧解密——**前端永不接触明文凭据**；
/// host key 走 TOFU 确认策略（[`tofu_host_key_policy`]）；传输层 keepalive 60s。
#[tauri::command]
pub(crate) async fn attach_host_session(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    app: AppHandle,
    host_id: i64,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    // T11 锁定门卫：锁定态（主密码模式）下连接必须先解锁——凭据 reveal 反正
    // 会失败，这里提前给出明确错误（LockScreen 遮罩正常时不会走到这）。
    vault.0.ensure_unlocked().map_err(|e| e.to_string())?;
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
    // 初始编码 = host 表单 encoding_override（T5 字段，Task 9 生效点）；
    // 无法识别的值兜底 UTF-8（attach 不因坏配置失败）。会话级手动切换
    // （set_session_encoding）不写回 host，重连后回到本初值。
    let initial_encoding = host
        .encoding_override
        .as_deref()
        .and_then(encoding_from_str)
        .unwrap_or(Encoding::Utf8);
    // shell 集成自动注入开关（Task 15 fix 1/5）：settings `shell.integration`
    // 现读（缺省开；读取失败兜底开——坏配置不断 ⌘R 历史数据源）。
    let shell_integration = crate::security::shell_integration_enabled(
        Settings::get(&vault.0, crate::security::SETTING_SHELL_INTEGRATION)
            .unwrap_or(None)
            .as_ref(),
    );
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
        initial_encoding,
        true,
        shell_integration,
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
pub(crate) fn host_key_decision(
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
/// 起合批转发循环（Task 9：flush 时按会话 Decoder 解码再 IPC）。
/// 循环退出（对端关闭 / drop_session 取消 / IPC 失败）统一收尾：
/// 清会话表项 + （可选）`ottr://session-closed` 事件 + 显式 disconnect
/// （russh `Handle::drop` 不关连接，必须显式断，见 SshSession::disconnect 文档）。
/// **注册前**（open_pty/request_shell）任一早退——限时超时或协议错——同样
/// 统一收尾：先 best-effort 显式 disconnect 再返回错误（终审 A1，
/// 见 [`close_after_failed_attach`]）。connect 阶段早退无会话可收
/// （[`ottr_ssh::SshSession`] 尚未产出）。
/// `keepalive`：交互式长连传 Some；spike 命令面传 None 保持 Phase 0 语义不变。
/// `initial_encoding`：会话解码初值（host encoding_override 兜底 UTF-8）；
/// `ui_face`：正式 UI 面开关（LANG 探测 + shell 集成自动注入两个后台任务，
/// scripts 驱动面 false 不打扰）；`shell_integration`：settings
/// `shell.integration` 现读值（关 = 不探测不注入，见 [`inject_shell_integration`]）。
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
    initial_encoding: Encoding,
    ui_face: bool,
    shell_integration: bool,
) -> Result<String, String> {
    // spike 观测：attach 偶发整体停滞（1/5 频率），故每步限时并打点定位。
    let session: SshSession = tokio::time::timeout(
        connect_timeout,
        ottr_ssh::connect_with_keepalive(address, port, username, auth, policy, keepalive),
    )
    .await
    .map_err(|_| {
        format!(
            "connect timed out after {}s ({err_ctx})",
            connect_timeout.as_secs()
        )
    })?
    .map_err(|e| format!("connect failed ({err_ctx}): {e}"))?;
    eprintln!("[attach] connected {username}@{address}:{port}");

    // 终审 A1：注册前阶段（open_pty/request_shell，各限 10s）任一早退——限时
    // 超时或协议错——必须先 best-effort 显式 disconnect 再返回错误：russh
    // `Handle::drop` 不关连接，裸 drop 会让客户端 keepalive 任务继续跑、sshd
    // 上的僵尸 SSH 连接无限存活。错误文案原样保留（bench/台账对齐口径）。
    let mut channel = match open_shell_channel(&session, cols, rows).await {
        Ok(channel) => channel,
        Err(e) => return Err(close_after_failed_attach(e, session.disconnect()).await),
    };

    let id = format!("pty-{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
    let counters = Arc::new(SessionCounters::default());
    let cancel = Arc::new(Notify::new());
    let decoder = Arc::new(Mutex::new(StreamDecoder::new(initial_encoding)));
    let text_tail = Arc::new(TextTail::new());
    let writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(channel.make_writer())));
    // session 进 Arc（Task 10）：会话表项持一份（SFTP/传输按 rustId 复用同一
    // 连接），转发循环任务持另一份（退出统一 disconnect）。任一侧先行消亡，
    // 连接关闭会连带终止另一侧的操作（传输失败报协议错，journal 可续传）。
    let session = Arc::new(session);
    sessions.lock().unwrap().insert(
        id.clone(),
        SessionEntry {
            session: Arc::clone(&session),
            endpoint: format!("{address}:{port}"),
            writer: Arc::clone(&writer),
            counters: Arc::clone(&counters),
            decoder: Arc::clone(&decoder),
            text_tail: Arc::clone(&text_tail),
            cancel: Arc::clone(&cancel),
            sftp: Arc::new(Mutex::new(None)),
        },
    );

    // 读循环持有 channel 与 session；循环退出后统一收尾：清表（此后 session_stats
    // 报 no such session；drop_session 对已消失的 id 幂等报错，前端容忍）→
    // session-closed 事件（前端重连状态机的触发点）→ disconnect。
    // session 进 Arc：LANG 探测任务（独立 exec 通道）与收尾 disconnect 共享
    // （Arc 化已上移到会话表插入处，Task 10：SFTP 复用同一 Arc）。
    let session_id = id.clone();
    let probe_app = close_event.clone(); // 探测任务与收尾事件各持一份
    let probe_session = ui_face.then(|| Arc::clone(&session));
    // shell 集成注入任务与转发循环共享 writer/text_tail/session（探针看原始
    // 头部、探测走独立 exec 通道、片段写 PTY 输入端）。
    let inject_session = ui_face.then(|| Arc::clone(&session));
    let inject_writer = Arc::clone(&writer);
    let inject_tail = Arc::clone(&text_tail);
    tauri::async_runtime::spawn(async move {
        let reason = forward_pty_loop(
            &mut channel,
            &on_data,
            &counters,
            &decoder,
            &text_tail,
            &session_id,
            &cancel,
        )
        .await;
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

    // LANG 探测（Task 9 detect_hint）：独立 exec 通道异步跑，不阻塞 attach 返回、
    // 不进 PTY 数据流（探测输出不经转发循环）。仅正式 UI 面（probe_lang）。
    // 命中 GBK 家族 → `ottr://encoding-hint`（前端提示条「检测到 GBK，切换？」）；
    // UTF-8 兜底 / exec 失败 / 10s 超时 → 不提示（安全侧，绝不误报打扰）。
    if let Some(probe_session) = probe_session {
        let probe_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let probe =
                tokio::time::timeout(LANG_PROBE_TIMEOUT, probe_session.exec(LANG_PROBE_CMD)).await;
            match probe {
                Ok(Ok(out)) => {
                    let locale = String::from_utf8_lossy(&out.stdout);
                    let hint = ottr_term::Decoder::detect_hint(&locale);
                    eprintln!(
                        "[attach:{probe_id}] LANG probe {:?} -> {}",
                        locale.trim(),
                        hint.name()
                    );
                    if hint == Encoding::Gbk {
                        if let Some(app) = probe_app {
                            let _ = app.emit(
                                "ottr://encoding-hint",
                                EncodingHintPayload {
                                    id: probe_id,
                                    encoding: "gbk".into(),
                                },
                            );
                        }
                    }
                }
                Ok(Err(e)) => eprintln!("[attach:{probe_id}] LANG probe exec failed: {e}"),
                Err(_) => eprintln!("[attach:{probe_id}] LANG probe timed out"),
            }
        });
    }

    // shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库数据源）：仅正式 UI 面
    // 且 settings `shell.integration` 开（缺省开）。探测/幂等/下发全程异步，
    // 不阻塞 attach 返回；结果只打点（注入是增强面，失败不重试——重连即新会话
    // 重走本流程）。
    if let (Some(inj_session), true) = (inject_session, shell_integration) {
        let inject_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome =
                inject_shell_integration(&inject_writer, &inj_session, &inject_tail, true).await;
            eprintln!("[attach:{inject_id}] shell integration: {outcome:?}");
        });
    }
    Ok(id)
}

/// 注册前阶段：open_pty → request_shell（各限 10s，spike 台账限时打点）。
/// 只负责建通道与报错，**不做连接收尾**——调用方对 Err 必须经
/// [`close_after_failed_attach`] 先显式 disconnect（终审 A1）。错误文案是
/// bench/台账对齐口径（"open_pty timed out after 10s" 等），勿改。
async fn open_shell_channel(
    session: &SshSession,
    cols: u32,
    rows: u32,
) -> Result<russh::Channel<russh::client::Msg>, String> {
    let channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(cols, rows))
        .await
        .map_err(|_| "open_pty timed out after 10s".to_string())?
        .map_err(|e| format!("open_pty failed: {e}"))?;
    eprintln!("[attach] pty open ({cols}x{rows})");
    tokio::time::timeout(Duration::from_secs(10), channel.request_shell(true))
        .await
        .map_err(|_| "request_shell timed out after 10s".to_string())?
        .map_err(|e| format!("request_shell failed: {e}"))?;
    eprintln!("[attach] shell running");
    Ok(channel)
}

/// attach 注册前失败的统一收尾（终审 A1）：先 best-effort 显式 `disconnect`
/// 再原样带回错误。russh `Handle::drop` 只打 debug 日志**不关连接**（见
/// [`SshSession::disconnect`] 文档）——裸 drop 会让客户端 keepalive 任务继续
/// 跑、服务端僵尸 SSH 连接无限存活。disconnect 自身失败（连接已死/会话任务
/// 已退）只打日志，不吞原始错误。`disconnect` 拆成独立参数是回归测试 seam
/// （可观测断言断连被调用）；生产面调用恒传 `session.disconnect()`。
async fn close_after_failed_attach(
    err: String,
    disconnect: impl std::future::Future<Output = ottr_ssh::Result<()>>,
) -> String {
    if let Err(e) = disconnect.await {
        eprintln!("[attach] best-effort disconnect after failed attach: {e}");
    }
    err
}

/// 关闭会话（Task 7 Step 4 可中断性；Task 5+ 的「关标签」接线点）。
/// 同步移除会话表项（此后 `session_stats` 报 no such session），并通知转发循环
/// 取消——循环就地退出（批内残余字节随之丢弃，账目按 `pty_read − forwarded −
/// send_failed = 批内残余` 显式失衡），随后统一 disconnect、连接关闭。
#[tauri::command]
pub(crate) async fn drop_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let entry = state
        .sessions
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    entry.cancel.notify_one();
    Ok(())
}

/// 应用退出（A12，Task 14）：命令面板「退出」/ macOS 菜单 ⌘Q / 托盘菜单共用。
/// 走 `app.exit(0)` 而非窗口 close——close 会被 close-to-tray 拦截（隐藏窗口），
/// 退出必须绕过该拦截。
#[tauri::command]
pub(crate) fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    #[allow(unreachable_code)]
    Ok(())
}

/// 断开全部会话（A12，Task 14）：托盘菜单「断开全部」的实现核。
/// 逐条走 drop_session 同款语义（移除表项 + cancel 通知转发循环），循环退出后
/// 统一 disconnect 并发 `ottr://session-closed`(cancelled)——前端既有事件路径
/// 收尾（重连状态机对 cancelled 不反应，标签回 disconnected），**不另起跨窗口
/// 事件面**：会话表真源在 Rust 侧，从源头断开对隐藏窗口/多窗口都可靠。
pub(crate) fn disconnect_all_inner(sessions: &SessionMap) -> usize {
    let drained: Vec<(String, SessionEntry)> = sessions.lock().unwrap().drain().collect();
    let n = drained.len();
    for (_, entry) in &drained {
        entry.cancel.notify_one();
    }
    n
}

/// 断开全部会话（命令面：托盘动作共用同一实现核；返回断开条数）。
#[tauri::command]
pub(crate) fn session_disconnect_all(state: State<'_, AppState>) -> Result<usize, String> {
    Ok(disconnect_all_inner(&state.sessions))
}

/// 击键写入（输入方向，字节直传 PTY；spike 台账：传输编码允许 JSON 数组）。
#[tauri::command]
pub(crate) async fn write_session(
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
pub(crate) fn session_stats(
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionStats, String> {
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(&id)
        .map(|e| snapshot(&e.counters))
        .ok_or_else(|| format!("no such session: {id}"))
}

/// `session_tail` 单次取尾上限（1 MiB；诊断面 8KB，上限只防误传爆内存）。
const TAIL_MAX_BYTES: u32 = 1 << 20;

/// 会话输出尾部（Task 13，spec §6 AI 诊断取数面）：最后 `bytes` 字节的
/// 剥 ANSI 纯文本（UTF-8，\n 分行）。未知会话显式报错（标签已关/重连中）。
#[tauri::command]
pub(crate) fn session_tail(
    state: State<'_, AppState>,
    id: String,
    bytes: u32,
) -> Result<String, String> {
    let sessions = state.sessions.lock().unwrap();
    let entry = sessions
        .get(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    Ok(entry.text_tail.tail(bytes.min(TAIL_MAX_BYTES) as usize))
}

// ---------------------------------------------------------------------------
// 合批转发循环：有字节即写、窗口（默认 4ms）为最长等待；64KB 先到者立即 flush。
// 取消：select 在 `cancel`（drop_session）上，到即就地退出（打 `session dropped`）。
// 返回退出原因：Cancelled（drop_session）/ Closed（对端关闭）/ IpcFailed（前端
// 通道不可达）——`ottr://session-closed` 事件的载荷（Cancelled = 主动关闭，前端
// 重连状态机不应反应；Closed/IpcFailed = 连接丢失，触发自动重连）。
// ---------------------------------------------------------------------------

/// 会话关闭原因（`ottr://session-closed` 载荷，serde snake_case）。pub 伴随
/// pub 的 `forward_pty_loop` 直驱面（驱动脚本/example 读返回值用）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCloseReason {
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
/// 合批转发循环。pub = 驱动脚本/example 直驱面（T9 真夹具三段验证走本函数，
/// 与正式会话同一代码路径）；常规入口经 attach_*。
/// `text_tail`（Task 13）：每批解码后的文本剥 ANSI 副本入会话尾缓冲
/// （`session_tail` 命令的消费源，AI 诊断输出尾部 8KB）。
pub async fn forward_pty_loop(
    channel: &mut russh::Channel<russh::client::Msg>,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
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
                decoder,
                text_tail,
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
                flush_decoder_tail(&mut buf, decoder);
                if !paced_flush!() {
                    return SessionCloseReason::IpcFailed;
                }
            }
            Some(ChannelMsg::Close) | None => {
                flush_decoder_tail(&mut buf, decoder);
                paced_flush!();
                eprintln!("[batcher:{session_id}] pty closed");
                return SessionCloseReason::Closed;
            }
            _ => {}
        }
    }
}

/// 会话收尾（Eof/Close）：Decoder 残字结算（不完整序列 → 替换符，字节永不
/// 静默丢弃），结算文本排在本批之前转发。
fn flush_decoder_tail(buf: &mut Vec<u8>, decoder: &Mutex<StreamDecoder>) {
    let tail = decoder.lock().unwrap().finish();
    if !tail.is_empty() {
        let mut merged = tail.into_bytes();
        merged.extend_from_slice(buf);
        *buf = merged;
    }
}

/// flush 一批到前端。返回 false = send 失败，调用方**必须**终止转发循环。
///
/// 【M-2 失败策略（T4 台账挂账：此前 send 失败仅 eprintln，字节静默丢失且循环
/// 空转继续丢）】send 失败意味着前端通道已不可达（webview 关闭/通道断开），
/// 重试无意义、继续循环只会静默丢字节并烧 CPU。三步定案：
/// ① 失败字节计入显式计数 `send_failed_bytes/frames`——失衡可见，绝不静默；
/// ② 置会话级失败标志 `failed`（`session_stats` 可读，前端轮询可见）；
/// ③ 返回 false 让转发循环终止，连接随后统一 disconnect（进程端任务取消）。
///
/// 【Task 9 解码接入】send 前经会话 Decoder（合批后、IPC 前）：buf 里的原始
/// PTY 字节解码为 UTF-8 文本再发。批尾不完整序列滞留 Decoder（≤3B）随下批
/// 转发；解码输出为空（全部滞留）时不发空帧。forwarded_bytes 按解码后文本
/// 字节记账（有损变换 + 残字滞留，与 pty_read_bytes 不再逐批恒等，见字段文档）。
#[allow(clippy::too_many_arguments)] // decoder/text_tail/session_id 皆必需面
async fn flush_batch(
    buf: &mut Vec<u8>,
    deadline: &mut Option<Instant>,
    limit: usize,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
    session_id: &str,
) -> bool {
    *deadline = None;
    if buf.is_empty() {
        return true;
    }
    let raw = std::mem::replace(buf, Vec::with_capacity(limit));
    // 解码（会话当前编码；切换由 set_session_encoding 即时生效，从下个 chunk 起）
    let text = decoder.lock().unwrap().decode_chunk(&raw);
    if text.is_empty() {
        return true; // 全部为批尾残字，滞留待下批（不丢，不发空帧）
    }
    // 文本尾缓冲（Task 13）：剥离副本入环（AI 诊断取数面，不影响前端转发）
    text_tail.push(text.as_bytes());
    let n = text.len();
    let payload = text.into_bytes();
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
// shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库的数据源前提）
// ---------------------------------------------------------------------------
// 接线点 = attach_host_session 的 request_shell 成功后、首提示符消费前：注入
// 片段经 PTY writer 下发（作为一行命令发给交互 shell 执行，Phase 0 T6 spike
// 同源调用，asset = ottr_ssh::shell_integration::inject_for T6 真机验证终稿）。
// 四要素：
//   1. shell 探测：exec 通道 `echo $SHELL`（同 LANG 探测先例；bash→Bash、
//      zsh→Zsh、其他（fish/sh/nushell…）→ 跳过不报错）；
//   2. 幂等探测：等首输出（banner+首提示符）稳定后查 TextTail 原始头部是否
//      已有 OSC 133——用户自带集成则跳过（防双标记双入库）。**已知盲区
//      （挂账）**：首提示符晚于稳定窗的慢 shell 会漏判为未集成而重复注入；
//      前端 record.ts 的同秒去重兜底双 D（评审裁定 MVP 接受）；
//   3. 用户开关：settings `shell.integration`（缺省开，validate_setting 注册）；
//   4. 片段本身带 PROMPT_COMMAND/DEBUG 护栏（T6 终稿），重复注入天然幂等
//      （覆盖式 export / 重定义 precmd）。
// 注入行会回显在用户终端（一次性，T6 spike 同款已知行为；隐身注入挂账）。

/// `echo $SHELL` 输出 → ShellKind（basename 判定；其他 shell 显式 None）。
fn detect_shell_kind(shell_path: &str) -> Option<ottr_ssh::shell_integration::ShellKind> {
    let base = shell_path.trim().rsplit('/').next().unwrap_or("");
    match base {
        "bash" => Some(ottr_ssh::shell_integration::ShellKind::Bash),
        "zsh" => Some(ottr_ssh::shell_integration::ShellKind::Zsh),
        _ => None,
    }
}

/// 注入决策（可测纯函数）：开关开 + 识别的 shell + 未自带集成 → Some(kind)。
fn integration_decision(
    enabled: bool,
    kind: Option<ottr_ssh::shell_integration::ShellKind>,
    already_integrated: bool,
) -> Option<ottr_ssh::shell_integration::ShellKind> {
    if !enabled || already_integrated {
        return None;
    }
    kind
}

/// shell 集成注入结果（attach 打点 / fixture example 断言面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellIntegrationOutcome {
    /// 已下发片段（载荷 = shell 种类名）。
    Injected(&'static str),
    /// settings 开关关（调用方门卫，本函数不重复判）。
    SkippedDisabled,
    /// $SHELL 非 bash/zsh（fish/sh/…）——跳过不报错。
    SkippedNoShell,
    /// 首输出已见 OSC 133（用户自带集成，防双标记）。
    SkippedAlreadyIntegrated,
    /// exec 探测失败/超时（安全侧不注入，不打扰会话）。
    ProbeFailed,
}

/// 首输出稳定窗参数：banner+首提示符落定后 400ms 无增长即稳定；至少观察
/// 500ms；封顶 6s（慢链路兜底——超时按现状判定，盲区挂账见模块注释）。
const INJECT_STABLE_WINDOW: Duration = Duration::from_millis(400);
const INJECT_MIN_OBSERVE: Duration = Duration::from_millis(500);
const INJECT_MAX_WAIT: Duration = Duration::from_secs(6);

/// 等首输出稳定（原始头部无增长达稳定窗），返回（是否已见 133）。
async fn wait_initial_output(text_tail: &TextTail) -> bool {
    let start = Instant::now();
    let mut last_len = text_tail.raw_head_len();
    let mut stable_since: Option<Instant> = None;
    while start.elapsed() < INJECT_MAX_WAIT {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let len = text_tail.raw_head_len();
        if len != last_len {
            last_len = len;
            stable_since = None;
            continue;
        }
        let stable_for = stable_since.get_or_insert_with(Instant::now).elapsed();
        if start.elapsed() >= INJECT_MIN_OBSERVE && stable_for >= INJECT_STABLE_WINDOW {
            break;
        }
    }
    text_tail.raw_head_has_133()
}

/// shell 集成注入（生产 attach 与 fixture example 共用同一实现）：
/// 开关→shell 探测→幂等探测→片段下发。返回结果供打点/断言；失败不打扰
/// 会话（注入是增强面，缺了只是历史/诊断不工作）。
pub async fn inject_shell_integration(
    writer: &tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    probe_session: &SshSession,
    text_tail: &TextTail,
    enabled: bool,
) -> ShellIntegrationOutcome {
    if !enabled {
        return ShellIntegrationOutcome::SkippedDisabled;
    }
    // $SHELL 探测（exec 通道，不进 PTY 数据流；同 LANG 探测先例）
    let kind =
        match tokio::time::timeout(LANG_PROBE_TIMEOUT, probe_session.exec("echo $SHELL")).await {
            Ok(Ok(out)) => detect_shell_kind(&String::from_utf8_lossy(&out.stdout)),
            Ok(Err(_)) | Err(_) => return ShellIntegrationOutcome::ProbeFailed,
        };
    let Some(kind) = kind else {
        return ShellIntegrationOutcome::SkippedNoShell;
    };
    // 幂等探测：首输出已有 133 = 用户自带集成，跳过（防双标记双入库）
    if wait_initial_output(text_tail).await {
        return ShellIntegrationOutcome::SkippedAlreadyIntegrated;
    }
    // 片段下发（单行 + \r，交互 shell 在提示符处读入执行；T6 真机验证终稿）
    let snippet = ottr_ssh::shell_integration::inject_for(kind);
    let result = (async {
        use tokio::io::AsyncWriteExt;
        let mut w = writer.lock().await;
        w.write_all(snippet.as_bytes()).await?;
        w.write_all(b"\r").await?;
        Ok::<(), std::io::Error>(())
    })
    .await;
    match result {
        Ok(()) => ShellIntegrationOutcome::Injected(match kind {
            ottr_ssh::shell_integration::ShellKind::Bash => "bash",
            ottr_ssh::shell_integration::ShellKind::Zsh => "zsh",
        }),
        Err(e) => {
            eprintln!("[shell-integration] write failed: {e}");
            ShellIntegrationOutcome::ProbeFailed
        }
    }
}

// ---------------------------------------------------------------------------
// 测试（host key TOFU 分类 + 落账语义；无需 Tauri 运行时）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::state::RAW_HEAD_CAP;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;

    fn known_host(
        host_key: &str,
        fingerprint: &str,
        state: KnownHostState,
    ) -> ottr_vault::KnownHost {
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
        assert_eq!(
            host_key_ask_kind(Some(&first), "SHA256:fp"),
            Some("pending")
        );

        let verified = KnownHosts::verify(&vault, hk, "SHA256:fp").unwrap();
        assert_eq!(verified.state, KnownHostState::Ok);
        assert!(verified.verified);
        assert_eq!(
            host_key_ask_kind(Some(&verified), "SHA256:fp"),
            None,
            "ok 后静默放行"
        );

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
        assert_eq!(
            reaccepted.fingerprint, "SHA256:rotated",
            "接受后信任锚接管新指纹"
        );
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
        assert_eq!(
            host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"),
            Some("changed")
        );
        let flagged = KnownHosts::mark_changed(&vault, hk, "SHA256:B").unwrap();
        assert_eq!(flagged.state, KnownHostState::Changed);
        // 拒绝后重连：仍是 changed 强提醒（信任锚还在旧钥匙上，指纹依旧不一致）
        assert_eq!(
            host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"),
            Some("changed")
        );
        assert_eq!(KnownHosts::list(&vault).unwrap().len(), 1, "换钥不新增记录");
    }

    // --- Task 9（A9）：编码切换与转发路径解码 ---------------------------------

    /// flush_batch 转发路径解码：GBK 原始批 → IPC 帧是 UTF-8 文本（mock 会话流，
    /// Channel::new 捕获 Raw 帧）；forwarded 按解码后字节记账。
    #[test]
    fn flush_batch_decodes_gbk_batch_before_ipc() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        const GBK: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x20, 0x47, 0x42, 0x4B, 0x20, 0xCA,
            0xE4, 0xB3, 0xF6,
        ];
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&captured);
        let chan = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });
        let counters = SessionCounters::default();
        let text_tail = TextTail::new();
        // 默认 UTF-8：GBK 批 → 替换符乱码（ASCII 段保真）
        let decoder = Mutex::new(StreamDecoder::default());
        let mut buf = GBK.to_vec();
        let mut deadline = Some(Instant::now());
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            "t-utf8",
        ));
        assert!(ok);
        assert!(buf.is_empty());
        let out = captured.lock().unwrap().clone();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains('\u{FFFD}'),
            "utf-8 default must mojibake: {text:?}"
        );
        assert!(text.contains(" GBK "));
        assert_eq!(
            counters.forwarded_bytes.load(Ordering::Relaxed) as usize,
            text.len()
        );
        assert_eq!(counters.frames.load(Ordering::Relaxed), 1);

        // 切 GBK（set_session_encoding 的 Decoder 侧动作）→ 同批字节解出原文
        captured.lock().unwrap().clear();
        decoder.lock().unwrap().set_encoding(Encoding::Gbk);
        let mut buf = GBK.to_vec();
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            "t-gbk",
        ));
        assert!(ok);
        assert_eq!(
            String::from_utf8(captured.lock().unwrap().clone()).unwrap(),
            "中文测试 GBK 输出"
        );

        // 切回 UTF-8 后的批尾撕裂序列滞留（无空帧）；下批补齐重组
        captured.lock().unwrap().clear();
        decoder.lock().unwrap().set_encoding(Encoding::Utf8);
        let mut buf = vec![0xE4, 0xB8]; // 「中」的前 2/3（UTF-8 不完整序列）
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            "t-torn",
        ));
        assert!(ok);
        assert!(captured.lock().unwrap().is_empty(), "残批不发空帧");
        let mut buf = vec![0xAD, 0x21]; // 补齐「中」+ '!'
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            "t-torn2",
        ));
        assert!(ok);
        assert_eq!(
            String::from_utf8(captured.lock().unwrap().clone()).unwrap(),
            "中!"
        );
    }

    // --- shell 集成注入（Task 15 fix 1/5）：探测/决策/头部探针 ---------------

    /// $SHELL basename 判定表：bash/zsh 识别，其他（fish/sh/nushell/空）显式跳过。
    #[test]
    fn detect_shell_kind_supports_bash_and_zsh_only() {
        use ottr_ssh::shell_integration::ShellKind;
        assert_eq!(detect_shell_kind("/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/usr/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(detect_shell_kind("/usr/bin/zsh\n"), Some(ShellKind::Zsh));
        for skip in [
            "/bin/sh",
            "/usr/bin/fish",
            "/opt/homebrew/bin/nu",
            "",
            "/bin/dash",
        ] {
            assert_eq!(detect_shell_kind(skip), None, "{skip:?} must be skipped");
        }
    }

    /// 注入决策表：开关关 / 非目标 shell / 已自带集成（幂等）一律不注入。
    #[test]
    fn integration_decision_table() {
        use ottr_ssh::shell_integration::ShellKind;
        assert_eq!(
            integration_decision(true, Some(ShellKind::Bash), false),
            Some(ShellKind::Bash)
        );
        assert_eq!(
            integration_decision(true, Some(ShellKind::Zsh), false),
            Some(ShellKind::Zsh)
        );
        // 开关关 → 不注入（探测都省了）
        assert_eq!(
            integration_decision(false, Some(ShellKind::Bash), false),
            None
        );
        // 未识别 shell → 不注入不报错
        assert_eq!(integration_decision(true, None, false), None);
        // 已自带 133 集成（幂等探测）→ 不注入（防双标记双入库）
        assert_eq!(
            integration_decision(true, Some(ShellKind::Bash), true),
            None
        );
    }

    /// TextTail 原始头部探针：OSC 133 完整保留（剥 ANSI 前）、截满即停。
    #[test]
    fn text_tail_raw_head_keeps_osc_and_caps() {
        let tail = TextTail::new();
        assert!(!tail.raw_head_has_133());
        // 带颜色与 133 标记的原始批（flush_batch 喂入口径）
        tail.push(b"\x1b]133;D;0\x07\x1b]133;A\x07prompt$ \x1b[31mhi\x1b[0m\n");
        assert!(tail.raw_head_has_133(), "OSC 133 必须完整进头部探针");
        // 尾缓冲（AI 诊断面）不受影响：剥 ANSI 纯文本
        assert!(tail.tail(8192).contains("prompt$ hi"));
        // 截满即停：再喂大块不超上限
        let big = vec![b'x'; RAW_HEAD_CAP * 2];
        tail.push(&big);
        assert!(tail.raw_head_len() <= RAW_HEAD_CAP);
    }

    /// flush_batch 把解码后文本剥 ANSI 推进 TextTail：session_tail 的取数面。
    /// GBK 批解出的中文 + ANSI 颜色序列 → 尾缓冲里是纯文本。
    #[test]
    fn flush_batch_feeds_stripped_text_into_text_tail() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&captured);
        let chan = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });
        let counters = SessionCounters::default();
        let text_tail = TextTail::new();
        let decoder = Mutex::new(StreamDecoder::default());
        let mut deadline = Some(Instant::now());

        // 含 OSC133（133;D;1）+ CSI 颜色的批：前端照常转发（OSC 由 xterm 消费），
        // 尾缓冲里只剩纯文本行。
        let payload = b"\x1b]133;D;1\x07ls: cannot access '/x'\n\x1b[31mExit 1\x1b[0m\n";
        let mut buf = payload.to_vec();
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            4096,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            "t-tail",
        ));
        assert!(ok);
        // 前端转发面不受影响（剥 ANSI 前的原样解码文本）
        let forwarded = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert!(forwarded.contains("133;D;1"));
        // 尾缓冲：纯文本、无转义序列
        let tail = text_tail.tail(8192);
        assert_eq!(tail, "ls: cannot access '/x'\nExit 1");
        assert!(!tail.contains('\x1b'));
        // 字节口径截尾
        assert_eq!(text_tail.tail(6), "Exit 1");
        // 空环 / limit=0
        assert_eq!(TextTail::new().tail(100), "");
        assert_eq!(text_tail.tail(0), "");
    }

    // --- 终审 A1 回归：注册前早退路径必须显式 disconnect --------------------
    //
    // 进程内 mock sshd（russh::server::run_stream + 自持 accept 循环）：
    // 握手 + 密码认证放行；channel open 行为按用例配置——
    // * hang=true：handler pending 不回 → 客户端 open_pty 走 10s 超时路径（A1 字面路径）；
    // * hang=false：handler 直接返回、reply handle 落 drop = 自动拒绝（russh 默认
    //   语义）→ 客户端 open_pty 走快速协议错路径。
    // 断连观测点：每连接 `RunningSession` 完成 = 服务端观测到会话结束，落账
    // `closed`（显式 disconnect / 裸 drop 后 russh runner 自行收尾都会触发）。

    struct MockSshd {
        /// 认证成功次数（证明早退发生在建连之后）。
        connected: AtomicU64,
        /// 连接结束次数（服务端会话返回 = 连接被显式关闭的证据）。
        closed: AtomicU64,
    }

    struct MockSshHandler {
        hang_channel_open: bool,
        state: Arc<MockSshd>,
    }

    impl russh::server::Handler for MockSshHandler {
        // russh 要求 Error: From<russh::Error>；测试面直接复用 russh::Error
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn auth_succeeded(
            &mut self,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.state.connected.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            _reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            if self.hang_channel_open {
                std::future::pending().await
            }
            // 不碰 reply（落 drop）= 自动拒绝：客户端 open_pty 快速协议错
            Ok(())
        }
    }

    /// 起一个 mock sshd（127.0.0.1 随机端口），返回 (地址, 观测账本)。
    async fn spawn_mock_sshd(hang_channel_open: bool) -> (std::net::SocketAddr, Arc<MockSshd>) {
        let state = Arc::new(MockSshd {
            connected: AtomicU64::new(0),
            closed: AtomicU64::new(0),
        });
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .expect("mock sshd Ed25519 host key");
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ledger = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let cfg = Arc::clone(&config);
                let st = Arc::clone(&ledger);
                tauri::async_runtime::spawn(async move {
                    let handler = MockSshHandler {
                        hang_channel_open,
                        state: Arc::clone(&st),
                    };
                    if let Ok(session) = russh::server::run_stream(cfg, stream, handler).await {
                        let _ = session.await;
                    }
                    st.closed.fetch_add(1, Ordering::SeqCst);
                });
            }
        });
        (addr, state)
    }

    /// 对 mock sshd 走完整 attach（attach_host_session 的 open_and_register 骨架，
    /// 关闭 ui_face/shell 集成旁路，指纹全放行）。
    async fn attach_against_mock(
        addr: std::net::SocketAddr,
    ) -> (Result<String, String>, SessionMap) {
        let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
        let result = open_and_register(
            Arc::clone(&sessions),
            None,
            "127.0.0.1",
            addr.port(),
            "tester",
            AuthMethod::Password("pw".into()),
            Arc::new(|_| true), // 测试面：指纹全放行
            None,
            Duration::from_secs(5),
            "a1-test".into(),
            80,
            24,
            Channel::new(|_: InvokeResponseBody| Ok(())),
            Encoding::Utf8,
            false,
            false,
        )
        .await;
        (result, sessions)
    }

    /// A1 回归（wire 级，快速路径）：open_pty 协议错早退后不留任何活性残留——
    /// 服务端必须观测到会话结束（显式 disconnect 毫秒级可达）。注：russh 0.63.3
    /// 在最后一个 Handle 落 drop 后 runner 也会经 receiver-None 自行收尾，故本
    /// 断言不区分显式/隐式关闭；「先显式 disconnect 再返回错误」的契约由
    /// [`close_after_failed_attach_awaits_disconnect_then_returns_error`]（seam
    /// mock 断言）+ 单一 match 收尾臂承担，本例守住端到端下界：真实建连 →
    /// 早退报错（协议错文案）→ 会话表无残留 → 服务端会话 5s 内终结。
    #[test]
    fn attach_pre_register_failure_disconnects_connection() {
        tauri::async_runtime::block_on(async {
            let (addr, state) = spawn_mock_sshd(false).await;
            let (result, sessions) = attach_against_mock(addr).await;

            assert!(
                state.connected.load(Ordering::SeqCst) >= 1,
                "mock sshd 未收到成功认证的连接，早退路径未生效"
            );
            let err = result.expect_err("open_pty 被拒必须失败");
            assert!(err.starts_with("open_pty failed: "), "actual: {err}");
            assert!(sessions.lock().unwrap().is_empty(), "会话表不得残留");

            let deadline = Instant::now() + Duration::from_secs(5);
            while state.closed.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(
                state.closed.load(Ordering::SeqCst) >= 1,
                "注册前早退后服务端会话未终结：存在活性残留（A1 回归）"
            );
        });
    }

    /// A1 收尾核 seam 契约（mock 可观测 disconnect 调用）：任一注册前早退的
    /// 错误都必须先 await disconnect（断连恰好一次）再原样带回；disconnect
    /// 自身失败只吞错（生产面打日志），绝不顶替原始错误。
    #[test]
    fn close_after_failed_attach_awaits_disconnect_then_returns_error() {
        let calls = Arc::new(AtomicU64::new(0));
        // disconnect 成功面：断连被调用、错误文案零改动
        let c = Arc::clone(&calls);
        let err = tauri::async_runtime::block_on(close_after_failed_attach(
            "open_pty timed out after 10s".into(),
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        ));
        assert_eq!(err, "open_pty timed out after 10s");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // disconnect 失败面：吞错（打日志），原始错误原样穿透
        let c = Arc::clone(&calls);
        let err = tauri::async_runtime::block_on(close_after_failed_attach(
            "request_shell failed: boom".into(),
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(ottr_ssh::Error::AuthRejected)
            },
        ));
        assert_eq!(err, "request_shell failed: boom");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// A1 回归（字面路径）：open_pty 限时超时早退——错误文案精确对齐台账
    /// （ottr-bench 断言 "open_pty timed out after 10s"）+ 会话表无残留。
    /// 挂起的 handler 卡死服务端会话循环（无法观测断连），wire 级断连证据由
    /// [`attach_pre_register_failure_disconnects_connection`] 承担（同一 match
    /// 收尾臂，[`close_after_failed_attach`] 生产面恒传真 `session.disconnect()`）。
    #[test]
    fn attach_openpty_timeout_returns_error_without_residue() {
        tauri::async_runtime::block_on(async {
            let (addr, state) = spawn_mock_sshd(true).await;
            let (result, sessions) = attach_against_mock(addr).await;

            assert!(
                state.connected.load(Ordering::SeqCst) >= 1,
                "超时必须发生在建连成功之后（A1 指控的路径）"
            );
            assert_eq!(
                result.expect_err("open_pty 挂起必须超时"),
                "open_pty timed out after 10s"
            );
            assert!(sessions.lock().unwrap().is_empty(), "会话表不得残留");
        });
    }
}
