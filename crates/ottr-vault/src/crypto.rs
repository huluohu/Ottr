//! AES-256-GCM 密封层（spec §3 密钥层级）。
//!
//! 密文 blob 结构：`nonce(12B 前置) || ciphertext || tag(16B)`——nonce 随机生成、
//! 每次密封独立采样，开封时从 blob 头部读取，无需额外存储。
//!
//! AAD 纪律（spec §3 防密文换绑）：每条敏感字段的 AAD 固定为
//! `"{table}:{row_id}:{field}"`，把密文绑死在具体实体行与字段上；
//! 换绑到任何其他行/字段都会因 GCM 认证失败而报错。构造 AAD 一律走 [`aad`] helper。

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

use crate::VaultError;

/// 密钥长度（AES-256）。
pub const KEY_LEN: usize = 32;
/// GCM 标准 nonce 长度（96-bit）。
pub const NONCE_LEN: usize = 12;
/// GCM 认证标签长度。
pub const TAG_LEN: usize = 16;

/// 持有一把 32B 密钥的 AES-256-GCM 密封器。
///
/// 可 `Clone`：密钥在本类型内不可被外部读出（只进密封/开封运算），
/// zeroize 用后即清场景为 spec §14 backlog，暂不实现。
#[derive(Clone)]
pub struct Cipher {
    cipher: Aes256Gcm,
}

impl Cipher {
    pub fn new(key: &[u8; KEY_LEN]) -> Result<Self, VaultError> {
        Ok(Self {
            cipher: Aes256Gcm::new(key.into()),
        })
    }

    /// 密封：随机 96-bit nonce 前置入 blob。正常存储路径一律用本方法。
    ///
    /// nonce 采样走 [`fill_os`]（BL-206：密钥面随机直接采 OS CSPRNG——GCM
    /// nonce 重用是灾难级失败模式，采样源越短越好）。测试确定性路径走
    /// [`Self::seal_with_nonce`]。
    pub fn seal(&self, plaintext: &[u8], aad: &str) -> Result<Vec<u8>, VaultError> {
        let mut nonce = [0u8; NONCE_LEN];
        fill_os(&mut nonce);
        self.seal_with_nonce(&nonce, plaintext, aad)
    }

    /// 指定 nonce 密封——仅供测试向量与重加密迁移的确定性场景；
    /// 生产路径必须走 [`Cipher::seal`]（随机 nonce）。
    pub fn seal_with_nonce(
        &self,
        nonce: &[u8; NONCE_LEN],
        plaintext: &[u8],
        aad: &str,
    ) -> Result<Vec<u8>, VaultError> {
        let payload = Payload {
            msg: plaintext,
            aad: aad.as_bytes(),
        };
        // aead 加密返回 ciphertext||tag，前面拼上 nonce 组成存储 blob。
        let ct = self.cipher.encrypt(&Nonce::from(*nonce), payload)?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(nonce);
        blob.extend_from_slice(&ct);
        Ok(blob)
    }

    /// 开封：AAD 必须与 seal 时逐字节一致，否则 GCM 认证失败返回
    /// [`VaultError::Crypto`]（防密文换绑的强制点）。
    pub fn open(&self, blob: &[u8], aad: &str) -> Result<Vec<u8>, VaultError> {
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(VaultError::Crypto(format!(
                "blob too short: {} bytes, need at least {NONCE_LEN}+{TAG_LEN}",
                blob.len()
            )));
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let mut nonce_buf = [0u8; NONCE_LEN];
        nonce_buf.copy_from_slice(nonce);
        let payload = Payload {
            msg: ct,
            aad: aad.as_bytes(),
        };
        Ok(self.cipher.decrypt(&Nonce::from(nonce_buf), payload)?)
    }
}

/// AAD 纪律的唯一构造点：`"{table}:{row_id}:{field}"`（spec §3）。
///
/// **`table` 与 `field` 不得包含 `:`**：冒号是本格式的字段分隔符，混入会使
/// `credentials:5:secret` 这类串在人工审计、日志排查与工具解析时产生歧义
/// （如 `table="a:b"` 时无法区分边界）。GCM 把 AAD 当不透明字节，密封/开封
/// 只要求两侧逐字节一致，故违反本约定不影响正确性，但破坏可读性约定——
/// 新增 AAD 字段请用下划线等无歧义命名。现有合法样例：
/// `credentials:{id}:secret|passphrase|totp_secret`。
pub fn aad(table: &str, row_id: impl std::fmt::Display, field: &str) -> String {
    format!("{table}:{row_id}:{field}")
}

/// 密钥面随机填充（BL-206）：**直接采操作系统 CSPRNG**。rand 0.10 起原
/// OsRng 概念由 [`rand::rngs::SysRng`](rand::rngs::SysRng)（getrandom 直通、
/// fallible）承担，经 `rand_core::UnwrapErr` 适配为失败即 panic 的无错 Rng
/// ——OS 熵源失败是进程不可继续的灾难，宁可 panic 绝不静默降级；相对旧
/// `rand::fill`（ThreadRng 用户态缓冲）去掉了密钥面随机与 OS 熵源之间的
/// 中间层。密钥面场景：GCM nonce（本 crate）、Master Key（master_key.rs）、
/// KDF 盐（store.rs 两处）。
pub(crate) fn fill_os(dst: &mut [u8]) {
    use rand::Rng as _;
    use rand::rand_core::UnwrapErr;
    UnwrapErr(rand::rngs::SysRng).fill_bytes(dst);
}
