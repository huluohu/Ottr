//! 密钥管理 Tauri 命令（Task 6，A4）——ottr-ssh::keygen / ottr-ssh::deploy 的接线层。
//!
//! 职责边界：
//!   * keygen 纯计算不落盘，本模块负责 IO（导出写文件 0600）与凭据联动
//!     （部署的认证材料**服务端**经 [`ottr_vault::Credentials::reveal`] 单点取回，
//!     不经前端明文转发）；
//!   * 错误一律 `String`（KeyError/Error::Display 面向用户可读），与 vault.rs 约定一致；
//!   * 命令名 = api.ts `keys` 段 invoke 契约名（snake_case 注册）。
//!
//! 裁定 #2（导出确认）：主密码模式 T11 才有，本任务导出确认 =
//! **显式点击 + 加密私钥需先输入正确 passphrase**（前端经 `key_inspect` 验证通过
//! 才允许调 `key_export`）；未加密私钥仅显式点击即可。T11 落主密码后升级。
//! 裁定 #3（部署策略）：TOFU 首连指纹确认对话框 Task 7 消费，部署 MVP 的主机
//! 密钥策略为「接受 `SHA256:` 指纹并记录回执」——观察到的指纹经 known_hosts
//! upsert 落库（A3 联动），T7 接入真 TOFU 后收紧。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use ottr_ssh::{AuthMethod, DeployStatus, deploy_public_key};
use ottr_vault::{Credentials, KnownHosts, KnownHostState, SecretField};

use crate::vault::VaultState;

type CmdResult<T> = Result<T, String>;

fn vault_err(e: ottr_vault::VaultError) -> String {
    e.to_string()
}

// --- 生成 / 解析 ------------------------------------------------------------

/// 生成新密钥。`algorithm` ∈ {ed25519, ecdsa-p256, rsa}（KeyAlgorithm::FromStr），
/// `passphrase` 空/缺省 = 不加密。RSA 固定 4096 位（ssh-key 内置）。
/// async + spawn_blocking：生成是 CPU 密集操作（RSA debug 下可达数十秒），
/// 不占主线程。
#[tauri::command]
pub async fn key_generate(
    algorithm: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> CmdResult<ottr_ssh::KeyMaterial> {
    let alg: ottr_ssh::KeyAlgorithm = algorithm
        .parse()
        .map_err(|e: ottr_ssh::KeyError| e.to_string())?;
    let comment = comment.unwrap_or_else(|| "ottr".into());
    tauri::async_runtime::spawn_blocking(move || {
        ottr_ssh::keygen::generate(alg, passphrase.as_deref(), &comment).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// 解析 openssh 私钥 PEM（导入预览 / 导出 passphrase 校验）。
/// 口令缺失/错误 → 明确错误串（KeyError::PassphraseRequired::Display）。
#[tauri::command]
pub fn key_inspect(pem: String, passphrase: Option<String>) -> CmdResult<ottr_ssh::KeyMaterial> {
    ottr_ssh::keygen::inspect(&pem, passphrase.as_deref()).map_err(|e| e.to_string())
}

// --- 导出 -------------------------------------------------------------------

/// 导出私钥 PEM 到文件（0600）。`path` 缺省写下载目录 `ottr-key-<时间戳>.pem`，
/// 返回落盘路径。**调用方契约（裁定 #2）**：加密私钥必须先经 `key_inspect`
/// 验证 passphrase 通过后才可调用——本命令不再重复校验（校验与写入分离，
/// T11 主密码模式接入时在调用方收口）。
#[tauri::command]
pub fn key_export(app: AppHandle, pem: String, path: Option<String>) -> CmdResult<String> {
    use std::io::Write as _;
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = app
                .path()
                .download_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| format!("resolve export dir: {e}"))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            dir.join(format!("ottr-key-{ts}.pem"))
        }
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // 0600 先建再写：私钥文件不经历 0644 中间态
    let mut f = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&target)
        }
        #[cfg(not(unix))]
        {
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&target)
        }
    }
    .map_err(|e| format!("open {}: {e}", target.display()))?;
    f.write_all(pem.as_bytes())
        .and_then(|_| f.flush())
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

// --- 公钥部署 ---------------------------------------------------------------

/// 部署回执（serde snake_case → TS `KeyDeployReport`）。
#[derive(serde::Serialize)]
pub struct KeyDeployReport {
    pub status: DeployStatus,
    pub public_key_fingerprint: String,
    pub host_key_fingerprint: Option<String>,
    pub known_hosts_state: KnownHostState,
}

