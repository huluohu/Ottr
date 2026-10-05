//! 密钥生成 / openssh 导入解析 / 指纹（Task 6，A4）。
//!
//! 定位：KeyManager UI 与 `key_*` Tauri 命令的纯计算底座——只碰密钥材料，
//! 不做 IO（落盘在 src-tauri 侧）、不做网络（部署在 [`crate::deploy`]）。
//!
//! 底层全部走 russh 自带的 ssh-key（russh 0.63 default features：ed25519/p256/
//! p384/p521/encryption/rsa 全开），因此**生成与导入能力边界 = russh 的边界**：
//!
//! | 算法        | 生成 | 导入（openssh PEM） | 备注 |
//! |-------------|------|---------------------|------|
//! | Ed25519     | ✅   | ✅                  | MVP 首选 |
//! | ECDSA P-256 | ✅   | ✅                  | P-384/P-521 可导入（inspect 反映真实算法），生成面只收 P-256 |
//! | RSA         | ✅   | ✅                  | 生成固定 4096 位（ssh-key 内置，耗时秒级～数十秒） |
//! | DSA         | ❌   | ⚠️                  | ssh-key/dsa 特性未开 → 导入报 Invalid（明确拒绝，不静默） |
//! | PuTTY PPK   | ❌   | ✅                  | russh decode_secret_key 原生支持（意外之喜，不做承诺） |
//!
//! 指纹统一 `SHA256:<43 字符无填充标准 base64>`，与 `ssh-keygen -lf` 逐字一致
//! （golden 断言见 `tests/keygen_test.rs`）。

use russh::keys::ssh_key::{EcdsaCurve, LineEnding, PrivateKey};
use russh::keys::{Algorithm as SshAlgorithm, HashAlg, decode_secret_key};

use crate::KeyError;

/// 支持的密钥算法面（生成项 + 导入可反射项）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAlgorithm {
    Ed25519,
    EcdsaP256,
    Rsa,
}

impl KeyAlgorithm {
    /// UI/i18n 键与 `key_generate` 参数值。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ed25519 => "ed25519",
            Self::EcdsaP256 => "ecdsa-p256",
            Self::Rsa => "rsa",
        }
    }
}

impl std::str::FromStr for KeyAlgorithm {
    type Err = KeyError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "ed25519" | "ssh-ed25519" => Ok(Self::Ed25519),
            "ecdsa-p256" | "ecdsa" | "ecdsa-sha2-nistp256" => Ok(Self::EcdsaP256),
            "rsa" | "ssh-rsa" => Ok(Self::Rsa),
            other => Err(KeyError::Invalid {
                message: format!("unsupported key algorithm: {other}"),
                source: None,
            }),
        }
    }
}

impl std::fmt::Display for KeyAlgorithm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

fn from_ssh_algorithm(alg: SshAlgorithm) -> Result<KeyAlgorithm, KeyError> {
    match alg {
        SshAlgorithm::Ed25519 => Ok(KeyAlgorithm::Ed25519),
        SshAlgorithm::Ecdsa { curve } => match curve {
            EcdsaCurve::NistP256 => Ok(KeyAlgorithm::EcdsaP256),
            other => Err(KeyError::Invalid {
                message: format!("ecdsa curve {other} is import-only (generate supports p256)"),
                source: None,
            }),
        },
        SshAlgorithm::Rsa { .. } => Ok(KeyAlgorithm::Rsa),
        other => Err(KeyError::Invalid {
            message: format!("key algorithm {other} is not supported by ottr"),
            source: None,
        }),
    }
}

/// 密钥材料的完整面貌：私钥 PEM（可能含加密段）、单行公钥、`SHA256:…` 指纹。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct KeyMaterial {
    pub algorithm: KeyAlgorithm,
    /// openssh 格式私钥 PEM。`generate` 产出的即为序列化结果；
    /// `inspect` 返回归一化重编码（换行统一 LF、保留加密段）。
    pub private_openssh: String,
    /// `ssh-ed25519 AAAA… comment` 单行（authorized_keys 直接可用）。
    pub public_openssh: String,
    /// 公钥指纹 `SHA256:…`（与 `ssh-keygen -lf` 一致）。
    pub fingerprint: String,
}

/// 生成新密钥。`passphrase` 非空时产出 openssh 加密段（aes256-ctr + bcrypt）。
pub fn generate(
    algorithm: KeyAlgorithm,
    passphrase: Option<&str>,
    comment: &str,
) -> Result<KeyMaterial, KeyError> {
    let ssh_alg = match algorithm {
        KeyAlgorithm::Ed25519 => SshAlgorithm::Ed25519,
        KeyAlgorithm::EcdsaP256 => SshAlgorithm::Ecdsa {
            curve: EcdsaCurve::NistP256,
        },
        KeyAlgorithm::Rsa => SshAlgorithm::Rsa { hash: None },
    };
    let mut key = PrivateKey::random(&mut os_rng(), ssh_alg).map_err(|e| KeyError::Invalid {
        message: format!("key generation failed: {e}"),
        source: Some(Box::new(e)),
    })?;
    key.set_comment(comment);
    // 加密必须在 set_comment 之后（comment 进加密段）；
    // encrypt 产出新值（原值未加密），覆盖即可。
    if let Some(pass) = passphrase.filter(|p| !p.is_empty()) {
        key = key
            .encrypt(&mut os_rng(), pass)
            .map_err(|e| KeyError::Invalid {
                message: format!("key encryption failed: {e}"),
                source: Some(Box::new(e)),
            })?;
    }
    finish(key)
}

