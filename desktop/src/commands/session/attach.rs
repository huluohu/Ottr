//! attach 命令面（scripts 直传 / vault host 面 + 跳板链）+ 会话生命周期命令
//! （drop / quit / disconnect_all）。纯搬家拆分（原 session.rs 单文件）；连接
//! 注册骨架在 super::register，host key 策略在 super::hostkey，转发循环在
//! super::relay。

use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use ottr_ssh::AuthMethod;
use ottr_term::encoding::Encoding;
use ottr_vault::{Hosts, Settings};

use super::hostkey::{pinned_host_key_policy, tofu_host_key_policy};
use super::register::{open_and_register, register_opened};
use crate::commands::encoding::encoding_from_str;
use crate::commands::state::{AppState, KEEPALIVE_INTERVAL, SessionEntry, SessionMap};
use crate::keys;
use crate::vault::VaultState;

// ---------------------------------------------------------------------------
// 命令：attach（scripts 命令面 / 正式 host 面）/ write / stats / host key 裁定
// ---------------------------------------------------------------------------

/// 连接夹具（密码认证 + 指纹 pin）、开 PTY、起 shell，并启动合批转发循环。
/// 返回会话 id；PTY 输出经 `on_data`（二进制 Raw 帧）推给前端。
/// **scripts/ 驱动脚本命令面**（台账裁定）：直传参数 + Phase 0 语义原样保留
/// （15s 限时、指纹 pin、无 keepalive、无 session-closed 事件）；
/// 正式 UI 走 [`attach_host_session`]（vault 凭据 + TOFU + keepalive）。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // scripts 直传命令面（Phase 0 语义原样保留）
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
    let (policy, pinned) = pinned_host_key_policy(&host, port);
    open_and_register(
        state.sessions.clone(),
        None,
        None, // spike 驱动面直传连接：无 vault 主机行
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
///
/// 跳板链（Phase 2 Task 2）：host.jump_chain_id 非空时走 [`JumpSession`] 链式
/// 路径——链上每跳按各自 host 行解析端点/凭据 + 逐跳 TOFU（同语义，确认框带
/// 跳序号），PTY/SFTP/转发开在 target 会话上（SessionEntry.session 不变，
/// 消费面零改动）；全链会话由 SessionEntry.chain 持有，收尾统一拆除。
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
    let port = u16::try_from(host.port)
        .map_err(|_| format!("host id={host_id}: port {} out of range", host.port))?;
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
    // 端口转发自动启动挂钩（见下方 inspect）：session_id → 该主机 enabled 转发。
    let forward_up = |session_id: &String| {
        let sessions = Arc::clone(&state.sessions);
        let forwards = Arc::clone(&state.forwards);
        let vault = Arc::clone(&vault.0);
        let session_id = session_id.clone();
        tauri::async_runtime::spawn(async move {
            crate::commands::forward::on_session_up(
                &sessions,
                &forwards,
                &vault,
                &session_id,
                host_id,
            )
            .await;
        });
    };

    // --- 直连路径（现状语义不变）------------------------------------------
    let Some(chain_id) = host.jump_chain_id else {
        // 明文凭据只在此（Rust 侧）出现；key 凭据的临时 PEM 由 guard 持有至连接完成
        let (auth, _temp_key_guard) = keys::resolve_credential_auth(&vault, credential_id).await?;
        let policy = tofu_host_key_policy(
            Arc::clone(&vault.0),
            app.clone(),
            host_id,
            host.name.clone(),
            // TOFU 信任锚 = 网络端点（0004 迁移）：known_hosts 按端点记账，删主机
            // 重建 / 同端点多记录共享同一份信任（防 MITM 语义，见 host_endpoint_key）。
            ottr_vault::host_endpoint_key(&host.address, host.port),
            Arc::clone(&state.host_key_asks),
            None,
            None,
        );
        return open_and_register(
            state.sessions.clone(),
            Some(app),
            Some(host_id),
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
        // 端口转发自动启动（Phase 2 Task 1，B7）：失败不打断连接路径（面板
        // 错误灯可见）。spawn 脱离本命令的借用（State<'_> 非 'static）。
        .inspect(forward_up);
    };

    // --- 链式路径（Phase 2 Task 2）：JumpSession 持有全跳 -------------------
    let chain_row = ottr_vault::JumpChains::get(&vault.0, chain_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("jump chain id={chain_id} not found (host id={host_id})"))?;
    // 链上逐跳解析端点/凭据/TOFU（跳自己的 host 行 + 跳自己的信任锚；guard
    // 活到 connect 完成为止——key 凭据的临时 PEM 在认证期间必须存在）。
    let hop_specs = crate::commands::jump::build_hop_specs(
        &vault,
        &app,
        &state.host_key_asks,
        &chain_row.hops,
        host_id,
    )
    .await?;
    let (target_auth, _target_key_guard) =
        keys::resolve_credential_auth(&vault, credential_id).await?;
    let target_policy = tofu_host_key_policy(
        Arc::clone(&vault.0),
        app.clone(),
        host_id,
        host.name.clone(),
        ottr_vault::host_endpoint_key(&host.address, host.port),
        Arc::clone(&state.host_key_asks),
        None,
        Some(host_id),
    );
    // connect 限时 = 每跳问询窗口 60s + 网络预算 15s（问询期间握手合法挂起）。
    let budget = Duration::from_secs(75 * (hop_specs.hops.len() as u64 + 1));
    // remote(-R) 转发的入站路由挂进 target 连接（链式主机与直连主机同语义）。
    let forward_router = ottr_ssh::RemoteForwardRouter::new();
    let target_spec = ottr_ssh::HopSpec {
        host: host.address.clone(),
        port,
        username: username.clone(),
        auth: target_auth,
        host_key: target_policy,
    };
    let jump_session = tokio::time::timeout(
        budget,
        ottr_ssh::JumpSession::connect_with_keepalive(
            hop_specs.hops,
            target_spec,
            Some(KEEPALIVE_INTERVAL),
            Some(forward_router.clone()),
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "connect timed out after {}s (chain '{}')",
            budget.as_secs(),
            chain_row.name
        )
    })?
    .map_err(|e| format!("connect failed (chain '{}'): {e}", chain_row.name))?;
    eprintln!(
        "[attach] chained connected {}@{}:{} via '{}' ({} hops)",
        username,
        host.address,
        port,
        chain_row.name,
        jump_session.hop_count()
    );
    register_opened(crate::commands::state::RegisterArgs {
        sessions: state.sessions.clone(),
        close_event: Some(app),
        host_id: Some(host_id),
        session: jump_session.target(),
        chain: Some(Arc::new(jump_session)),
        forward_router,
        endpoint: format!("{}:{} (chain '{}')", host.address, port, chain_row.name),
        cols,
        rows,
        on_data,
        initial_encoding,
        ui_face: true,
        shell_integration,
    })
    .await
    .inspect(forward_up)
}

