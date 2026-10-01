//! SQLite WAL 单文件存储引擎 + 迁移器（spec §3：SQLite 单文件 + FTS5）。
//!
//! Phase 1 用单连接（`Mutex<Connection>`）串行化：WAL 模式已开（journal_mode=wal），
//! 写走单写者、读也在同连接——Tauri 命令吞吐在十万行级完全够用；多读连接池留到
//! 出现真实争用时再加（YAGNI，见 task-3-report 偏差记录）。
//!
//! 迁移策略（台账裁定）：按域拆分，0001 只做引导（meta+settings），
//! 实体表 0002（Task 4）、notifications 0005（Task 12）各自成迁移，避免巨型 migration。
//! 迁移器按 `MIGRATIONS` 顺序在事务内逐个应用，版本记录在 `meta.schema_version`；
//! 库版本高于程序支持时拒绝打开（防降级静默损坏）。
//!
//! # 锁定状态机（Task 11 安全底座，A7）
//!
//! 主密钥两种来源（[`KeyMode`]）：
//! * `Keyring`——Master Key 32B 随机存系统钥匙链（默认，无感模式）。**无锁概念**：
//!   open 即解锁，`lock()`/`unlock_with_password()` 不可用（钥匙链在手随时可重开）。
//! * `Password`——Master Key = `Argon2id(主密码, 盐)` 派生，**密钥不落盘**。
//!   open 即锁定（内存无密钥）；`unlock_with_password` 派生并校验 verifier 后进内存；
//!   `lock()` 把 Cipher 从槽位取走 drop（aes-gcm zeroize feature 使 key schedule
//!   ZeroizeOnDrop，见 Cargo.toml）。两种模式的语义矩阵见 task-11-report。
//!
//! 模式与派生参数记录在 `meta` 表（明文行，锁定可读——解锁本身就需要它们）：
//! `master_key.mode` / `master_key.kdf_salt`（hex）/ `master_key.verifier`
//! （新钥密封的 magic 串，hex；解锁时的密码校验器）。`keyring` 模式升级到
//! `password` 走 [`Vault::set_master_password`]：**单个 SQLite 事务**内完成
//! 全部 `*_enc` 密文重密封 + meta 翻转——事务提交前崩溃 = 什么都没发生（旧钥
//! 照常可用，可重试升级）；提交后崩溃 = 已是 password 模式，残留的钥匙链条目
//! 由下次 open 兜底清理（best-effort delete）。verifier/salt/meta 与密文同事务，
//! 不存在「密文已换、参数没换」的中间态。
//!
//! 锁定时**需要密钥的操作**（凭据密封/解密、升级）返回 [`VaultError::Locked`]；
//! 纯明文面（settings/meta/schema）保持可读——解锁、主题、自动锁定配置都发生在
//! 锁定屏上，必须可用。命令面的整库封锁在 src-tauri 层做（ensure_unlocked 门卫）。

use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};
use zeroize::Zeroize;

use crate::master_key::{KeyStorage, MasterKey};
use crate::{Cipher, Result, VaultError};

/// 程序支持的最新 schema 版本（= MIGRATIONS 末位）。
pub const LATEST_SCHEMA_VERSION: u32 = 12;

/// meta 键：主密钥模式（"keyring" | "password"；缺省 = keyring，兼容 T11 之前的库）。
const META_KEY_MODE: &str = "master_key.mode";
/// meta 键：Argon2id 盐（hex；password 模式下与密文同库落盘）。
const META_KEY_KDF_SALT: &str = "master_key.kdf_salt";
/// meta 键：密码校验器（新钥密封的 magic 串 blob，hex；解锁校验用）。
const META_KEY_VERIFIER: &str = "master_key.verifier";

/// verifier 密封的明文 magic（只用于 GCM 认证比对，内容本身无语义）。
const VERIFIER_PLAINTEXT: &[u8] = b"ottr.vault.master-key.verifier.v1";
/// verifier 的 AAD（走 [`crate::aad`] 约定：`meta:master_key:verifier`）。
fn verifier_aad() -> String {
    crate::aad("meta", "master_key", "verifier")
}

