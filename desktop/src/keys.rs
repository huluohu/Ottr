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
use ottr_vault::{Credentials, Hosts, KnownHostState, KnownHosts, SecretField};

use crate::commands::session::tofu_host_key_policy;
use crate::commands::state::AppState;
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
                .or_else(|_| crate::paths::data_root(&app))
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

/// 临时私钥文件的 Drop guard（评审 I-1）。
///
/// **2026-11-02 起私钥不再落盘**：key 凭据走 `KeySource::Pem`（私钥文本留在
/// 内存里），因此不再需要临时文件，也就没有了它的三个问题——Windows 上没有
/// 0600 等价物（非 Unix 分支是普通 OpenOptions → 继承目录 ACL，同机其他用户
/// 可能可读）、文件名可预测、以及任何提前返回路径下的残留。
///
/// 保留本类型是为了**不改动调用方的收尾语义**（guard 必须活到连接完成，
/// 见 `commands/jump.rs` 的 guards 字段）；现在它恒为空。
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
    kbd: Option<crate::commands::session::KbdContext>,
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
                // **私钥不落盘**：走 KeySource::Pem，明文只活在本次连接的内存里。
                // （旧实现写 OS temp 目录的 0600 文件：Windows 上没有 0600 等价物，
                // 文件名可预测，且任何提前返回路径都可能留下残留。）
                Ok((
                    AuthMethod::Key {
                        source: ottr_ssh::KeySource::Pem(pem),
                        passphrase,
                    },
                    TempKeyGuard(None),
                ))
            }
            // 系统 ssh-agent 凭据（2026-11-02 批次五 P2）→ agent 认证：
            // 私钥留在 agent 进程里，Ottr 只借用签名能力（不存任何密钥材料）。
            ottr_vault::CredentialKind::Agent => Ok((
                AuthMethod::Agent { socket: None },
                TempKeyGuard(None),
            )),
            // TOTP 凭据 → keyboard-interactive 认证（2026-11-02 批次二）。
            //
            // SSH 协议里「密码 + 二次验证码」本身就是 keyboard-interactive
            // 一次交互（服务器一次下发多条 prompt，客户端逐条作答）——所以
            // **不需要**扩展数据模型去表达「主密码 + 二次 TOTP」两个凭据位：
            // 主机绑 TOTP 凭据即走 kbd-interactive，密码由用户在弹窗里手输，
            // 验证码由 Ottr 自动算好随事件下发（见 kbdint.rs）。
            //
            // 部署路径（key_deploy）**不支持** TOTP（部署只接受密码/私钥，
            // 前端 deployableAuths 也已过滤掉 totp）——故此处 kbd=None 时
            // 显式拒绝并给出可读文案，不做静默降级。
            ottr_vault::CredentialKind::Totp => match kbd {
                Some(ctx) => Ok((
                    AuthMethod::KeyboardInteractive {
                        responder: crate::commands::session::keyboard_interactive_responder(ctx),
                    },
                    TempKeyGuard(None),
                )),
                None => Err(
                    "totp credential requires an interactive session (not supported for key deployment)"
                        .to_string(),
                ),
            },
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
///
/// **主机密钥策略 = 与普通连接同一套 TOFU**（2026-11-01 安全审计 P1-1）：
/// 此前本命令用「接受任何 `SHA256:` 指纹」的宽松策略（模块头「裁定 #3」写明
/// 「T7 接入真 TOFU 后收紧」，但 T7 落地后本调用点从未更新）。后果：MITM 可在
/// 部署握手阶段截获用户交出的**密码凭据**（部署认证材料就是密码/私钥），
/// 且观察到的指纹会被写进 known_hosts 当信任锚——此后该 MITM 指纹被静默信任。
/// 现走 `tofu_host_key_policy`：首见问用户、指纹变更强提醒默认拒绝、已知指纹
/// 静默放行；信任锚与普通连接共用同一端点记账。
///
/// **目标地址/端口/用户名一律由 host_id 在服务端解析**（不再信前端传值）：
/// TOFU 记账键 = 端点，若前端可传任意地址，就会出现「校验的端点 ≠ 实际连接
/// 的端点」——TOFU 被绕开。前端仍按原口径从所选主机取值，此处是同一来源的
/// 服务端再解析（口径一致 + 不可被篡改）。
#[tauri::command]
pub(crate) async fn key_deploy(
    app: AppHandle,
    app_state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    host_id: i64,
    auth_credential_id: i64,
    public_key: String,
) -> CmdResult<KeyDeployReport> {
    let host = Hosts::get(&vault_state.0, host_id)
        .map_err(vault_err)?
        .ok_or_else(|| format!("host id={host_id} not found"))?;
    let address = host.address.clone();
    let port = host.port;
    let username = host.username.clone().unwrap_or_default();
    let host_key = ottr_vault::host_endpoint_key(&address, port);
    let policy = tofu_host_key_policy(
        vault_state.0.clone(),
        app,
        host_id,
        host.name.clone(),
        host_key,
        app_state.host_key_asks.clone(),
        None,
        None,
    );
    key_deploy_inner(
        &vault_state,
        auth_credential_id,
        address,
        port,
        username,
        public_key,
        policy,
    )
    .await
}

