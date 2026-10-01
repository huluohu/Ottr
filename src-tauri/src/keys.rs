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

use ottr_ssh::{deploy_public_key, AuthMethod, DeployStatus};
use ottr_vault::{Credentials, KnownHostState, KnownHosts, SecretField};

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
/// spawn_blocking（评审 M-1）：加密钥解析含 bcrypt KDF（数十~百毫秒级 CPU），
/// 不卡主线程——与 key_generate 对齐。
#[tauri::command]
pub async fn key_inspect(
    pem: String,
    passphrase: Option<String>,
) -> CmdResult<ottr_ssh::KeyMaterial> {
    tauri::async_runtime::spawn_blocking(move || {
        ottr_ssh::keygen::inspect(&pem, passphrase.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
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
#[derive(Debug, serde::Serialize)]
pub struct KeyDeployReport {
    pub status: DeployStatus,
    pub public_key_fingerprint: String,
    pub host_key_fingerprint: Option<String>,
    pub known_hosts_state: KnownHostState,
}

/// 临时私钥文件的 Drop guard（评审 I-1）：离开作用域即删——key_deploy 的任何
/// 提前返回（port 越界 / 部署超时 / 连接失败）与成功路径统一收尾，杜绝明文
/// 私钥滞留 OS temp dir。此前为手动 remove_file，只覆盖成功路径（泄漏已修）。
/// Task 7 起 `attach_host_session` 复用（key 凭据连接的同一收尾语义）。
pub(crate) struct TempKeyGuard(Option<PathBuf>);

impl Drop for TempKeyGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 部署认证材料：从 vault 服务端解析（明文不过前端）。
/// 返回 AuthMethod 与临时私钥文件的 [`TempKeyGuard`]（key 认证时 guard 内
/// 持有路径，Drop 即删——所有权随函数体走，所有返回路径都清理）。
/// Task 7 更名 pub(crate)：`attach_host_session` 复用同一「凭据 → AuthMethod」
/// 解析（明文只在 Rust 侧解密，前端只传 host_id / credential_id）。
pub(crate) async fn resolve_credential_auth(
    vault: &VaultState,
    auth_credential_id: i64,
) -> Result<(AuthMethod, TempKeyGuard), String> {
    let vault = vault.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(AuthMethod, TempKeyGuard), String> {
        let credential = Credentials::get(&vault, auth_credential_id).map_err(vault_err)?
            .ok_or_else(|| format!("credential id={auth_credential_id} not found"))?;
        match credential.kind {
            ottr_vault::CredentialKind::Password => {
                let secret = Credentials::reveal(&vault, auth_credential_id, SecretField::Secret).map_err(vault_err)?
                    .ok_or_else(|| "password credential has no secret".to_string())?;
                Ok((AuthMethod::Password(secret), TempKeyGuard(None)))
            }
            ottr_vault::CredentialKind::Key => {
                let pem = Credentials::reveal(&vault, auth_credential_id, SecretField::Secret).map_err(vault_err)?
                    .ok_or_else(|| "key credential has no private key".to_string())?;
                let passphrase =
                    Credentials::reveal(&vault, auth_credential_id, SecretField::Passphrase).map_err(vault_err)?;
                // 临时文件 0600：AuthMethod::Key 的 path 语义要求；guard Drop 即删
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
                Ok((AuthMethod::Key { path: path.clone(), passphrase }, TempKeyGuard(Some(path))))
            }
            ottr_vault::CredentialKind::Totp => Err(
                "totp credential cannot authenticate deployment (keyboard-interactive unsupported for deploy)".to_string(),
            ),
            // FTP/FTPS 凭据是密码型但不服务 SSH 认证（attach_host_session 分派面
            // 会走 ftp_attach 路径，不经此处；防御性显式拒绝，Phase 2 Task 5）。
            ottr_vault::CredentialKind::Ftp | ottr_vault::CredentialKind::Ftps => Err(
                "ftp/ftps credential cannot authenticate SSH sessions (bind it to an FTP host)".to_string(),
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
    key_deploy_inner(
        &state,
        auth_credential_id,
        address,
        port,
        username,
        public_key,
    )
    .await
}

/// 命令本体。State 只做解引用——拆 inner 供无 Tauri 运行时的回归测试直接调用
/// （评审 I-1：临时私钥在「resolve 之后、部署之前」的任何失败路径都不得残留）。
async fn key_deploy_inner(
    vault: &VaultState,
    auth_credential_id: i64,
    address: String,
    port: i64,
    username: String,
    public_key: String,
) -> CmdResult<KeyDeployReport> {
    // guard 持有临时私钥路径直到本函数返回（含 ? 提前返回），Drop 即删
    let (auth, _temp_key_guard) = resolve_credential_auth(vault, auth_credential_id).await?;
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

    // A3 联动：部署会话观察到的服务器指纹按 TOFU 首见落库（已存在则原样返回，
    // 信任锚不被覆盖）。记账键 = host 端点（0004 迁移，Task 8 义务①）。
    let known_hosts_state = match &outcome.host_key_fingerprint {
        Some(fp) => {
            let host_key = ottr_vault::host_endpoint_key(&address, i64::from(port));
            KnownHosts::upsert(&vault.0, &host_key, fp)
                .map_err(vault_err)
                .map(|k| k.state)?
        }
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
        let m =
            tauri::async_runtime::block_on(key_generate("ed25519".into(), None, Some("t".into())))
                .unwrap();
        assert_eq!(m.algorithm.as_str(), "ed25519");
        assert!(m.fingerprint.starts_with("SHA256:"));
        assert!(m.public_openssh.starts_with("ssh-ed25519 "));
        let back =
            tauri::async_runtime::block_on(key_inspect(m.private_openssh.clone(), None)).unwrap();
        assert_eq!(back.fingerprint, m.fingerprint);
    }

    /// 评审 I-1 回归：key_deploy 在「resolve（已落盘临时私钥）之后」失败
    /// （此处构造 port 越界的前置校验失败），OS temp dir 不得残留
    /// `ottr-deploy-<pid>-*.pem`。guard 回归防御：若有人把 Drop guard 改回
    /// 手动 remove_file，本测试必红。
    #[test]
    fn key_deploy_failure_path_leaves_no_temp_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        let state = VaultState(std::sync::Arc::new(vault));
        // key 凭据：secret 内容无需可解析——失败点在 port 前置校验（连接之前）
        let cred = ottr_vault::Credentials::create(
            &state.0,
            &ottr_vault::CredentialInput {
                kind: ottr_vault::CredentialKind::Key,
                secret: Some("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----".into()),
                key_pub: None,
                passphrase: None,
                totp_secret: None,
            },
        )
        .expect("create key credential");

        fn leaked_temp_keys() -> Vec<std::path::PathBuf> {
            let prefix = format!("ottr-deploy-{}-", std::process::id());
            std::env::temp_dir()
                .read_dir()
                .expect("read temp dir")
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    name.starts_with(&prefix) && name.ends_with(".pem")
                })
                .map(|e| e.path())
                .collect()
        }
        assert!(leaked_temp_keys().is_empty(), "前置：基线无残留");

        let err = tauri::async_runtime::block_on(key_deploy_inner(
            &state,
            cred.id,
            "203.0.113.1".into(),
            70_000, // 越界：resolve（临时 PEM 已落盘）之后、连接之前的 ? 提前返回
            "spike".into(),
            "ssh-ed25519 AAAA leak-test".into(),
        ))
        .unwrap_err();
        assert!(err.contains("out of range"), "got: {err}");
        assert!(
            leaked_temp_keys().is_empty(),
            "失败路径残留临时私钥（I-1 回归）：{:?}",
            leaked_temp_keys()
        );

        // 对照组：guard 存活期内文件确实在（证明「落盘发生过」，断言不是恒真）
        let (auth, guard) =
            tauri::async_runtime::block_on(resolve_credential_auth(&state, cred.id)).unwrap();
        assert!(matches!(auth, AuthMethod::Key { .. }));
        let paths = leaked_temp_keys();
        assert_eq!(paths.len(), 1, "guard 存活期内临时 PEM 应存在");
        drop(guard);
        assert!(leaked_temp_keys().is_empty(), "guard Drop 后应删除");
    }
}