/// Argon2id 盐长度（128-bit，随机生成；NIST SP 800-132 推荐档）。
const KDF_SALT_LEN: usize = 16;
/// 主密码最小长度。空密码/一位数字把「全库凭据」押在花生壳上——显式拒绝；
/// 上限不设（密码短语欢迎）。UI 侧同口径校验（security.wizard.errTooShort）。
pub const MASTER_PASSWORD_MIN_LEN: usize = 8;

/// 主密钥来源模式（语义矩阵见模块文档与 task-11-report）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    /// 系统钥匙链随机钥（默认；无锁概念，open 即解锁）。
    Keyring,
    /// Argon2id(主密码) 派生钥（不落盘；open 即锁定）。
    Password,
}

impl KeyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Keyring => "keyring",
            Self::Password => "password",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "keyring" => Some(Self::Keyring),
            "password" => Some(Self::Password),
            _ => None,
        }
    }
}

/// 迁移脚本注册表：新迁移往后追加，版本号必须连续递增。
/// 0001 引导（meta+settings）；0002 实体五表 + FTS5 trigram（Task 4）；
/// 0003 hosts.username 登录用户名列（Task 5，spec §3 模型缺口补列）；
/// 0004 known_hosts host 端点绑定（Task 8 义务①，防 MITM changed 强提醒）；
/// 0005 notifications（Task 12，spec §7 应用内通知中心——明文面，无 *_enc 列，
/// 不涉 scan_registry）；0006 secrets 密封 KV（Task 13 AI BYOK，value_enc 已
/// 登记 scan_registry）；0007 history 命令历史 + FTS5（Task 15，spec §5 文本层
/// 消费方③——明文面，无 *_enc 列，不涉 scan_registry）；0008 port_forwards
/// （Phase 2 Task 1，spec §3 B7 上半——明文配置面，无 *_enc 列，不动
/// scan_registry）；0009 jump_chains（Phase 2 Task 2，spec §3 B7 下半——
/// 明文配置面，无 *_enc 列，不动 scan_registry）；0010 ftp_ftps（Phase 2
/// Task 5——hosts.protocol 列 + credentials.kind CHECK 放开 ftp/ftps 的表
/// 重建：密文列原样平移、无新增密文列，不动 scan_registry；AUTOINCREMENT
/// 水位搬移防 id 复用，见迁移文件头）；0011 session_summaries（Phase 2
/// Task 7，B1 会话纪要——summary_enc 密文列**已登记 scan_registry**，见下）；
/// 0012 hosts.is_production（Phase 2 Task 11，B11 防呆完善——明文布尔补列，
/// 无 *_enc 列，不动 scan_registry 与表结构其余部分）。
const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    (2, include_str!("../migrations/0002_entities.sql")),
    (3, include_str!("../migrations/0003_hosts_username.sql")),
    (
        4,
        include_str!("../migrations/0004_known_hosts_host_binding.sql"),
    ),
    (5, include_str!("../migrations/0005_notifications.sql")),
    (6, include_str!("../migrations/0006_secrets.sql")),
    (7, include_str!("../migrations/0007_history.sql")),
    (8, include_str!("../migrations/0008_port_forwards.sql")),
    (9, include_str!("../migrations/0009_jump_chains.sql")),
    (10, include_str!("../migrations/0010_ftp_ftps.sql")),
    (11, include_str!("../migrations/0011_session_summaries.sql")),
    (
        12,
        include_str!("../migrations/0012_hosts_is_production.sql"),
    ),
];

/// 打开的 vault：SQLite 连接 + 锁定状态（Cipher 槽位）。
pub struct Vault {
    conn: Mutex<Connection>,
    /// 密封器槽位：`None` = 锁定（Master Key 不在内存）。keyring 模式恒 Some；
    /// password 模式 open 时为 None，unlock 后 Some、lock 后回 None。
    cipher_slot: Mutex<Option<Cipher>>,
    /// 主密钥模式（0=keyring 1=password）。运行期只在 `set_master_password`
    /// 成功提交后翻转一次；Atomic 因 `&self` 命令面（Tauri State 共享）。
    mode: AtomicU8,
}

/// [`KeyMode`] ↔ AtomicU8 存储编码。
const MODE_KEYRING: u8 = 0;
const MODE_PASSWORD: u8 = 1;