/// OS CSPRNG 直采适配（BL-206）：ssh-key 的 `PrivateKey::random`/`encrypt`
/// 需要 `CryptoRng`（无错面）。rand 0.10 起 OS 熵源是 fallible 的
/// `rngs::SysRng`，经 `rand_core::UnwrapErr` 适配为失败即 panic——OS 熵源
/// 失败在密钥生成场景是进程不可继续的灾难，绝不静默降级；相对旧
/// `rand::rng()`（ThreadRng 用户态缓冲）去掉了密钥面随机的中间层。
fn os_rng() -> impl rand::CryptoRng {
    use rand::rand_core::UnwrapErr;
    UnwrapErr(rand::rngs::SysRng)
}

/// 解析 openssh 格式私钥 PEM（含加密私钥——口令缺失/错误统一报
/// [`KeyError::PassphraseRequired`]，格式问题报 [`KeyError::Invalid`]）。
///
/// 错误分类说明：openssh 格式的加密标记藏在 base64 内（PEM 明文里**没有**
/// "ENCRYPTED" 字样），russh 只在「缺口令」时报 `KeyIsEncrypted`，错口令与
/// 密文损坏统一表现为 ssh-key `Crypto` 错误。因此分类规则：
/// 缺口令 → `KeyIsEncrypted` → [`KeyError::PassphraseRequired`]；带了口令仍
/// 失败且输入形似 openssh/PPK 私钥 → 仍按口令错误分类（UI 语境下最可行动；
/// 非密钥输入或无口令路径的损坏数据走 [`KeyError::Invalid`]）。
pub fn inspect(pem: &str, passphrase: Option<&str>) -> Result<KeyMaterial, KeyError> {
    let key = decode_secret_key(pem, passphrase).map_err(|e| {
        let looks_like_secret_key = pem.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
            || pem.contains("PuTTY-User-Key-File-");
        match e {
            russh::keys::Error::KeyIsEncrypted => KeyError::PassphraseRequired,
            _ if passphrase.is_some() && looks_like_secret_key => KeyError::PassphraseRequired,
            other => KeyError::Invalid {
                message: other.to_string(),
                source: Some(Box::new(other)),
            },
        }
    })?;
    finish(key)
}

/// 解析公钥行（`<type> <base64> [comment]`，即 authorized_keys / `.pub` 文件单行），
/// 返回算法 + 归一化公钥行 + 指纹。不含私钥材料，任意来源（含远端回执）可安全解析。
pub fn parse_public_key(line: &str) -> Result<PublicKeyInfo, KeyError> {
    let key = russh::keys::parse_public_key_base64(public_key_base64(line)?).map_err(|e| {
        KeyError::Invalid {
            message: e.to_string(),
            source: Some(Box::new(e)),
        }
    })?;
    Ok(PublicKeyInfo {
        algorithm: from_ssh_algorithm(key.algorithm())?,
        public_openssh: key.to_openssh().map_err(|e| KeyError::Invalid {
            message: e.to_string(),
            source: Some(Box::new(e)),
        })?,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

/// 公钥行 → base64 段（跳过 type 与 comment；russh 的 parse_public_key_base64
/// 只吃 base64 主体）。
fn public_key_base64(line: &str) -> Result<&str, KeyError> {
    line.split_whitespace()
        .nth(1)
        .ok_or_else(|| KeyError::Invalid {
            message: "public key line malformed (expected `<type> <base64> [comment]`)".into(),
            source: None,
        })
}

/// [`PublicKeyInfo`]：不含私钥材料的公钥面貌（列表展示/部署回执用）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PublicKeyInfo {
    pub algorithm: KeyAlgorithm,
    pub public_openssh: String,
    pub fingerprint: String,
}

/// 从已构造的私钥收敛三件套（序列化 PEM / 公钥行 / 指纹）。
fn finish(key: russh::keys::PrivateKey) -> Result<KeyMaterial, KeyError> {
    let algorithm = from_ssh_algorithm(key.algorithm())?;
    let public_openssh = key
        .public_key()
        .to_openssh()
        .map_err(|e| KeyError::Invalid {
            message: format!("public key serialization failed: {e}"),
            source: Some(Box::new(e)),
        })?;
    let private_openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| KeyError::Invalid {
            message: format!("private key serialization failed: {e}"),
            source: Some(Box::new(e)),
        })?
        .to_string();
    Ok(KeyMaterial {
        algorithm,
        private_openssh,
        public_openssh,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    })
}
