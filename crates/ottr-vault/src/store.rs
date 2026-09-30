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

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::master_key::{KeyStorage, MasterKey};
use crate::{Cipher, Result, VaultError};

/// 程序支持的最新 schema 版本（= MIGRATIONS 末位）。
pub const LATEST_SCHEMA_VERSION: u32 = 3;

/// 迁移脚本注册表：新迁移往后追加，版本号必须连续递增。
/// 0001 引导（meta+settings）；0002 实体五表 + FTS5 trigram（Task 4）；
/// 0003 hosts.username 登录用户名列（Task 5，spec §3 模型缺口补列）；
/// history 表 Task 15、notifications Task 12 各自成迁移。
const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../migrations/0001_init.sql")),
    (2, include_str!("../migrations/0002_entities.sql")),
    (3, include_str!("../migrations/0003_hosts_username.sql")),
];

/// 打开的 vault：SQLite 连接 + 由 Master Key 派生的密封器。
pub struct Vault {
    conn: Mutex<Connection>,
    cipher: Cipher,
}

impl Vault {
    /// 生产路径：Master Key 走系统钥匙链（service 见 [`crate::master_key::DEFAULT_SERVICE`]）。
    pub fn open(dir: &Path) -> Result<Vault> {
        Self::open_with(dir, &crate::master_key::KeyringStorage::new(
            crate::master_key::DEFAULT_SERVICE,
        ))
    }

    /// 可注入路径：测试/特殊场景指定 KeyStorage（keyring 测试纪律的前提）。
    pub fn open_with(dir: &Path, storage: &dyn KeyStorage) -> Result<Vault> {
        std::fs::create_dir_all(dir)?;
        let conn = Connection::open(dir.join("vault.db"))?;

        // PRAGMA 先于迁移：WAL 是持久属性，foreign_keys 不持久、每次 open 重设。
        // journal_mode 赋值会返回一行（"wal"），用 query_row 接住。
        let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        migrate(&conn)?;
        let key = MasterKey::load_with_storage(storage)?;
        Ok(Self {
            conn: Mutex::new(conn),
            cipher: key.cipher(),
        })
    }

    /// 敏感字段密封器（AAD 纪律见 [`crate::crypto::aad`]）。
    pub fn crypto(&self) -> &Cipher {
        &self.cipher
    }

    /// 单连接串行访问（rusqlite Connection 非 Sync，Mutex 是 Tauri 命令共享的标准形态）。
    pub fn connection(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("vault connection poisoned")
    }

    /// 当前 schema 版本（读 meta.schema_version；库为空时为 0）。
    pub fn schema_version(&self) -> Result<u32> {
        current_schema_version(&self.connection())
    }
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
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version.to_string()],
    )?;
    Ok(())
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