/// 命令本体。State 只做解引用——拆 inner 供无 Tauri 运行时的回归测试直接调用
/// （评审 I-1：临时私钥在「resolve 之后、部署之前」的任何失败路径都不得残留）。
/// 主机密钥策略由调用方注入（生产 = TOFU 策略；单测 = 宽松桩，不触网）。
async fn key_deploy_inner(
    vault: &VaultState,
    auth_credential_id: i64,
    address: String,
    port: i64,
    username: String,
    public_key: String,
    policy: ottr_ssh::HostKeyPolicy,
) -> CmdResult<KeyDeployReport> {
    // guard 持有临时私钥路径直到本函数返回（含 ? 提前返回），Drop 即删
    // 部署只接受密码/私钥（前端 deployableAuths 已过滤 totp）；kbd=None →
    // TOTP 凭据在此显式拒绝并给出可读文案。
    let (auth, _temp_key_guard) = resolve_credential_auth(vault, auth_credential_id, None).await?;
    let port = u16::try_from(port).map_err(|_| format!("port {port} out of range"))?;

    // 部署限时必须**装得下**部署期间的 TOFU 问询窗口（HOST_KEY_ASK_TIMEOUT
    // = 60s）——30s 的旧值会让「用户 30s 后才点信任并连接」时部署先失败、
    // 用户的选择作废，且 host_key_asks 槽位残留（Rust 任务被 drop，闭包里的
    // recv_timeout 一并消失，用户稍后再点确认会命中死端、send 失败被忽略 →
    // 前端收到 Ok 但毫无效果）。
    const DEPLOY_TIMEOUT_SECS: u64 =
        crate::commands::state::HOST_KEY_ASK_TIMEOUT.as_secs() + 15;
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(DEPLOY_TIMEOUT_SECS),
        deploy_public_key(&address, port, &username, auth, policy, &public_key),
    )
    .await
    .map_err(|_| format!("deploy timed out after {DEPLOY_TIMEOUT_SECS}s"))?
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
                name: None,
                kind: ottr_vault::CredentialKind::Key,
                secret: Some("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----".into()),
                key_pub: None,
                passphrase: None,
                totp_secret: None,
                totp_digits: None,
                totp_period: None,
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

        // 策略桩：本用例的失败点在端口前置校验（连接之前），策略不会被调用——
        // 生产路径注入的是 TOFU 策略（见 key_deploy 命令）。
        let policy: ottr_ssh::HostKeyPolicy = std::sync::Arc::new(|_| true);
        let err = tauri::async_runtime::block_on(key_deploy_inner(
            &state,
            cred.id,
            "203.0.113.1".into(),
            70_000, // 越界：resolve（临时 PEM 已落盘）之后、连接之前的 ? 提前返回
            "spike".into(),
            "ssh-ed25519 AAAA leak-test".into(),
            policy,
        ))
        .unwrap_err();
        assert!(err.contains("out of range"), "got: {err}");
        assert!(
            leaked_temp_keys().is_empty(),
            "失败路径残留临时私钥（I-1 回归）：{:?}",
            leaked_temp_keys()
        );

        // 对照组：私钥**在内存里**（KeySource::Pem），磁盘上**没有任何**临时
        // 私钥文件——这正是本次改动的核心（旧实现会写 OS temp 目录的 0600 文件：
        // Windows 上没有 0600 等价物、文件名可预测、任何提前返回都可能留残留）。
        let (auth, _guard) =
            tauri::async_runtime::block_on(resolve_credential_auth(&state, cred.id, None)).unwrap();
        match auth {
            AuthMethod::Key { source, .. } => match source {
                ottr_ssh::KeySource::Pem(pem) => {
                    assert!(
                        pem.contains("BEGIN OPENSSH PRIVATE KEY"),
                        "内存里应是完整 PEM"
                    );
                }
                _ => panic!("key 凭据应走内存私钥（Pem）"),
            },
            _ => panic!("应为 key 认证"),
        }
        assert!(
            leaked_temp_keys().is_empty(),
            "私钥不得落盘（临时 PEM 残留）：{:?}",
            leaked_temp_keys()
        );
    }
}
