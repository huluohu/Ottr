//! store TDD（Task 3 Loop 2）：open 建库+schema_version、重复 open 幂等、
//! WAL 模式确认、FTS5 trigram smoke（spec §3 CJK 检索约束的早期兜底）。
//! 纪律：一律 tempfile 临时目录，绝不触碰真实用户数据目录；
//! Master Key 走可注入的 InMemoryStorage，绝不读写真钥匙链。

use ottr_vault::Vault;
use ottr_vault::master_key::InMemoryStorage;

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

/// BL-206：FK 子列索引齐备。SQLite 执行 FK 的 ON DELETE 动作（CASCADE / SET
/// NULL）时要扫子表找引用行——子列无索引 = 删一个父行做一次全表扫（删凭据/
/// 删组/删主机随子表规模线性劣化，且无主键前缀可用）。0002/0005 建表时
///漏掉的 5 列由 0019 补齐（其余 FK 子列建表迁移已带索引，或 UNIQUE 约束
/// 自动覆盖：mcp_grants.host_id、session_summaries(host_id,…)）。
#[test]
fn fk_child_columns_are_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path(), &InMemoryStorage::new());
    for idx in [
        "idx_host_groups_parent_id", // host_groups.parent_id → host_groups(id)
        "idx_hosts_group_id",        // hosts.group_id → host_groups(id)
        "idx_hosts_credential_id",   // hosts.credential_id → credentials(id)
        "idx_snippets_host_scope",   // snippets.host_scope → hosts(id)
        "idx_notifications_host_id", // notifications.host_id → hosts(id)
    ] {
        let n: i64 = vault
            .connection()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?1",
                [idx],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "missing FK child-column index: {idx}");
    }
}

// ---------------------------------------------------------------------------
// 钥匙链安全纪律（2026-10-13 主密钥事故回归钉）：静默换钥禁止 / verifier
// 开库校验 / 历史库语义保留。事故链：同名 dev 实例删条目 → open_with 曾按
// 「全新库」静默生成新钥 → 全部既有密文不可解，直到连接凭据才以 aead 显形。
// ---------------------------------------------------------------------------

/// 已有 keyring 库 + 钥匙链条目丢失 → 显式 KeyringLost，**绝不生成新钥**
/// （钥匙链存储保持空——静默写入 = 把「可恢复」变「永久丢失」）。
#[test]
fn existing_vault_with_lost_key_entry_is_error_not_regen() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = open_vault(dir.path(), &storage); // 首开：生成 + 存储有钥
    drop(vault);

    let err = match Vault::open_with(dir.path(), &InMemoryStorage::new()) {
        Err(e) => e,
        Ok(_) => panic!("open must not silently re-key an existing vault"),
    };
    assert!(
        matches!(err, ottr_vault::VaultError::KeyringLost),
        "unexpected error: {err:?}"
    );
}

/// verifier 开库校验：钥匙链中的钥与本库不匹配 → 显式 KeyringMismatch，
/// 绝不带错钥静默打开（错钥下首次写操作即不可逆污染）。
#[test]
fn keychain_key_mismatch_is_rejected_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = open_vault(dir.path(), &storage); // 首开：verifier 落盘
    drop(vault);

    // 换一把不同的钥放進存储（模拟条目被另一份库覆盖）
    let wrong = InMemoryStorage::with_raw(&hex_key(b"0123456789abcdef0123456789abcdef"));
    let err = match Vault::open_with(dir.path(), &wrong) {
        Err(e) => e,
        Ok(_) => panic!("mismatched keychain key must be rejected at open"),
    };
    assert!(
        matches!(err, ottr_vault::VaultError::KeyringMismatch),
        "unexpected error: {err:?}"
    );
}

/// 正确钥重开：verifier 校验通过、数据可续用（既有幂等语义保持）。
#[test]
fn reopen_with_matching_key_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = open_vault(dir.path(), &storage);
    drop(vault);
    let reopened = Vault::open_with(dir.path(), &storage).expect("reopen with matching key");
    assert_eq!(reopened.mode(), ottr_vault::KeyMode::Keyring);
}

/// 历史库语义保留：模式行缺失但钥匙链条目在 → 复用既有钥（不生成），
/// 并补写模式行（原「历史库首次补写」行为）。
#[test]
fn legacy_vault_without_mode_row_reuses_existing_key() {
    let dir = tempfile::tempdir().unwrap();
    let storage = InMemoryStorage::new();
    let vault = open_vault(dir.path(), &storage);
    // 模拟模式行纪律之前的历史库：删掉模式行（钥匙与 verifier 留在库里）
    vault
        .connection()
        .execute("DELETE FROM meta WHERE key = 'master_key.mode'", [])
        .unwrap();
    drop(vault);

    let reopened = Vault::open_with(dir.path(), &storage).expect("legacy reopen must reuse key");
    assert_eq!(reopened.mode(), ottr_vault::KeyMode::Keyring);
}

fn hex_key(raw: &[u8; 32]) -> String {
    raw.iter().map(|b| format!("{b:02x}")).collect()
}
