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

use tauri::State;

use ottr_transfer::ftp::{FtpClient, FtpsPolicy};
use ottr_vault::{CredentialKind, Credentials, Hosts, SecretField};

use super::state::{AppState, FtpSessionEntry, SESSION_SEQ};
use crate::vault::VaultState;

/// 连接超时（FTP 控制连接 dial；sshd 夹具路径 15s 同量级，取宽一些覆盖
/// TLS 握手）。
const FTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// 从 vault 主机条目发起 FTP/FTPS 连接（文件会话；前端只传 host_id）。
/// 返回会话 id（`ftpsess-N`），后续 sftp_* 面板命令 / 传输 / drop 按它路由。
#[tauri::command]
pub(crate) async fn ftp_attach_host_session(
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
    state.ftp_sessions.lock().unwrap().insert(
        id.clone(),
        FtpSessionEntry {
            client: Arc::new(client),
            endpoint: format!("{}:{}", host.address, port),
        },
    );
    Ok(id)
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