impl Vault {
    /// 生产路径：Master Key 走系统钥匙链（service 见 [`crate::master_key::DEFAULT_SERVICE`]）。
    pub fn open(dir: &Path) -> Result<Vault> {
        Self::open_with(
            dir,
            &crate::master_key::KeyringStorage::new(crate::master_key::DEFAULT_SERVICE),
        )
    }

    /// 生产入口（T11）：先探测系统钥匙链可用性再选模式——
    /// * 可用（macOS/Windows 恒真；Linux 有 Secret Service）→ [`Self::open`]；
    /// * 不可用（Linux 无 Secret Service）→ [`Self::open_password_only`]：
    ///   库落主密码模式，首次解锁时设置主密码（Phase 0 spec §3 承诺的 fallback）。
    ///
    /// 探测只在「库尚不存在 / meta 尚无模式记录」时起决定作用——已存在的
    /// keyring 模式库在钥匙链消失后不会静默换模式，而是显式报
    /// [`VaultError::MasterKeyUnreachable`]（密钥在打不开的钥匙链里，
    /// fallback 救不了它，静默锁死换密钥等于销毁数据）。
    pub fn open_auto(dir: &Path) -> Result<Vault> {
        #[cfg(target_os = "linux")]
        {
            if crate::master_key::keyring_available() {
                Self::open(dir)
            } else {
                Self::open_password_only(dir)
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            Self::open(dir)
        }
    }

    /// 主密码模式打开（**不读钥匙链**）。语义：
    /// * meta 无模式记录（首装）→ 写入 `password` 模式，锁定态返回——
    ///   首次 `unlock_with_password` 即设置主密码（一次性写 salt+verifier）；
    /// * meta = password → 锁定态返回（正常解锁流程）；
    /// * meta = keyring → [`VaultError::MasterKeyUnreachable`]：库的密钥在系统
    ///   钥匙链里而钥匙链不可用（Linux fallback 的死局面，显式报错不换钥）。
    ///
    /// 平台无关，Linux 之外可直调（测试即如此）；生产调用点 = [`Self::open_auto`]。
    pub fn open_password_only(dir: &Path) -> Result<Vault> {
        std::fs::create_dir_all(dir)?;
        let mut vault = Self::open_conn(dir)?;
        let mode = read_key_mode(vault.connection())?;
        match mode {
            Some(KeyMode::Password) => {}
            Some(KeyMode::Keyring) => {
                return Err(VaultError::MasterKeyUnreachable);
            }
            None => {
                set_meta(
                    vault.connection(),
                    META_KEY_MODE,
                    KeyMode::Password.as_str(),
                )?;
            }
        }
        vault.mode = AtomicU8::new(MODE_PASSWORD);
        Ok(vault)
    }

    /// 可注入路径：测试/特殊场景指定 KeyStorage（keyring 测试纪律的前提）。
    /// 模式判定读 meta（缺省 = keyring）；password 模式下 storage 参数只用于
    /// 兜底清理升级残留的钥匙链条目（见模块文档「中断安全」）。
    pub fn open_with(dir: &Path, storage: &dyn KeyStorage) -> Result<Vault> {
        std::fs::create_dir_all(dir)?;
        let mut vault = Self::open_conn(dir)?;
        match read_key_mode(vault.connection())? {
            Some(KeyMode::Password) => {
                vault.mode = AtomicU8::new(MODE_PASSWORD);
                // 升级提交后、钥匙链条目删除前的崩溃残留：下次 open 兜底清理。
                // best-effort：Linux fallback 等场景 storage 本不可用，静默忽略。
                if let Err(e) = storage.delete() {
                    eprintln!("[vault] stale keyring cleanup skipped: {e}");
                }
            }
            Some(KeyMode::Keyring) | None => {
                vault.mode = AtomicU8::new(MODE_KEYRING);
                let key = MasterKey::load_with_storage(storage)?;
                *vault.cipher_slot.lock().expect("cipher slot poisoned") = Some(key.cipher());
                // 模式行显式落盘（历史库首次补写、新库首写，之后 no-op）：
                // 无模式行 = 「从没被 Ottr 打开过的全新库」。Linux fallback 据此
                // 区分「首装走主密码」与「keyring 库的钥匙链死了（报错不换钥）」。
                if read_key_mode_raw(&*vault.connection())?.is_none() {
                    set_meta(vault.connection(), META_KEY_MODE, KeyMode::Keyring.as_str())?;
                }
            }
        }
        Ok(vault)
    }

    /// 打开连接 + PRAGMA + 迁移的公共段（模式判定由各入口自己做）。
    fn open_conn(dir: &Path) -> Result<Vault> {
        let db_path = dir.join("vault.db");
        let conn = Connection::open(&db_path)?;

        // fix 1/5 M-3：库文件最小权限 0600（承载全部凭据密文 + meta）。best-effort：
        // 权限收紧失败（ exotic FS / 平台差异）不阻塞打开，但显式留痕。
        // WAL/SHM 副文件：清理关闭时由 SQLite 删除；崩溃残留的旧副文件在下次
        // open 时同样被这里收紧（新副文件继承 umask，残留窗口见 task-11-report）。
        restrict_db_permissions(&db_path);

        // PRAGMA 先于迁移：WAL 是持久属性，foreign_keys 不持久、每次 open 重设。
        // journal_mode 赋值会返回一行（"wal"），用 query_row 接住。
        let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            cipher_slot: Mutex::new(None),
            mode: AtomicU8::new(MODE_KEYRING),
        })
    }

    /// 主密钥模式（open 时从 meta 判定，生命周期内不变——模式切换只发生在
    /// [`Self::set_master_password`]，切换后无需重开）。
    pub fn mode(&self) -> KeyMode {
        match self.mode.load(Ordering::Relaxed) {
            MODE_PASSWORD => KeyMode::Password,
            _ => KeyMode::Keyring,
        }
    }

    /// 升级提交成功后的模式翻转（唯一合法写点；其他路径模式在构造时定死）。
    fn promote_to_password(&self) {
        self.mode.store(MODE_PASSWORD, Ordering::Relaxed);
    }

    /// 是否锁定（password 模式 open 后为 true；keyring 模式恒 false）。
    pub fn is_locked(&self) -> bool {
        self.cipher_slot
            .lock()
            .expect("cipher slot poisoned")
            .is_none()
    }

    /// 解锁门卫：需要密钥的操作入口先过这里。
    pub fn ensure_unlocked(&self) -> Result<()> {
        if self.is_locked() {
            Err(VaultError::Locked)
        } else {
            Ok(())
        }
    }

    /// 敏感字段密封器（AAD 纪律见 [`crate::crypto::aad`]）。锁定 → [`VaultError::Locked`]。
    /// Cipher 按 clone 传出（槽位零共享：lock 取走即清，不悬空引用）。
    pub fn cipher(&self) -> Result<Cipher> {
        self.cipher_slot
            .lock()
            .expect("cipher slot poisoned")
            .clone()
            .ok_or(VaultError::Locked)
    }

    /// 解锁（password 模式）：主密码 → Argon2id(密码, meta 盐) 派生 → 开 verifier
    /// 校验 → 密钥进内存。密码错 → [`VaultError::BadMasterPassword`]（GCM 认证
    /// 失败映射，绝不区分「密码错」与「校验器坏」以防侧信道枚举）。
    ///
    /// **首次解锁 = 设置主密码**（Linux fallback 首装路径：open_password_only 落了
    /// password 模式但尚无 salt/verifier）：本次输入即成为主密码，一次性写
    /// salt + verifier（与模式记录同事务）。keyring 模式调用 → [`VaultError::InvalidInput`]。
    pub fn unlock_with_password(&self, password: &str) -> Result<()> {
        if self.mode() != KeyMode::Password {
            return Err(VaultError::InvalidInput(
                "vault is in keychain mode; lock/unlock does not apply".into(),
            ));
        }
        let conn = self.connection();
        let salt_hex: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [META_KEY_KDF_SALT],
                |r| r.get(0),
            )
            .optional()?;
        let verifier_hex: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [META_KEY_VERIFIER],
                |r| r.get(0),
            )
            .optional()?;
        drop(conn);

        let (cipher, salt_hex, verifier_hex) = match (salt_hex, verifier_hex) {
            // 常规解锁：校验后放行（meta 参数已落盘，不再重写）。
            (Some(salt_hex), Some(verifier_hex)) => {
                let salt = decode_salt(&salt_hex)?;
                let cipher = derive_cipher(password, &salt)?;
                let verifier =
                    hex::decode(&verifier_hex).map_err(|_| VaultError::CorruptedMasterKey)?;
                // 校验器开封：任何失败（密码错 / blob 坏）统一映射 BadMasterPassword
                // ——不向调用方泄露「校验器损坏」与「密码错误」的区别。
                cipher
                    .open(&verifier, &verifier_aad())
                    .map_err(|_| VaultError::BadMasterPassword)?;
                (cipher, None, None)
            }
            // 首次解锁 = 设置主密码（fallback 首装）：本次输入即成为主密码，
            // salt + verifier 与模式记录一个事务落盘。
            (None, None) => {
                let mut salt = [0u8; KDF_SALT_LEN];
                rand::fill(&mut salt);
                let cipher = derive_cipher(password, &salt)?;
                let verifier = cipher.seal(VERIFIER_PLAINTEXT, &verifier_aad())?;
                (cipher, Some(hex::encode(salt)), Some(hex::encode(verifier)))
            }
            // 参数半缺 = 库被外部改写，显式报错（同 schema 版本纪律）。
            _ => return Err(VaultError::CorruptedMasterKey),
        };

        if let (Some(salt_hex), Some(verifier_hex)) = (salt_hex, verifier_hex) {
            let conn = self.connection();
            let tx = conn.unchecked_transaction()?;
            set_meta_tx(&tx, META_KEY_KDF_SALT, &salt_hex)?;
            set_meta_tx(&tx, META_KEY_VERIFIER, &verifier_hex)?;
            set_meta_tx(&tx, META_KEY_MODE, KeyMode::Password.as_str())?;
            tx.commit()?;
        }
        *self.cipher_slot.lock().expect("cipher slot poisoned") = Some(cipher);
        Ok(())
    }

    /// 手动锁定（password 模式）：Master Key（Cipher 槽位）取走 drop——key
    /// schedule 经 aes-gcm zeroize feature ZeroizeOnDrop 清零。keyring 模式是
    /// no-op（无锁概念，重开即得钥，锁了也白锁）。幂等。
    pub fn lock(&self) {
        if self.mode() == KeyMode::Password {
            *self.cipher_slot.lock().expect("cipher slot poisoned") = None;
        }
    }

    /// 升级到主密码模式（keyring → password，设置页向导的本体）：
    /// 1. 新盐随机生成，新钥 = Argon2id(新密码, 新盐)；
    /// 2. **单个 SQLite 事务**内：按 [`scan_registry`] 全表扫所有 `*_enc` 密文列
    ///    （扫描 SQL 从注册表生成，见其文档），旧钥开、新钥封（AAD 不变——
    ///    `{table}:{id}:{field}` 绑定面不动），随后写 meta（mode=password +
    ///    salt + verifier，verifier 用新钥密封）；
    /// 3. 提交成功后新 Cipher 进内存槽位（保持解锁态，向导无需再输密码）。
    ///
    /// 中断安全（TDD 三件套之三）：事务提交前任何一步失败（含旧密文损坏、
    /// 进程崩溃）→ 整体回滚，库仍是 keyring 模式、旧钥完全可用，可直接重试；
    /// 提交后钥匙链条目的删除由调用方（src-tauri 持有 storage 句柄）执行，
    /// 漏删的残留由下次 open 兜底清理（见 [`Self::open_with`]）。
    ///
    /// `progress(done, total)` 逐字段回调（向导进度条；total 预先 COUNT 得出）。
    /// 返回值 = 重密封的字段数。已 password 模式 / 锁定 → 显式报错。
    pub fn set_master_password(
        &self,
        password: &str,
        progress: &mut dyn FnMut(usize, usize),
    ) -> Result<usize> {
        if password.chars().count() < MASTER_PASSWORD_MIN_LEN {
            return Err(VaultError::InvalidInput(format!(
                "master password must be at least {MASTER_PASSWORD_MIN_LEN} characters"
            )));
        }
        if self.mode() == KeyMode::Password {
            return Err(VaultError::InvalidInput(
                "vault already uses a master password".into(),
            ));
        }
        let old = self.cipher()?; // 锁定 → Locked

        let mut salt = [0u8; KDF_SALT_LEN];
        rand::fill(&mut salt);
        // 盐的清理收口（fix 1/5 M-4）：闭包内任何错误早退路径统一清零后返回
        // ——盐虽随密文明文落盘（非密级），但清零是零成本的纵深防御。
        let outcome = (|| -> Result<usize> {
            let new = derive_cipher(password, &salt)?;
            let verifier = new.seal(VERIFIER_PLAINTEXT, &verifier_aad())?;

            let conn = self.connection();
            // 总数：按注册表逐表生成 COUNT（count 非空列求和）。
            let mut total: i64 = 0;
            for (table, cols) in scan_plan() {
                let counts = cols
                    .iter()
                    .map(|c| format!("count({})", c.column))
                    .collect::<Vec<_>>()
                    .join(" + ");
                total += conn.query_row(&format!("SELECT {counts} FROM {table}"), [], |r| {
                    r.get::<_, i64>(0)
                })?;
            }
            let tx = conn.unchecked_transaction()?;

            // 逐表扫描重密封（fix 1/5 I-2b）：SELECT/UPDATE 的列清单一律由
            // [`scan_registry`] 生成——单一事实源，不存在第二处手写列名。
            // 读明文集中在内存即刻重封，不落任何中间文件；rowid = 各表
            // INTEGER PRIMARY KEY 的别名（AUTOINCREMENT 保证永不复用，AAD
            // 绑定值与实体层写入时一致）。
            // 【T11 转交顺手项（Task 12）】读改写不再共用一条游标：SELECT 游标
            // 未关闭时对同表 UPDATE，SQLite 对未访问行的可见性行为未定义
            // （可能跳行/重访）。改为按 rowid 分批物化（每批 [`RESEAL_BATCH`]
            // 行，语句作用域结束即关游标）后再逐行 UPDATE——UPDATE 不改 rowid，
            // `rowid > ?` 分页键安全，内存占用恒有界。
            const RESEAL_BATCH: i64 = 64;
            let mut done = 0usize;
            for (table, cols) in scan_plan() {
                let col_list = cols.iter().map(|c| c.column).collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT rowid, {col_list} FROM {table} WHERE rowid > ?1
                     ORDER BY rowid LIMIT {RESEAL_BATCH}"
                );
                let mut last_rowid = 0i64;
                loop {
                    // 物化一批 (rowid, 密文…)；stmt/rows 随块结束 drop（游标已关），
                    // 此后同表 UPDATE 是定义良好的语句序列。
                    let batch: Vec<(i64, Vec<Option<Vec<u8>>>)> = {
                        let mut stmt = tx.prepare(&sql)?;
                        let mut rows = stmt.query(params![last_rowid])?;
                        let mut batch = Vec::new();
                        while let Some(row) = rows.next()? {
                            let row_id: i64 = row.get(0)?;
                            let mut blobs = Vec::with_capacity(cols.len());
                            for idx in 0..cols.len() {
                                blobs.push(row.get::<_, Option<Vec<u8>>>(idx + 1)?);
                            }
                            batch.push((row_id, blobs));
                        }
                        batch
                    };
                    if batch.is_empty() {
                        break;
                    }
                    for (row_id, mut blobs) in batch {
                        for (idx, col) in cols.iter().enumerate() {
                            let Some(blob) = blobs[idx].take() else {
                                continue;
                            };
                            let aad = col.aad(row_id);
                            let mut plain = old.open(&blob, &aad)?; // 旧钥坏 → 整体回滚
                            let resealed = match new.seal(&plain, &aad) {
                                Ok(b) => b,
                                Err(e) => {
                                    plain.zeroize();
                                    return Err(e);
                                }
                            };
                            plain.zeroize();
                            tx.execute(
                                &format!("UPDATE {table} SET {} = ?1 WHERE rowid = ?2", col.column),
                                params![resealed, row_id],
                            )?;
                            done += 1;
                            progress(done, total.max(1) as usize);
                        }
                        last_rowid = row_id;
                    }
                }
            }
            set_meta_tx(&tx, META_KEY_MODE, KeyMode::Password.as_str())?;
            set_meta_tx(&tx, META_KEY_KDF_SALT, &hex::encode(salt))?;
            set_meta_tx(&tx, META_KEY_VERIFIER, &hex::encode(&verifier))?;
            tx.commit()?;

            // 事务已提交：新钥接管内存槽位（保持解锁态）；旧钥材料随 old Cipher
            // 在本函数结束处 drop（zeroize）。meta 翻转与密文同事务，无中间态。
            self.promote_to_password();
            *self.cipher_slot.lock().expect("cipher slot poisoned") = Some(new);
            Ok(done)
        })();
        salt.zeroize();
        outcome
    }

    /// 单连接串行访问（rusqlite Connection 非 Sync，Mutex 是 Tauri 命令共享的标准形态）。
    /// 明文面（settings/meta/schema 读取）锁定时保持可用——见模块文档「锁定语义」。
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("vault connection poisoned")
    }

    /// 组合式单次加锁：闭包内完成全部语句后统一释放。
    /// 实体层的多语句操作一律走本方法——在持有 `connection()` 守卫的期间再调
    /// 任何会重新加锁的高层方法，都会造成同线程 Mutex 二次加锁死锁
    /// （T8 known_hosts_state_machine 挂死事故的根因，见 entities.rs KnownHosts）。
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        f(&self.connection())
    }

    /// 当前 schema 版本（读 meta.schema_version；库为空时为 0）。
    pub fn schema_version(&self) -> Result<u32> {
        current_schema_version(&self.connection())
    }
}

