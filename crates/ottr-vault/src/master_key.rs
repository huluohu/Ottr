//! Master Key 层级（spec §3）。
//!
//! 层级：系统钥匙链存 32B 随机 Master Key → 每条敏感字段独立 AES-256-GCM。
//! 无钥匙链条目时生成新 key 写回钥匙链（默认无感模式，用户零负担）。
//! Linux 无 Secret Service 的 fallback（加密文件 + Argon2id 主密码，
//! `Vault::unlock_with_password`）走 [`derive_key_argon2id`] 派生原语，
//! 完整文件存储在主密码模式（Task 11 安全底座）落地——见 [`keyring_available`]
//! 与 `Vault::open_auto`（store.rs）：Linux 上运行时探测 Secret Service，
//! 不可用即整库走主密码模式（库文件本身就是那份「加密文件」，无需第二层文件）。
//!
//! 可注入是纪律：真钥匙链操作在 CI/测试里不可靠，故 KeyStorage 为 trait——
//! 生产 [`KeyringStorage`]、测试 [`InMemoryStorage`]，单测一律走内存实现。

use crate::crypto::{self, Cipher};
use crate::{Result, VaultError};

/// 钥匙链 service（正式数据；Phase 0 spike 用 "ottr.spike" 与之隔离）。
pub const DEFAULT_SERVICE: &str = "ottr.dev";
/// 同一 service 下的 Master Key 条目 account。
pub const MASTER_KEY_ACCOUNT: &str = "master_key";

/// Master Key 原始字节（AES-256 密钥）。
pub type RawKey = [u8; crypto::KEY_LEN];

/// Master Key 存储后端抽象。存取的是 key 的十六进制串（钥匙链只收字符串）。
pub trait KeyStorage {
    /// `None` 表示尚未存 key。
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, secret: &str) -> Result<()>;
    /// 清除条目（密钥重置/手动验证清理）。条目不存在时为 no-op。
    fn delete(&self) -> Result<()>;
}

/// 内存实现：测试与手动验证专用（绝不触碰真钥匙链）。
pub struct InMemoryStorage(std::sync::Mutex<Option<String>>);

impl InMemoryStorage {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    /// 预置原始内容——构造"钥匙链条目被外部改写/损坏"场景。
    pub fn with_raw(raw: &str) -> Self {
        Self(std::sync::Mutex::new(Some(raw.to_string())))
    }
}

impl Default for InMemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyStorage for InMemoryStorage {
    fn load(&self) -> Result<Option<String>> {
        Ok(self.0.lock().expect("in-memory storage poisoned").clone())
    }

