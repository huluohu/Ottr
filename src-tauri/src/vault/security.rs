//! 安全状态机（T11，A7）：解锁/锁定/升降级向导/重置应用 + OTTR_DEV_UNLOCK
//! 旁路判定。纯搬家拆分（原 vault.rs 单文件）——锁定语义零改动。

use tauri::{AppHandle, Emitter, Manager, State};

use ottr_vault::master_key::KeyStorage as _;
use ottr_vault::{KeyMode, Vault, VaultError};

use super::{CmdResult, VaultState};

// --- 安全状态机（T11，A7）----------------------------------------------------
// 语义矩阵（完整版见 task-11-report）：keyring 模式无锁概念（open 即解锁，
// lock/unlock 拒绝/无效）；password 模式 open 即锁定 → unlock_with_password 或
// 自动锁定后解锁。事件：ottr://vault-locked / vault-unlocked（Rust 侧统一发，
// 前端状态机订阅）；ottr://reencrypt-progress（升级向导进度条）。

/// 安全状态快照（SecuritySettings 页/锁定屏启动查询）。
#[derive(Clone, serde::Serialize)]
pub struct SecurityStatus {
    /// "keyring" | "password"（KeyMode::as_str）
    pub mode: String,
    pub locked: bool,
}

#[tauri::command]
pub fn vault_security_status(state: State<'_, VaultState>) -> CmdResult<SecurityStatus> {
    Ok(SecurityStatus {
        mode: state.0.mode().as_str().to_string(),
        locked: state.0.is_locked(),
    })
}

/// 解锁（password 模式）：主密码校验通过后 Master Key 进内存。
/// 成功发 `ottr://vault-unlocked`（LockScreen 收口；keyring 模式/密码错显式报错）。
///
/// **明文主密码的 IPC 副本边界（BL-202 成文，不改行为）**——密码从输入框到
/// 消费点的完整生命周期与既定边界：
///
/// 1. **webview 侧**：`LockScreen` useState（向导：SecuritySettings，成功/
///    失败后清空重置）。JS 字符串在 GC 堆上**不可主动清零**——已知边界，
///    收敛手段是输入框 `type="password"`（不进 DOM 明文）+ 组件随锁定态
///    卸载后引用随 GC 回收。
/// 2. **IPC 面**：`invoke("vault_unlock", { password })` → Tauri v2 进程内
///    反序列化产生一份 `String` 副本（本命令栈上）。进程内 IPC 不出进程
///    边界（无网络面）。
/// 3. **消费点**：以 `&str` 借给 [`ottr_vault::Vault::unlock_with_password`]
///    → Argon2id 派生 → **派生中间值（32B RawKey）用后即清**（store.rs
///    `derive_cipher` 内 `key.zeroize()`）；内存中留存的只有
///    [`ottr_vault::Cipher`]（aes-gcm zeroize feature：key schedule
///    ZeroizeOnDrop，`vault_lock` 即取走 drop）。
/// 4. **副本清零边界**：命令参数 `String` 与 IPC 反序列化中间缓冲在命令
///    结束时普通 drop（非 zeroizing）——堆上留有可被同进程后续分配覆写的
///    残留。**裁定接受**：本地单用户进程、副本生命周期限于单次命令调用、
///    全链 zeroize 需自定义分配器改造，边际收益不成比例；作为交换，硬性
///    不变量是：密码**不落盘、不进日志/事件/错误文案/遥测**（错误路径只回
///    `VaultError::Display`，如 "master password is incorrect"，绝不内插
///    密码本身），且**不跨命令缓存**（每次解锁重新输入）。
#[tauri::command]
pub fn vault_unlock(
    state: State<'_, VaultState>,
    app: AppHandle,
    password: String,
) -> CmdResult<()> {
    state
        .0
        .unlock_with_password(&password)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("ottr://vault-unlocked", ());
    Ok(())
}