/// 库文件权限收紧到 0600（fix 1/5 M-3）：主文件必做；-wal/-shm 残留 best-effort
/// （存在才收，正常关闭时 SQLite 已删）。Unix 专属；Windows 的 ACL 语义不同，
/// 记 runbook（task-11-report Fix round 1/5 节）。
fn restrict_db_permissions(db_path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::Permissions::from_mode(0o600);
        for path in [
            db_path.to_path_buf(),
            db_path.with_file_name("vault.db-wal"),
            db_path.with_file_name("vault.db-shm"),
        ] {
            if let Err(e) = std::fs::set_permissions(&path, mode.clone()) {
                if path == *db_path || path.exists() {
                    eprintln!("[vault] chmod 0600 failed ({}): {e}", path.display());
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = db_path; // Windows：ACL 面挂 runbook（本函数为 no-op）
    }
}

/// 重密封扫描注册表项（fix 1/5 I-2）：`table` + `column` + `field` 三元组——
/// 表名 / 密文列名（`*_enc`）/ AAD 字段名（实体层短名，**不是列名**）。
/// pub 仅因守卫测试（tests/password_mode_test.rs）需读注册表比对 schema；
/// 勿当公共 API 消费。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SecretColumn {
    pub table: &'static str,
    pub column: &'static str,
    pub field: &'static str,
}

impl SecretColumn {
    /// AAD 与实体层同源约定：`{table}:{row_id}:{field}`（entities.rs `seal_fields`
    /// 写入时用的就是这个形态，重密封必须逐字节复刻，否则旧钥开封即失败——
    /// GCM 认证强制）。
    fn aad(self, row_id: i64) -> String {
        crate::aad(self.table, row_id, self.field)
    }
}

/// 【I-2 单一注册表】全库所有承载 `*_enc` 密文列的清单——`set_master_password`
/// 重密封扫描的**唯一事实源**（COUNT/SELECT/UPDATE 的 SQL 全部从它生成）。
///
/// **新增 `*_enc` 列（含未来 notify_channels.config_enc 等新表）必须登记于此**：
/// 漏登 = 升级后旧钥删除、该列密文永久 GCM 认证失败（静默数据损毁）。
/// 守卫测试 `reencrypt_scan_covers_all_enc_columns`（tests/password_mode_test.rs）
/// 从 sqlite_master/PRAGMA 动态收集全库 `*_enc` 列与本表比对——新增列而漏改
/// 注册表时测试必红。
pub fn scan_registry() -> &'static [SecretColumn] {
    &[
        SecretColumn {
            table: "credentials",
            column: "secret_enc",
            field: "secret",
        },
        SecretColumn {
            table: "credentials",
            column: "passphrase_enc",
            field: "passphrase",
        },
        SecretColumn {
            table: "credentials",
            column: "totp_secret_enc",
            field: "totp_secret",
        },
        // Task 13（0006）：AI provider api key 密封 KV
        SecretColumn {
            table: "secrets",
            column: "value_enc",
            field: "value",
        },
        // Task 7（0011）：会话纪要摘要（内容含命令序列——敏感面走密封通道）
        SecretColumn {
            table: "session_summaries",
            column: "summary_enc",
            field: "summary",
        },
    ]
}