    fn save(&self, secret: &str) -> Result<()> {
        *self.0.lock().expect("in-memory storage poisoned") = Some(secret.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<()> {
        *self.0.lock().expect("in-memory storage poisoned") = None;
        Ok(())
    }
}

/// Master Key：32B 随机，钥匙链生命周期内复用。
pub struct MasterKey(RawKey);

impl MasterKey {
    /// 生产路径：系统钥匙链。
    pub fn load(service: &str) -> Result<MasterKey> {
        Self::load_with_storage(&KeyringStorage::new(service))
    }

    /// 生成或复用：无条目 → 生成 32B 随机并存入；有条目 → 解码复用。
    /// 条目存在但内容非法（非十六进制/长度不对）→ [`VaultError::CorruptedMasterKey`]。
    pub fn load_with_storage(storage: &dyn KeyStorage) -> Result<MasterKey> {
        match storage.load()? {
            Some(raw) => Ok(MasterKey(decode_key(&raw)?)),
            None => {
                let mut key: RawKey = [0u8; crypto::KEY_LEN];
                rand::fill(&mut key);
                storage.save(&hex::encode(key))?;
                Ok(MasterKey(key))
            }
        }
    }

    /// 密封器工厂（每次 open 由 Vault 调用）。
    pub fn cipher(&self) -> Cipher {
        Cipher::new(&self.0).expect("MasterKey is always 32B")
    }

    /// key 原始字节（供派生/迁移场景核对，勿落日志）。
    pub fn key(&self) -> &RawKey {
        &self.0
    }
}

fn decode_key(raw: &str) -> Result<RawKey> {
    let bytes = hex::decode(raw.trim()).map_err(|_| VaultError::CorruptedMasterKey)?;
    bytes.try_into().map_err(|_| VaultError::CorruptedMasterKey)
}

/// Argon2id 派生原语（spec §3 密钥层级图的 fallback 分支）：Linux 无 Secret
/// Service 时由主密码派生 Master Key；「主密码模式」的校验器（Task 11）同源。
/// 参数用 argon2 crate 默认（Argon2id v19, m=19MiB, t=2, p=1）——OWASP 推荐档。
/// 盐至少 8 字节；持久化场景盐必须随机生成并随密文存盘（Task 11 文件格式）。
pub fn derive_key_argon2id(password: &str, salt: &[u8]) -> Result<RawKey> {
    let mut key: RawKey = [0u8; crypto::KEY_LEN];
    argon2::Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| VaultError::Kdf(format!("argon2id derive failed: {e}")))?;
    Ok(key)
}

/// 系统钥匙链条目操作错误 → 是否「钥匙链服务不可用」（T11 Linux fallback 的
/// 分类原语，纯函数便于跨平台单测）。分类（keyring v3 错误面）：
/// * `NoStorageAccess` / `PlatformFailure`：后端不可达——Linux 无 Secret Service
///   （gnome-keyring 未装/未起）时的典型报错 → `true`，调用方落主密码 fallback；
/// * `NoEntry`：服务正常、只是还没有条目 → `false`（钥匙链可用，正常首装路径）；
/// * `Invalid`/`BadEncoding` 等「条目内容有问题」：服务在、内容坏 → `false`
///   （不是不可用，走 CorruptedMasterKey 显式报错，绝不静默 fallback 掩盖）。
pub fn keyring_error_is_unavailable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
    )
}

/// 运行时探测系统钥匙链是否可用（T11 Linux fallback 判定点）。探测动作 =
/// 对 Master Key 条目做一次无副作用的 `get_password`：
/// * `Ok(_)`（已有条目）或 `NoEntry`（服务正常、首装无条目）→ 可用；
/// * [`keyring_error_is_unavailable`] 命中 → 不可用。
/// 其余错误（条目损坏等）按「可用」返回——损坏要在正式 load 路径显式报错，
/// 探测不做越界诊断（单一职责：只回答「服务通不通」）。
pub fn keyring_available() -> bool {
    let entry = match keyring::Entry::new(DEFAULT_SERVICE, MASTER_KEY_ACCOUNT) {
        Ok(e) => e,
        Err(e) => return !keyring_error_is_unavailable(&e),
    };
    match entry.get_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => true,
        Err(e) => !keyring_error_is_unavailable(&e),
    }
}

/// 系统钥匙链后端（keyring v3，平台 feature 见 Cargo.toml 三段 target 声明）。
/// 只在真实运行时使用；自动化测试一律走 [`InMemoryStorage`]（CI 无桌面环境/
/// 钥匙链不可靠，见 Phase 0 Task 11 经验），真钥匙链验证走
/// `examples/keyring_manual.rs` 手动跑。
pub struct KeyringStorage {
    service: String,
    account: &'static str,
}

impl KeyringStorage {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
            account: MASTER_KEY_ACCOUNT,
        }
    }

    fn entry(&self) -> Result<keyring::Entry> {
        Ok(keyring::Entry::new(&self.service, self.account)?)
    }
}

impl KeyStorage for KeyringStorage {
    fn load(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            // keyring v3：无条目 = NoEntry（v2 的 Bad* 系列已拆分）。
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, secret: &str) -> Result<()> {
        let entry = self.entry()?;
        // 已有条目时 set_password 会失败（平台行为不一），先删再存保证幂等。
        let _ = entry.delete_credential();
        Ok(entry.set_password(secret)?)
    }

    fn delete(&self) -> Result<()> {
        let entry = self.entry()?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
