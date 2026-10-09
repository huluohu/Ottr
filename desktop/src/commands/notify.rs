//! SMTP 通知命令域（Phase 3 Task 3，B5 渠道全矩阵——12 渠道中唯一的 Rust
//! 适配器）：`smtp_send` 单命令，发送与「发送测试」共用（测试 = 前端用固定
//! 测试主题/正文调同一命令，真发真实邮件）。
//!
//! 【选型裁定】（task-3 简报裁定 #2，spec §7「SMTP 走 Rust 侧 lettre 更稳，
//! 二选一 spike 定」）：选 **Rust lettre**，不走 nodemailer——
//! * nodemailer 需要 Node 运行时，Tauri 前端是 webview（无 Node），引入
//!   sidecar 换一个 SMTP 发送纯属浪费；
//! * webview 无裸 TCP socket（fetch 只有 HTTP/S），SMTP 协议面必须落在
//!   Rust（或不做）；
//! * lettre 0.11 tokio1 + native-tls：TLS 栈与 ottr-transfer 的 FTPS
//!   （async-native-tls）同源，不引入第二套 TLS 依赖树。
//!
//! 【安全面】config（含 SMTP 密码）密封在 vault notify_channels.config_enc
//! （0014，已登记 scan_registry）；明文只在本次发送的内存中短暂存在（前端
//! reveal 后经 invoke 参数传入），不落日志。前端永不持久化明文。
//!
//! 【超时】连接/发送整体 30s 上限（tokio::time::timeout）——SMTP 服务器不可
//! 达时命令在半分钟内失败返回，前端「发送测试」按钮不悬挂。
use std::time::Duration;

use lettre::{
    AsyncSmtpTransport, AsyncTransport, Tokio1Executor,
    transport::smtp::authentication::Credentials,
};
use serde::Deserialize;

/// SMTP 连接配置（notify_channels.config_enc 内 `smtp` 类的字段面，与
/// src/notify/channels/types.ts 的 `SmtpConfig` 同构 snake_case）。
#[derive(Debug, Clone, Deserialize)]
pub struct SmtpConfig {
    /// SMTP 主机名（如 smtp.example.com）。
    pub host: String,
    /// 端口（465=隐式 TLS / 587=STARTTLS / 25=明文，按 mode 配对）。
    pub port: u16,
    /// 认证用户名（缺省 = 无认证——内网 relay 场景）。
    pub username: Option<String>,
    /// 认证密码（密文出库后经 invoke 参数传入；无认证时缺省）。
    pub password: Option<String>,
    /// 发件人（`a@b` 或 `Name <a@b>`；lettre Mailbox 解析）。
    pub from: String,
    /// TLS 模式："ssl"（隐式 TLS，默认）| "starttls" | "none"（内网明文）。
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "ssl".into()
}

/// 单次发送的硬超时（连接 + 会话整体；SMTP 不可达不悬挂 UI）。
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// 按 mode 构建 transport（credentials 仅在用户名非空时挂）。
fn build_transport(config: &SmtpConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let mut builder = match config.mode.as_str() {
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
            .map_err(|e| format!("smtp starttls relay: {e}"))?,
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host),
        // 缺省按隐式 TLS（465 惯例端口由调用方显式给 port）
        _ => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
            .map_err(|e| format!("smtp relay: {e}"))?,
    };
    builder = builder.port(config.port).timeout(Some(SEND_TIMEOUT));
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        builder = builder.credentials(Credentials::new(
            user.to_string(),
            config.password.clone().unwrap_or_default(),
        ));
    }
    Ok(builder.build())
}

/// 发送一封邮件（通知分发与「发送测试」共用）。`to` 支持逗号分隔多收件人
/// （`a@b, Name <c@d>`）；单收件人解析失败/服务器拒绝显式报错（前端错误面）。
#[tauri::command]
pub(crate) async fn smtp_send(
    config: SmtpConfig,
    to: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    use lettre::message::Mailbox;
    use std::str::FromStr as _;

    let from = Mailbox::from_str(&config.from).map_err(|e| format!("invalid from address: {e}"))?;
    let mut message = lettre::Message::builder().from(from);
    for raw in to.split(',') {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let mailbox =
            Mailbox::from_str(raw).map_err(|e| format!("invalid to address {raw:?}: {e}"))?;
        message = message.to(mailbox);
    }
    let email = message
        .subject(&subject)
        .body(body)
        .map_err(|e| format!("build mail: {e}"))?;

    let mailer = build_transport(&config)?;
    let sent = tokio::time::timeout(SEND_TIMEOUT, AsyncTransport::send(&mailer, email))
        .await
        .map_err(|_| "smtp send timed out (30s)".to_string())?;
    sent.map_err(|e| format!("smtp send: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(mode: &str) -> SmtpConfig {
        SmtpConfig {
            host: "smtp.example.com".into(),
            port: 465,
            username: Some("user".into()),
            password: Some("pass".into()),
            from: "Ottr <ottr@example.com>".into(),
            mode: mode.into(),
        }
    }

    /// mode 分派：ssl（缺省）/ starttls / none 各自可构建 transport；
    /// 未知 mode 按隐式 TLS 兜底（与 serde default 同口径）。
    #[test]
    fn build_transport_accepts_all_tls_modes() {
        for mode in ["ssl", "starttls", "none", "whatever-falls-back"] {
            assert!(
                build_transport(&config(mode)).is_ok(),
                "mode={mode} 应可构建"
            );
        }
    }

    /// 无认证（username 空/None）不挂 credentials——内网 relay 场景不因空密码报错。
    #[test]
    fn build_transport_without_credentials_ok() {
        let mut c = config("ssl");
        c.username = None;
        assert!(build_transport(&c).is_ok());
        c.username = Some("".into());
        assert!(build_transport(&c).is_ok());
    }

    /// config serde 面：mode 缺省 ssl（TS 侧旧配置/精简配置兼容）。
    #[test]
    fn smtp_config_defaults_mode_to_ssl() {
        let c: SmtpConfig =
            serde_json::from_str(r#"{"host":"s.example.com","port":587,"from":"a@b.com"}"#)
                .unwrap();
        assert_eq!(c.mode, "ssl");
        assert!(c.username.is_none());
    }
}