/// 注册表 → 扫描计划（按表分组、保序；要求注册表内同表列相邻——当前形态
/// 天然满足）。每组 = (表名, 该表待重封列清单)。
fn scan_plan() -> Vec<(&'static str, Vec<SecretColumn>)> {
    let mut plan: Vec<(&'static str, Vec<SecretColumn>)> = Vec::new();
    for col in scan_registry() {
        match plan.last_mut() {
            Some((table, cols)) if *table == col.table => cols.push(*col),
            _ => plan.push((col.table, vec![*col])),
        }
    }
    plan
}

/// 主密码派生 + 立即密封器化（派生中间值用后即清）。返回值只含 `Aes256Gcm`
/// 实例（zeroize feature 下其 key schedule ZeroizeOnDrop），裸 key 字节不出本函数。
fn derive_cipher(password: &str, salt: &[u8]) -> Result<Cipher> {
    let mut key = crate::master_key::derive_key_argon2id(password, salt)?;
    let cipher = Cipher::new(&key)?;
    key.zeroize();
    Ok(cipher)
}

fn decode_salt(hex_salt: &str) -> Result<[u8; KDF_SALT_LEN]> {
    let bytes = hex::decode(hex_salt.trim()).map_err(|_| VaultError::CorruptedMasterKey)?;
    bytes.try_into().map_err(|_| VaultError::CorruptedMasterKey)
}

/// 读主密钥模式原始行（meta 缺行 = None）。
fn read_key_mode_raw(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [META_KEY_MODE],
            |r| r.get(0),
        )
        .optional()?)
}

