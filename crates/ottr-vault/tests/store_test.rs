//! store TDD（Task 3 Loop 2）：open 建库+schema_version、重复 open 幂等、
//! WAL 模式确认、FTS5 trigram smoke（spec §3 CJK 检索约束的早期兜底）。
//! 纪律：一律 tempfile 临时目录，绝不触碰真实用户数据目录；
//! Master Key 走可注入的 InMemoryStorage，绝不读写真钥匙链。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::Vault;

fn open_vault(dir: &std::path::Path, storage: &InMemoryStorage) -> Vault {
    Vault::open_with(dir, storage).expect("open vault")
}

#[test]
fn open_creates_db_and_schema_version() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path(), &InMemoryStorage::new());

    // 建库：vault.db 落在指定目录。
    assert!(dir.path().join("vault.db").exists());

    // 自动迁移到最新 schema_version（0001+0002 → 2）。
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    // 引导表（0001）与实体表（Task 4 的 0002）全部就位。
    let conn = vault.connection();
    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert!(tables.contains(&"meta".to_string()), "tables: {tables:?}");
    assert!(
        tables.contains(&"settings".to_string()),
        "tables: {tables:?}"
    );
    assert!(tables.contains(&"hosts".to_string()), "0002 实体表应就位");
}

#[test]
fn reopen_is_idempotent_and_preserves_data() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();

    let vault = open_vault(dir.path(), &storage);
    vault
        .connection()
        .execute(
            "INSERT INTO settings(key, value) VALUES ('theme', '\"dark\"')",
            [],
        )
        .unwrap();
    drop(vault);

    // 重复 open：不重跑迁移（版本不变）、不重建、数据保留。
    let reopened = open_vault(dir.path(), &storage);
    assert_eq!(
        reopened.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let theme: String = reopened
        .connection()
        .query_row("SELECT value FROM settings WHERE key='theme'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(theme, "\"dark\"");
}

#[test]
fn wal_mode_confirmed() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path(), &InMemoryStorage::new());
    let mode: String = vault
        .connection()
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn foreign_keys_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path(), &InMemoryStorage::new());
    let fk: i64 = vault
        .connection()
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1, "Task 4 级联删除依赖 foreign_keys=ON");
}

#[test]
fn fts5_trigram_smoke() {
    // bundled SQLite 必须带 FTS5 + trigram tokenizer（rusqlite 0.40 无 fts5
    // feature，靠 bundled 无条件启用——此处实测兜底，Task 4 检索的地基）。
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path(), &InMemoryStorage::new());
    let conn = vault.connection();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE smoke USING fts5(body, tokenize='trigram');
         INSERT INTO smoke(body) VALUES ('生产环境部署日志');",
    )
    .unwrap();
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM smoke WHERE smoke MATCH '生产环境'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1, "trigram 必须支持中文子串命中（≥3 字符）");

    // trigram 只索引 3 字符以上的串：短于 3 字符的查询 MATCH 恒为空，
    // 必须 LIKE 兜底（spec §3「超短查询用 LIKE 兜底」的实测出处）。
    let short: i64 = conn
        .query_row(
            "SELECT count(*) FROM smoke WHERE smoke MATCH '生产'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(short, 0);
    let via_like: i64 = conn
        .query_row(
            "SELECT count(*) FROM smoke WHERE body LIKE '%生产%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(via_like, 1, "超短查询走 LIKE 兜底");
}

#[test]
fn db_too_new_is_rejected() {
    // 模拟未来版本库：手动把 schema_version 抬高，再 open 必须拒绝降级打开。
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    open_vault(dir.path(), &storage)
        .connection()
        .execute("UPDATE meta SET value='99' WHERE key='schema_version'", [])
        .unwrap();
    let err = match Vault::open_with(dir.path(), &storage) {
        Err(e) => e,
        Ok(_) => panic!("版本 99 的库应拒绝打开"),
    };
    assert!(
        matches!(err, ottr_vault::VaultError::SchemaTooNew { db: 99, .. }),
        "{err}"
    );
}

#[test]
fn corrupted_schema_version_is_explicit_error() {
    // T3 评审要求（Task 4 落地）：版本号 parse 失败 → 显式错误，
    // 不得静默按 0 处理（否则会重跑迁移、静默改写库、掩盖损坏）。
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    open_vault(dir.path(), &storage)
        .connection()
        .execute(
            "UPDATE meta SET value='v2-final-FINAL' WHERE key='schema_version'",
            [],
        )
        .unwrap();
    let err = match Vault::open_with(dir.path(), &storage) {
        Err(e) => e,
        Ok(_) => panic!("垃圾版本号应显式报错而非按 0 重跑迁移"),
    };
    assert!(
        matches!(err, ottr_vault::VaultError::CorruptedSchemaVersion(_)),
        "{err}"
    );
}