/// 开发/验收旁路开关（OTTR_DEV_UNLOCK 环境变量）的纯判定：仅值恰为 "1" 时真。
/// 用途 = 本地开发与验收仪表化（截屏/自动化走查需要解锁态在长会话中稳定）：
/// * [`vault_lock`] 开头命中 → 直接 Ok（不落锁、不发事件——幂等 no-op）；
/// * security::autolock_minutes 开头命中 → 返回 None（失焦自动锁定调度整体
///   禁用，计时器从不启动）。
///
/// **正常用户不受影响**：未设置该变量时两个 gate 与既往行为逐字节一致。
///
/// **披露边界**：旁路只防「再锁」（手动锁定/自动锁定），不解「已锁」——密码
/// 模式已锁定的库仍需主密码解锁（验收/开发请用全新伪 home 数据目录，或先
/// 解锁一次；钥匙链模式本无密码，天然不受影响）。
///
/// 纯函数带参测（三态单测见本模块 tests）：调用点传 `std::env::var_os` 结果，
/// 本函数不读全局 env——测试不需要可变全局注入。
pub(crate) fn dev_unlock_enabled(raw: Option<&std::ffi::OsStr>) -> bool {
    raw.is_some_and(|v| v == std::ffi::OsStr::new("1"))
}

/// 手动锁定（password 模式）。幂等；成功才发 `ottr://vault-locked`
/// （Task 14 快捷键挂同一命令）。keyring 模式无锁概念——**直接返回不发事件**
/// （fix 1/5 M-1）：前端 LockScreen 只订阅事件置锁，keyring 模式带外调用若发
/// 事件会弹一个永远解不开的锁屏（无解锁路径）。
#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>, app: AppHandle) -> CmdResult<()> {
    // OTTR_DEV_UNLOCK 旁路（本地开发/验收仪表化）：不落锁不发事件直接 Ok
    //（语义见 dev_unlock_enabled 文档；正常用户未设置 = 走原路径）。
    if dev_unlock_enabled(std::env::var_os("OTTR_DEV_UNLOCK").as_deref()) {
        return Ok(());
    }
    if state.0.mode() == KeyMode::Password {
        state.0.lock();
        let _ = app.emit("ottr://vault-locked", ());
    }
    Ok(())
}