/// 读主密钥模式（meta 缺行 = None；非法值 = 显式损坏错误，不静默当 keyring）。
fn read_key_mode(conn: MutexGuard<'_, Connection>) -> Result<Option<KeyMode>> {
    match read_key_mode_raw(&conn)? {
        None => Ok(None),
        Some(s) => KeyMode::parse(&s)
            .map(Some)
            .ok_or_else(|| VaultError::CorruptedSchemaVersion(format!("master_key.mode = {s:?}"))),
    }
}

/// meta 表 upsert（借用连接版——open 路径用）。
fn set_meta(conn: MutexGuard<'_, Connection>, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// meta 表 upsert（事务内版——多行原子提交用）。
fn set_meta_tx(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let current = current_schema_version(conn)?;
    if current > LATEST_SCHEMA_VERSION {
        return Err(VaultError::SchemaTooNew {
            db: current,
            app: LATEST_SCHEMA_VERSION,
        });
    }
    for &(version, sql) in MIGRATIONS {
        if version <= current {
            continue;
        }
        // 每个迁移一个事务：DDL+版本记录原子生效，中断不留半套表。
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        upsert_schema_version(&tx, version)?;
        tx.commit()?;
    }
    Ok(())
}

fn upsert_schema_version(conn: &Connection, version: u32) -> Result<()> {
    set_meta_tx(conn, "schema_version", &version.to_string())
}

fn current_schema_version(conn: &Connection) -> Result<u32> {
    let meta_exists: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meta'",
        [],
        |r| r.get(0),
    )?;
    if meta_exists == 0 {
        return Ok(0);
    }
    let raw = match conn.query_row(
        "SELECT value FROM meta WHERE key='schema_version'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    // T3 评审要求收紧（Task 4 落地）：parse 失败 → 显式错误。绝不能静默按 0 处理——
    // 那会让损坏的库被当成空库重跑全部迁移，静默改写并掩盖真实损坏。
    match raw.parse::<u32>() {
        Ok(v) => Ok(v),
        Err(_) => Err(VaultError::CorruptedSchemaVersion(raw)),
    }
}