/// 关闭会话（Task 7 Step 4 可中断性；Task 5+ 的「关标签」接线点）。
/// 同步移除会话表项（此后 `session_stats` 报 no such session），并通知转发循环
/// 取消——循环就地退出（批内残余字节随之丢弃，账目按 `pty_read − forwarded −
/// send_failed = 批内残余` 显式失衡），随后统一 disconnect、连接关闭。
#[tauri::command]
pub(crate) async fn drop_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // SSH 会话优先（含 PTY/转发循环收尾）；FTP 文件会话（Phase 2 Task 5）=
    // 移除表项 + 优雅 QUIT（best-effort，无转发循环可拆）。
    if let Some(entry) = state.sessions.lock().unwrap().remove(&id) {
        entry.cancel.notify_one();
        return Ok(());
    }
    if let Some(entry) = state.ftp_sessions.lock().unwrap().remove(&id) {
        tauri::async_runtime::spawn(async move {
            entry.client.quit().await;
        });
        return Ok(());
    }
    Err(format!("no such session: {id}"))
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
    let mut n = disconnect_all_inner(&state.sessions);
    // FTP 文件会话同语义收尾（无转发循环，QUIT 即可）
    let drained: Vec<crate::commands::state::FtpSessionEntry> = state
        .ftp_sessions
        .lock()
        .unwrap()
        .drain()
        .map(|(_, e)| e)
        .collect();
    n += drained.len();
    for entry in drained {
        tauri::async_runtime::spawn(async move {
            entry.client.quit().await;
        });
    }
    Ok(n)
}
