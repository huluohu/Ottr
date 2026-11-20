//! FTP/FTPS 会话命令域（Phase 2 Task 5，Global Constraint：新命令进本目录对应域）。
//!
//! FTP/FTPS 主机 = **纯文件传输会话**（无 PTY/终端面）：attach 只建控制连接并
//! 注册 [`FtpSessionEntry`]，FilePanel 命令面（commands/transfer.rs 的
//! `file_client_for` 分派）与传输队列照常消费。凭据纪律与 SSH 路径同款：
//! host_id 进来，明文只在 Rust 侧 reveal——前端永不接触明文。
//!
//! 认证面（简报裁定：FTP 凭据 = 密码型）：
//! * 凭据 kind ∈ {password, ftp, ftps}（`is_password_like`）→ secret = 口令；
//! * key/totp 凭据显式拒绝（FTP 客户端不支持 pubkey/TOTP 交互认证）；
//! * 未绑定凭据 = 匿名登录（username/password 兜底 anonymous，RFC 532 惯例）。
//!
//! TLS：ftps 走显式 AUTH TLS + [`ottr_transfer::ftp::FtpsPolicy::default`]
//! （accept_invalid_certs=false 正常校验）；自签/内网证书的放开旋钮挂账
//! （HostForm 暴露属 UI 任务，本期默认安全侧）。
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use ottr_transfer::ftp::{FtpClient, FtpsPolicy};
use ottr_vault::{CredentialKind, Credentials, Hosts, SecretField};

use super::state::{AppState, FtpSessionEntry, FtpSessionMap, SESSION_SEQ};
use crate::vault::VaultState;

/// 连接超时（FTP 控制连接 dial；sshd 夹具路径 15s 同量级，取宽一些覆盖
/// TLS 握手）。
const FTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 死活检测心跳间隔（robustness 审计 P1）：此前 FTP 会话注册后无任何断线
/// 事件面——服务器断连/半开之后文件面板每步都报错且标签永不回收。30s 与
/// 传输层 keepalive（60s）同量级，探测成本一条 MLST 往返。
const FTP_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// 单次心跳探测限时：半开连接（TCP 活着但对端不回）不挂死心跳任务——
/// 到点按死亡处置（与 SSH 侧 keepalive max 3 × 60s 相比激进，但 FTP 无
/// 传输层 keepalive，只有应用层探测可用；误杀 = 面板重连，半开不杀 =
/// 面板永久 wedged）。
const FTP_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(10);