/// 部署认证材料：从 vault 服务端解析（明文不过前端）。
/// 返回 AuthMethod 与**临时私钥文件的路径**（key 认证时非空，
/// 调用方在部署结束后负责删除）。
async fn resolve_deploy_auth(
    vault: &VaultState,
    auth_credential_id: i64,
) -> Result<(AuthMethod, Option<PathBuf>), String> {
    let vault = vault.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(AuthMethod, Option<PathBuf>), String> {
        let credential = Credentials::get(&vault, auth_credential_id).map_err(vault_err)?
            .ok_or_else(|| format!("credential id={auth_credential_id} not found"))?;
        match credential.kind {
            ottr_vault::CredentialKind::Password => {
                let secret = Credentials::reveal(&vault, auth_credential_id, SecretField::Secret).map_err(vault_err)?
                    .ok_or_else(|| "password credential has no secret".to_string())?;
                Ok((AuthMethod::Password(secret), None))
            }
            ottr_vault::CredentialKind::Key => {
                let pem = Credentials::reveal(&vault, auth_credential_id, SecretField::Secret).map_err(vault_err)?
                    .ok_or_else(|| "key credential has no private key".to_string())?;
                let passphrase =
                    Credentials::reveal(&vault, auth_credential_id, SecretField::Passphrase).map_err(vault_err)?;
                // 临时文件 0600：AuthMethod::Key 的 path 语义要求；用后即删
                let mut path = std::env::temp_dir();
                path.push(format!(
                    "ottr-deploy-{}-{}.pem",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ));
                {
                    use std::io::Write as _;
                    #[cfg(unix)]
                    let mut f = {
                        use std::os::unix::fs::OpenOptionsExt;
                        std::fs::OpenOptions::new()
                            .write(true)
                            .create(true)
                            .truncate(true)
                            .mode(0o600)
                            .open(&path)
                    }
                    .map_err(|e| format!("temp key file: {e}"))?;
                    #[cfg(not(unix))]
                    let mut f = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .open(&path)
                        .map_err(|e| format!("temp key file: {e}"))?;
                    f.write_all(pem.as_bytes())
                        .and_then(|_| f.flush())
                        .map_err(|e| format!("temp key file write: {e}"))?;
                }
                Ok((AuthMethod::Key { path: path.clone(), passphrase }, Some(path)))
            }
            ottr_vault::CredentialKind::Totp => Err(
                "totp credential cannot authenticate deployment (keyboard-interactive unsupported for deploy)".to_string(),
            ),
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// 把公钥部署到目标主机（exec 追加 authorized_keys，幂等，见 ottr-ssh::deploy）。
/// `auth_credential_id` 指向 password/key 凭据；TOTP 认证目标机不在 MVP
/// 部署支持面（报告已注明）。
#[tauri::command]
pub async fn key_deploy(
    state: State<'_, VaultState>,
    auth_credential_id: i64,
    address: String,
    port: i64,
    username: String,
    public_key: String,
) -> CmdResult<KeyDeployReport> {
    let (auth, temp_key) = resolve_deploy_auth(&state, auth_credential_id).await?;
    let port = u16::try_from(port).map_err(|_| format!("port {port} out of range"))?;

    // 裁定 #3：部署 MVP 主机密钥策略 = 接受 SHA256: 指纹（观察值随回执返回并落
    // known_hosts）；TOFU 确认对话框 Task 7 收紧。
    let policy: ottr_ssh::HostKeyPolicy =
        std::sync::Arc::new(|fingerprint: &str| fingerprint.starts_with("SHA256:"));

    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        deploy_public_key(&address, port, &username, auth, policy, &public_key),
    )
    .await
    .map_err(|_| "deploy timed out after 30s".to_string())?
    .map_err(|e| e.to_string())?;

    // 临时私钥用完即删（成功/失败路径都要走）
    if let Some(path) = temp_key {
        let _ = std::fs::remove_file(&path);
    }

    // A3 联动：部署会话观察到的服务器指纹按 TOFU 首见落库（已存在则原样返回）
    let known_hosts_state = match &outcome.host_key_fingerprint {
        Some(fp) => KnownHosts::upsert(&state.0, fp).map_err(vault_err).map(|k| k.state)?,
        None => KnownHostState::Pending,
    };

    Ok(KeyDeployReport {
        status: outcome.status,
        public_key_fingerprint: outcome.public_key_fingerprint,
        host_key_fingerprint: outcome.host_key_fingerprint,
        known_hosts_state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_generate_rejects_unknown_algorithm() {
        assert!(tauri::async_runtime::block_on(key_generate("dsa".into(), None, None)).is_err());
        assert!(tauri::async_runtime::block_on(key_generate("".into(), None, None)).is_err());
    }

    #[test]
    fn key_generate_ed25519_produces_material_and_inspect_roundtrips() {
        let m = tauri::async_runtime::block_on(key_generate(
            "ed25519".into(),
            None,
            Some("t".into()),
        ))
        .unwrap();
        assert_eq!(m.algorithm.as_str(), "ed25519");
        assert!(m.fingerprint.starts_with("SHA256:"));
        assert!(m.public_openssh.starts_with("ssh-ed25519 "));
        let back = key_inspect(m.private_openssh.clone(), None).unwrap();
        assert_eq!(back.fingerprint, m.fingerprint);
    }
}
