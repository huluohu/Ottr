//! 公钥部署（Task 6，A4）：ssh-copy-id 等价实现。
//!
//! 通道裁定（裁定 #3）：Task 10 的 SFTP 通道未到，走 **exec + shell 追加**——
//! `mkdir -p ~/.ssh && chmod … && (grep -qxF 已存在 || echo >> authorized_keys)`。
//! 幂等：部署前 `grep -qxF`（整行精确匹配）检查，已存在则跳过（回执
//! [`DeployStatus::AlreadyPresent`]）。SFTP 写入版列为 Task 10 后可选升级。
//!
//! 主机密钥策略沿用 [`HostKeyPolicy`] 回调——部署命令的调用方（desktop）
//! 决定接受策略；本模块只负责把会话记录到的服务器指纹带回回执
//! （[`DeployOutcome::host_key_fingerprint`]），供 TOFU 落库。

use crate::auth::{AuthMethod, HostKeyPolicy};
use crate::keygen::KeyAlgorithm;
use crate::russh_impl::connect;
use crate::{Error, Result};

/// 部署回执。`public_key_fingerprint` 是**被部署密钥**的指纹（与 KeyManager
/// 展示一致）；`host_key_fingerprint` 是部署会话中服务器出示的指纹（TOFU 线索）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeployOutcome {
    pub status: DeployStatus,
    pub public_key_fingerprint: String,
    pub public_key_algorithm: KeyAlgorithm,
    pub host_key_fingerprint: Option<String>,
}

/// 部署动作结果：`Added` = 本次追加；`AlreadyPresent` = 检测到已存在，跳过。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployStatus {
    Added,
    AlreadyPresent,
}

const MARKER: &str = "ottr-deploy:";

/// 单行 shell 字面量包裹（单引号内 `!` 安全；`'` 按 POSIX 拼接转义）。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 部署公钥到 `username@addr:port` 的 `~/.ssh/authorized_keys`（幂等）。
///
/// 认证方式任意（[`AuthMethod`] 三种均可）；MVP 部署场景由调用方约束为
/// password / key 两种。远端命令退出码非 0 或回执异常 → [`Error::Protocol`]。
pub async fn deploy_public_key(
    addr: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    host_key_cb: HostKeyPolicy,
    public_key: &str,
) -> Result<DeployOutcome> {
    let line = public_key.trim();
    if line.is_empty() || line.contains('\n') {
        return Err(Error::Protocol {
            message: "public key must be a single non-empty line".into(),
            source: None,
        });
    }
    let info = crate::keygen::parse_public_key(line).map_err(|e| Error::Protocol {
        message: format!("public key parse failed: {e}"),
        source: None,
    })?;
    let public_key_fingerprint = info.fingerprint;
    let algorithm = info.algorithm;

    // 单命令幂等部署：目录/权限就位 → grep 整行精确匹配 → 不存在才追加。
    // 回执标记经 stdout 传回（MARKER:added / MARKER:exists）。
    let quoted = shell_quote(line);
    let command = format!(
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys \
         && chmod 600 ~/.ssh/authorized_keys \
         && if grep -qxF -- {quoted} ~/.ssh/authorized_keys; then echo {m}:exists; \
         else echo {quoted} >> ~/.ssh/authorized_keys && echo {m}:added; fi",
        quoted = quoted,
        m = MARKER,
    );

    let session = connect(addr, port, username, auth, host_key_cb).await?;
    let output = session.exec(&command).await?;
    let host_key_fingerprint = session.host_key_fingerprint();
    let _ = session.disconnect().await;

    let status = if output.exit_status == Some(0) {
        let stdout = String::from_utf8_lossy(&output.stdout);
        match stdout.trim() {
            s if s.ends_with(&format!("{MARKER}:added")) => DeployStatus::Added,
            s if s.ends_with(&format!("{MARKER}:exists")) => DeployStatus::AlreadyPresent,
            other => {
                return Err(Error::Protocol {
                    message: format!("unexpected deploy output: {other:?}"),
                    source: None,
                });
            }
        }
    } else {
        return Err(Error::Protocol {
            message: format!(
                "remote deploy command failed (exit {:?}): {}",
                output.exit_status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            source: None,
        });
    };

    Ok(DeployOutcome {
        status,
        public_key_fingerprint,
        public_key_algorithm: algorithm,
        host_key_fingerprint,
    })
}