/// 升级到主密码模式（设置页向导本体，keyring → password）：
/// 重加密逐字段发 `ottr://reencrypt-progress`（向导进度条），成功后删除钥匙链
/// 旧条目（失败路径什么都不动——vault 层单事务保证，残留由下次 open 兜底）。
/// 返回值 = 重密封字段数（向导完成页展示）。
/// 明文主密码的 IPC 副本边界与 [`vault_unlock`] 同一套（BL-202 成文，见彼处
/// 四点生命周期）；本命令在库内跑的是重密封（Argon2id 派生 + 全表重加密），
/// 副本生命周期因 Argon2 拉长到秒级，结论不变：不落盘、不进日志、不缓存。
#[tauri::command]
pub fn vault_upgrade_to_master_password(
    state: State<'_, VaultState>,
    app: AppHandle,
    password: String,
) -> CmdResult<usize> {
    let emitter = app.clone();
    let fields = state
        .0
        .set_master_password(&password, &mut |done, total| {
            let _ = emitter.emit(
                "ottr://reencrypt-progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
        .map_err(|e| e.to_string())?;
    // 旧 Master Key 条目删除（升级成功的收尾）。失败不致命——残留条目在下次
    // open（password 模式）被兜底清理，且不再参与任何解锁路径。
    if let Err(e) =
        ottr_vault::master_key::KeyringStorage::new(ottr_vault::master_key::DEFAULT_SERVICE)
            .delete()
    {
        eprintln!("[vault-upgrade] stale keyring entry cleanup failed: {e}");
    }
    let _ = app.emit("ottr://vault-unlocked", ());
    Ok(fields)
}

/// 降级到免密钥匙链模式（password → keyring，设置页「切换到免密模式」向导）：
/// 先验当前主密码（复用 [`Vault::unlock_with_password`] 校验路径——密码错
/// 如实拒绝 [`VaultError::BadMasterPassword`]；已解锁态下该校验无副作用，
/// 锁定态则顺带解锁——降级本就需要旧钥在内存），再调库层
/// [`Vault::clear_master_password`]（单事务重密封 + meta 翻转，崩溃安全顺序
/// 见 ottr-vault store.rs）。成功后发 `ottr://vault-unlocked`（降级后必为
/// 解锁态，前端状态机单一收口置 unlocked + 重拉 vault 数据）。
///
/// `storage` 注入纪律同 [`wipe_vault_data`]：生产 = [`KeyringStorage::new(DEFAULT_SERVICE)`]，
/// 测试 = InMemoryStorage（单测绝不碰真钥匙链）。
/// 明文主密码的 IPC 副本边界与 [`vault_unlock`] / [`vault_upgrade_to_master_password`]
/// 同一套（BL-202 成文）：不落盘、不进日志/事件/错误文案、不跨命令缓存。
pub(crate) fn downgrade_to_keychain(
    vault: &Vault,
    storage: &dyn ottr_vault::master_key::KeyStorage,
    password: &str,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<(), VaultError> {
    vault.unlock_with_password(password)?;
    vault.clear_master_password(storage, progress)
}

/// 降级命令（设置页「切换到免密模式」向导本体，password → keyring）：
/// 重密封逐字段发 `ottr://reencrypt-progress`（与升级向导同款进度事件），
/// 成功发 `ottr://vault-unlocked`。返回值无载荷（降级完成态由模式/事件表达）。
#[tauri::command]
pub fn vault_downgrade_to_keychain(
    state: State<'_, VaultState>,
    app: AppHandle,
    password: String,
) -> CmdResult<()> {
    let storage =
        ottr_vault::master_key::KeyringStorage::new(ottr_vault::master_key::DEFAULT_SERVICE);
    let emitter = app.clone();
    downgrade_to_keychain(&state.0, &storage, &password, &mut |done, total| {
        let _ = emitter.emit(
            "ottr://reencrypt-progress",
            serde_json::json!({ "done": done, "total": total }),
        );
    })
    .map_err(|e| e.to_string())?;
    let _ = app.emit("ottr://vault-unlocked", ());
    Ok(())
}

// --- 重置应用（BL-537 清偿：锁定屏「忘记密码？」终局出路）---------------------
// 主密码不可找回（AES-256-GCM，Master Key 由主密码派生——密码丢失即密文永久
// 不可开封），唯一出路 = 重置应用：清本机库 + 清钥匙链条目，回到首启状态
// （1Password 同款语义）。安全纪律：
//   * confirm 门卫——不带显式 confirm=true 的调用在入口拒绝，不动任何数据；
//   * abort-safe 顺序——先删钥匙链条目（失败即中止，库文件原样保留可重试），
//     再清数据目录（逐条目失败如实上抛，残余留给重试）；
//   * 清完 `app.restart()`——进程级回到首启链：vault-init 线程重跑 `open_auto`
//     （目录已空 → 全新 keyring 模式库、无锁）→ 前端就绪门/锁定状态机自然落
//     到首启面。不做进程内 vault 热替换（Arc<Vault> 不可换、连接/密钥槽残留
//     面大），重启是唯一语义完整的「回到首启」。

/// 重置确认门卫（pub(crate) 供单测）：confirm 必须显式 `Some(true)`。
/// 缺参（Tauri 反序列化 null → None）与显式 false 一律拒绝。
pub(crate) fn ensure_reset_confirmed(confirm: Option<bool>) -> Result<(), String> {
    if confirm == Some(true) {
        return Ok(());
    }
    Err(
        "vault_reset requires explicit confirmation: pass confirm=true (this wipes ALL local \
         vault data and the keychain entry)"
            .into(),
    )
}

/// 清空 vault 数据目录全部条目（vault.db/-wal/-shm、cron-runs/、recordings/、
/// mcp.sock 等——目录本身保留，重开时 create_dir_all 幂等）+ 删除钥匙链
/// 全部条目（`storages` 逐个删：Master Key + 同步信封口令——漏清后者则
/// 重置后云信封仍可被记忆口令解密，「回到首启」语义破产，T5 评审 P1）。
/// `storages` 注入（生产 = KeyringStorage 两条目，测试 = InMemoryStorage，
/// 单测绝不碰真钥匙链）。错误如实上抛，不做部分成功的静默伪装。
pub(crate) fn wipe_vault_data(
    dir: &std::path::Path,
    storages: &[&dyn ottr_vault::master_key::KeyStorage],
) -> Result<(), String> {
    // ① 钥匙链条目先删（abort-safe：任一条目清不掉就中止，库文件原样保留，
    // 用户可原样重试；条目序 = 调用方语义序，无跨条目依赖）。NoEntry 已由
    // KeyringStorage::delete 收敛为 Ok（条目本就不存在 = 已是目标态）。
    for (i, storage) in storages.iter().enumerate() {
        storage
            .delete()
            .map_err(|e| format!("keychain delete (entry {i}): {e}"))?;
    }
    // ② 数据目录逐条目清除（文件/子目录一视同仁；删除中的打开句柄在
    // macOS/Windows 上 unlink 语义由各平台兜底，进程重启后无残留引用）。
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|e| format!("readdir {}: {e}", dir.display()))?
            .path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

/// 重置应用命令（锁定屏「忘记密码？」确认后调用）。`confirm` 必须显式 true；
/// 清库成功即进程重启（本命令不返回——`AppHandle::restart` diverges），前端
/// invoke 永不 resolve 是预期形态；重启失败/清库失败错误如实回传上屏。
#[tauri::command]
pub fn vault_reset(
    state: State<'_, VaultState>,
    app: AppHandle,
    confirm: Option<bool>,
) -> CmdResult<()> {
    ensure_reset_confirmed(confirm)?;
    // 先落锁：password 模式把 Master Key 清出内存再动盘上数据（重启前不留
    // 敏感材料；keyring 模式 lock 本就 no-op 语义）。
    if state.0.mode() == KeyMode::Password {
        state.0.lock();
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    // 防呆：app_data_dir 解析异常退化成根/无父目录时拒绝清（宁可不重置）。
    if dir.parent().is_none() || dir == std::path::Path::new("/") {
        return Err(format!(
            "refusing to wipe suspicious data dir: {}",
            dir.display()
        ));
    }
    // 两条钥匙链条目：Master Key + 同步信封口令（重置 = 回到首启态，本应用
    // 在正式 service 下的条目一个不留；entry 序对应错误消息 entry 0/1）。
    let master =
        ottr_vault::master_key::KeyringStorage::new(ottr_vault::master_key::DEFAULT_SERVICE);
    let sync_pass = ottr_vault::master_key::KeyringStorage::with_account(
        crate::commands::sync_git::SYNC_SERVICE,
        crate::commands::sync_git::SYNC_ACCOUNT,
    );
    wipe_vault_data(&dir, &[&master, &sync_pass])?;
    eprintln!(
        "[vault] reset confirmed: data dir wiped ({}), restarting app",
        dir.display()
    );
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use ottr_vault::{CredentialInput, Credentials};

    // --- vault_reset（BL-537 清偿：锁定屏「忘记密码？」终局出路）---------------

    /// 确认门卫：confirm 必须显式 Some(true)。缺参/显式 false 一律拒绝——
    /// 破坏性命令不接受任何静默默认（漏传 confirm = Tauri 反序列化层缺参，
    /// 也走 None 拒绝路径，不会意外清库）。
    #[test]
    fn reset_confirm_guard_rejects_everything_but_explicit_true() {
        assert!(
            ensure_reset_confirmed(None).is_err(),
            "缺 confirm 参数 = 拒绝"
        );
        assert!(
            ensure_reset_confirmed(Some(false)).is_err(),
            "显式 false = 拒绝"
        );
        assert_eq!(ensure_reset_confirmed(Some(true)), Ok(()));
        let err = ensure_reset_confirmed(None).unwrap_err();
        assert!(
            err.contains("confirm"),
            "错误消息必须指明 confirm 契约（前端可诊断）：{err}"
        );
    }

    /// wipe 清空数据目录全部条目（文件/子目录一视同仁）+ 删除钥匙链条目
    /// （Master Key + 同步信封口令——T5 评审 P1：漏清 sync-passphrase 会让
    /// 重置后云信封仍可被记忆口令解密，「回到首启」语义破产）。
    /// storage 注入 InMemoryStorage——单测绝不碰真钥匙链（测试纪律同
    /// ottr-vault master_key）。
    #[test]
    fn wipe_vault_data_clears_dir_and_keychain_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        std::fs::write(dir.path().join("vault.db-wal"), b"wal").unwrap();
        let sub = dir.path().join("cron-runs");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("1-2.log"), b"log").unwrap();

        let master = ottr_vault::master_key::InMemoryStorage::default();
        let sync_pass = ottr_vault::master_key::InMemoryStorage::default();
        use ottr_vault::master_key::KeyStorage as _;
        master.save("master-key-material").unwrap();
        sync_pass.save("sync-passphrase-material").unwrap();

        wipe_vault_data(dir.path(), &[&master, &sync_pass]).unwrap();

        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "数据目录必须清空（含子目录 cron-runs）"
        );
        assert_eq!(
            master.load().unwrap(),
            None,
            "钥匙链 Master Key 条目必须删除"
        );
        assert_eq!(
            sync_pass.load().unwrap(),
            None,
            "钥匙链同步口令条目必须删除（重置后云信封不得可解）"
        );
    }

    /// 钥匙链删除失败 → 整体报错且**先于任何文件删除**（abort-safe 顺序：
    /// 钥匙链清不掉就绝不碰库文件，用户可原样重试）。用「不可写目录」构造
    /// 文件删除失败场景验证错误如实上抛。
    #[test]
    fn wipe_vault_data_reports_storage_failure_without_touching_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        // 刻意损坏的 storage：delete 恒败（模拟钥匙链拒绝访问）。
        struct BrokenStorage;
        impl ottr_vault::master_key::KeyStorage for BrokenStorage {
            fn load(&self) -> ottr_vault::Result<Option<String>> {
                Ok(None)
            }
            fn save(&self, _secret: &str) -> ottr_vault::Result<()> {
                Ok(())
            }
            fn delete(&self) -> ottr_vault::Result<()> {
                Err(ottr_vault::VaultError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "keychain denied",
                )))
            }
        }
        let err = wipe_vault_data(dir.path(), &[&BrokenStorage]).unwrap_err();
        assert!(err.contains("keychain"), "错误须指明钥匙链环节：{err}");
        assert_eq!(
            std::fs::read_to_string(&db).unwrap(),
            "cipher",
            "钥匙链删除失败时库文件必须原样保留（可重试）"
        );
    }

    /// 第二条目（同步口令）删除失败同样 abort-safe：任一钥匙链条目清不掉
    /// 就绝不碰库文件（T5 评审 P1 伴随面——重置必须两条目原子语义）。
    #[test]
    fn wipe_vault_data_sync_entry_failure_aborts_before_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("vault.db");
        std::fs::write(&db, b"cipher").unwrap();
        struct BrokenStorage;
        impl ottr_vault::master_key::KeyStorage for BrokenStorage {
            fn load(&self) -> ottr_vault::Result<Option<String>> {
                Ok(None)
            }
            fn save(&self, _secret: &str) -> ottr_vault::Result<()> {
                Ok(())
            }
            fn delete(&self) -> ottr_vault::Result<()> {
                Err(ottr_vault::VaultError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "keychain denied",
                )))
            }
        }
        let master = ottr_vault::master_key::InMemoryStorage::default();
        let err = wipe_vault_data(dir.path(), &[&master, &BrokenStorage]).unwrap_err();
        assert!(err.contains("keychain"), "错误须指明钥匙链环节：{err}");
        assert_eq!(
            std::fs::read_to_string(&db).unwrap(),
            "cipher",
            "同步口令条目删除失败时库文件必须原样保留（可重试）"
        );
    }

    /// 目录删除失败（只读目录）→ 错误如实上抛，不静默（残余文件留给重试）。
    #[test]
    fn wipe_vault_data_reports_dir_errors() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ottr_vault::master_key::InMemoryStorage::default();
        // 目录本身不存在 → read_dir 失败必须显式报错（app_data_dir 解析异常
        // 的兜底面，静默 Ok 会伪装成「已重置」）。
        let missing = dir.path().join("does-not-exist");
        assert!(wipe_vault_data(&missing, &[&storage]).is_err());
    }

    // --- 降级到免密钥匙链模式（no-lock 任务，2026-10-05）----------------------

    use ottr_vault::store::KeyMode as TestKeyMode;

    /// 密码错误如实拒绝（BadMasterPassword 语义，防误触门卫）：错误上抛、
    /// 模式仍 password、数据仍可用原密码解锁（校验失败不破坏任何状态）。
    #[test]
    fn downgrade_helper_rejects_wrong_password() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ottr_vault::master_key::InMemoryStorage::default();
        let vault = Vault::open_password_only(dir.path()).unwrap();
        vault.unlock_with_password("correct horse").unwrap(); // 首解锁 = 设主密码
        assert_eq!(vault.mode(), TestKeyMode::Password);

        let err =
            downgrade_to_keychain(&vault, &storage, "wrong password", &mut |_, _| {}).unwrap_err();
        assert!(matches!(err, VaultError::BadMasterPassword), "实际 {err:?}");
        assert_eq!(vault.mode(), TestKeyMode::Password, "拒绝不得翻转模式");
        assert!(
            storage.load().unwrap().is_none(),
            "拒绝路径不得写钥匙链（新钥未生成/未落）"
        );
        vault.unlock_with_password("correct horse").unwrap();
        assert!(!vault.is_locked(), "失败后原密码解锁仍可用");
    }

    /// 成功路径：验密 → 库层降级 → keyring 模式解锁态、钥匙链新钥就位、
    /// 数据跨模式重密封后可解。
    #[test]
    fn downgrade_helper_success_path() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ottr_vault::master_key::InMemoryStorage::default();
        let vault = Vault::open_password_only(dir.path()).unwrap();
        vault.unlock_with_password("correct horse").unwrap();
        let cred = Credentials::create(
            &vault,
            &CredentialInput {
                name: None,
                kind: ottr_vault::CredentialKind::Password,
                secret: Some("downgraded-secret-γ".into()),
                key_pub: None,
                passphrase: None,
                totp_secret: None,
            },
        )
        .unwrap();

        let mut progress = Vec::new();
        downgrade_to_keychain(&vault, &storage, "correct horse", &mut |done, total| {
            progress.push((done, total));
        })
        .unwrap();

        assert_eq!(vault.mode(), TestKeyMode::Keyring);
        assert!(!vault.is_locked(), "降级后免密（解锁态）");
        assert_eq!(progress.last(), Some(&(1, 1)));
        assert!(
            storage.load().unwrap().is_some(),
            "钥匙链必须有新 Master Key 条目"
        );
        assert_eq!(
            Credentials::reveal(&vault, cred.id, ottr_vault::SecretField::Secret)
                .unwrap()
                .as_deref(),
            Some("downgraded-secret-γ")
        );
    }

    // --- OTTR_DEV_UNLOCK 开发/验收旁路 ----------------------------------------

    /// 纯函数三态：仅值恰为 "1" 为真；未设置/其他值一律假。严格匹配防意外
    /// 命中（"10"/"1 "/"true" 都不算开——旁路是显式仪表化动作，宁可打不开）。
    /// 调用点（vault_lock / autolock gate）传 `std::env::var_os` 结果，本函数
    /// 不读全局 env——可变全局注入在单测里回避，纯函数带参测。
    #[test]
    fn dev_unlock_enabled_is_true_only_for_exact_1() {
        assert!(!dev_unlock_enabled(None), "未设置 = 关（正常用户不受影响）");
        assert!(
            dev_unlock_enabled(Some(std::ffi::OsStr::new("1"))),
            "恰为 1 = 开"
        );
        assert!(!dev_unlock_enabled(Some(std::ffi::OsStr::new("0"))));
        assert!(!dev_unlock_enabled(Some(std::ffi::OsStr::new(""))));
        assert!(!dev_unlock_enabled(Some(std::ffi::OsStr::new("true"))));
        assert!(
            !dev_unlock_enabled(Some(std::ffi::OsStr::new("10"))),
            "前缀不算（严格匹配）"
        );
        assert!(
            !dev_unlock_enabled(Some(std::ffi::OsStr::new("1 "))),
            "带空白不算"
        );
    }
}