/// 从 vault 主机条目发起 FTP/FTPS 连接（文件会话；前端只传 host_id）。
/// 返回会话 id（`ftpsess-N`），后续 sftp_* 面板命令 / 传输 / drop 按它路由。
#[tauri::command]
pub(crate) async fn ftp_attach_host_session(
    app: AppHandle,
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    host_id: i64,
) -> Result<String, String> {
    vault.0.ensure_unlocked().map_err(|e| e.to_string())?;
    let host = Hosts::get(&vault.0, host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("host id={host_id} not found"))?;
    if host.protocol == ottr_vault::HostProtocol::Ssh {
        return Err(format!(
            "host id={host_id} is an SSH host (use attach_host_session)"
        ));
    }

    // 凭据解析：明文只在此出现。无绑定 = 匿名；key/totp = 显式拒绝。
    let (username, password) = match host.credential_id {
        None => ("anonymous".to_string(), "anonymous".to_string()),
        Some(credential_id) => {
            let credential = Credentials::get(&vault.0, credential_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("credential id={credential_id} not found"))?;
            if !matches!(
                credential.kind,
                CredentialKind::Password | CredentialKind::Ftp | CredentialKind::Ftps
            ) {
                return Err(format!(
                    "credential id={credential_id} kind '{}' cannot authenticate FTP \
                     (password-like credentials only)",
                    credential.kind.as_str()
                ));
            }
            let secret = Credentials::reveal(&vault.0, credential_id, SecretField::Secret)
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            (
                host.username.clone().unwrap_or_else(|| "anonymous".into()),
                secret,
            )
        }
    };
    let port = u16::try_from(host.port)
        .map_err(|_| format!("host id={host_id}: port {} out of range", host.port))?;

    let client = {
        let connect_fut = async {
            match host.protocol {
                ottr_vault::HostProtocol::Ftp => {
                    FtpClient::connect(&host.address, port, &username, &password).await
                }
                ottr_vault::HostProtocol::Ftps => {
                    FtpClient::connect_ftps(
                        &host.address,
                        port,
                        &username,
                        &password,
                        FtpsPolicy::default(),
                    )
                    .await
                }
                ottr_vault::HostProtocol::Ssh => unreachable!("checked above"),
            }
        };
        tokio::time::timeout(FTP_CONNECT_TIMEOUT, connect_fut)
            .await
            .map_err(|_| {
                format!(
                    "ftp connect timed out after {}s",
                    FTP_CONNECT_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| e.to_string())?
    };

    let id = format!(
        "ftpsess-{}",
        SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    eprintln!(
        "[ftp-attach] {} {}@{}:{} as '{id}'",
        host.protocol.as_str(),
        username,
        host.address,
        port
    );
    let heartbeat_cancel = CancellationToken::new();
    let transfer_gate = Arc::new(tokio::sync::Mutex::new(()));
    let client = Arc::new(client);
    state.ftp_sessions.lock().unwrap().insert(
        id.clone(),
        FtpSessionEntry {
            client: Arc::clone(&client),
            endpoint: format!("{}:{}", host.address, port),
            heartbeat_cancel: heartbeat_cancel.clone(),
            transfer_gate: Arc::clone(&transfer_gate),
        },
    );
    spawn_ftp_heartbeat(
        app,
        Arc::clone(&state.ftp_sessions),
        id.clone(),
        client,
        heartbeat_cancel,
        transfer_gate,
    );
    Ok(id)
}

/// `ottr://session-closed` 载荷（前端 types.ts SessionClosedPayload 同构；
/// local_term 的 SessionClosedEvent 同款——relay 的 SessionClosedPayload 是
/// session 模块私有，命令域各自持有同形结构）。`reason: "closed"` 与 SSH
/// 对端关闭一致：前端 onSessionClosed 按 rustId（= ftpsess-N）反查命中既有
/// 重连状态机。
#[derive(Clone, serde::Serialize)]
struct FtpSessionClosedPayload {
    id: String,
    reason: &'static str,
}

/// FTP 会话死活检测心跳（robustness 审计 P1）：
/// * 每 30s 经客户端公开 API 探测一条控制连接往返（`exists(".")` = MLST；
///   `realpath` 是纯本地路径展开不碰网络，不能作探测）；
/// * 探测自带限时（半开不挂死心跳）；与面板操作共用客户端 tokio Mutex——
///   MLST 极短，排队可接受；
/// * **传输在途跳过本轮探测**（transfer_gate 被持）：FTP 下载/上传整程持
///   客户端互斥锁，探测等锁会撞探测限时把活会话误杀；
/// * 探测失败 → 表项移除 + `ottr://session-closed`(closed)：前端按 rustId
///   命中既有重连状态机（与 SSH 断线同语义），表项泄漏同时收敛。
fn spawn_ftp_heartbeat(
    app: AppHandle,
    sessions: FtpSessionMap,
    id: String,
    client: Arc<FtpClient>,
    cancel: CancellationToken,
    transfer_gate: Arc<tokio::sync::Mutex<()>>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(FTP_HEARTBEAT_INTERVAL) => {}
                _ = cancel.cancelled() => return, // 标签关闭/断开全部：先取消再 QUIT
            }
            // 传输在途（闸门被持）→ 本轮跳过探测（误杀防线，见 FtpSessionEntry
            // transfer_gate 文档）。try_lock 失败即让行，不排队。
            let Ok(_gate) = transfer_gate.try_lock() else {
                continue;
            };
            // 探测限时：半开连接 TCP 层不死，无限时的心跳会在一次 send 上
            // 挂到操作系统超时（分钟级）——心跳任务自身绝不能成为泄漏面。
            let probe = tokio::time::timeout(FTP_HEARTBEAT_TIMEOUT, client.exists(".")).await;
            match probe {
                Ok(Ok(_)) => {} // 服务器应答（存在与否都是活连接）
                Ok(Err(e)) => {
                    eprintln!("[ftp:{id}] heartbeat failed: {e}; session closed");
                    sessions.lock().unwrap().remove(&id);
                    let _ = app.emit(
                        "ottr://session-closed",
                        FtpSessionClosedPayload {
                            id: id.clone(),
                            reason: "closed",
                        },
                    );
                    return;
                }
                Err(_) => {
                    eprintln!(
                        "[ftp:{id}] heartbeat timed out after {}s; session closed",
                        FTP_HEARTBEAT_TIMEOUT.as_secs()
                    );
                    sessions.lock().unwrap().remove(&id);
                    let _ = app.emit(
                        "ottr://session-closed",
                        FtpSessionClosedPayload {
                            id: id.clone(),
                            reason: "closed",
                        },
                    );
                    return;
                }
            }
        }
    });
}

/// 取 FTP 会话客户端（不存在/已断开显式报错）。pub(crate)：transfer.rs 分派复用。
pub(crate) async fn ftp_for(state: &AppState, id: &str) -> Result<Arc<FtpClient>, String> {
    Ok(Arc::clone(
        &state
            .ftp_sessions
            .lock()
            .unwrap()
            .get(id)
            .ok_or_else(|| format!("no such ftp session: {id}"))?
            .client,
    ))
}

/// 取 FTP 会话端点（journal scope 身份）。
pub(crate) fn ftp_endpoint(state: &AppState, id: &str) -> Result<String, String> {
    Ok(state
        .ftp_sessions
        .lock()
        .unwrap()
        .get(id)
        .ok_or_else(|| format!("no such ftp session: {id}"))?
        .endpoint
        .clone())
}

/// 取 FTP 会话的传输闸门（sftp_download / sftp_upload 的 FTP 分支在传输任务
/// 里整程持有——心跳据此跳过探测，见 FtpSessionEntry.transfer_gate 文档）。
pub(crate) async fn ftp_transfer_gate(
    state: &AppState,
    id: &str,
) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    Ok(Arc::clone(
        &state
            .ftp_sessions
            .lock()
            .unwrap()
            .get(id)
            .ok_or_else(|| format!("no such ftp session: {id}"))?
            .transfer_gate,
    ))
}
