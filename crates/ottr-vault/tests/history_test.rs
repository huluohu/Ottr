//! history TDD（Task 15，spec §5 文本层消费方③：统一历史搜索 ⌘R）：
//! 0007 迁移建表、insert（ts 存储层定 / command 非空校验 / FK 悬空拒绝）、
//! search（≥3 字符 FTS trigram 含中文 / <3 字符 LIKE 兜底 / 空查询最近记录 /
//! host 过滤 / limit 截断）、滚动清理（HISTORY_KEEP_ROWS + FTS 触发器同步）、
//! FK ON DELETE CASCADE（删主机历史随删，⌘R 不出死条目）。
//! 纪律（同 entities_test）：tempfile 临时目录 + InMemoryStorage，绝不触碰
//! 真实用户目录与真钥匙链。history 是明文面（无 *_enc 列，不涉 scan_registry
//! 守卫；锁定态可读写同 notifications，不另测）。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{History, HistoryInput, HostInput, Hosts, Vault, VaultError};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn host_input(name: &str) -> HostInput {
    HostInput {
        protocol: Default::default(),
        name: name.into(),
        group_id: None,
        tags: vec![],
        address: "10.0.0.1".into(),
        port: 22,
        username: Some("deploy".into()),
        credential_id: None,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: false,
        is_production: false,
        notes: None,
    }
}

fn hist(host_id: i64, command: &str) -> HistoryInput {
    HistoryInput {
        host_id,
        command: command.into(),
        cwd: None,
        exit_code: Some(0),
        session_id: Some("tab-test".into()),
    }
}

/// 0007 迁移建表 + insert 字段回读（cwd/exit_code/session_id 往返、ts 存储层定）。
#[test]
fn migration_0007_creates_history_and_insert_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let row = History::insert(
        &vault,
        &HistoryInput {
            host_id: h.id,
            command: "docker logs --tail 100 ottr-api".into(),
            cwd: Some("/srv/ottr".into()),
            exit_code: Some(0),
            session_id: Some("tab-abc".into()),
        },
    )
    .unwrap();

    assert!(row.id > 0);
    assert!(row.ts > 0, "ts 由存储层落值");
    let hits = History::search(&vault, "", None, 10).unwrap();
    assert_eq!(hits, vec![row.clone()], "空查询 = 最近记录，逐字段回读一致");
}

/// command 空白拒绝（提示符噪声/纯回车的兜底闸门）；悬空 host_id 被 FK 拒绝。
#[test]
fn insert_rejects_blank_command_and_dangling_host() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let blank = History::insert(&vault, &hist(1, "   \n  "));
    assert!(matches!(blank, Err(VaultError::InvalidInput(_))));

    let dangling = History::insert(&vault, &hist(4242, "ls"));
    assert!(dangling.is_err(), "FK 约束拒绝不存在的 host_id");
}

/// 中文检索（T4 同款「生产」硬要求）：≥3 字符走 trigram，2/1 字符 LIKE 兜底。
#[test]
fn search_hits_chinese_via_trigram_and_like_fallback_for_short_queries() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    History::insert(&vault, &hist(h.id, "echo 生产环境部署检查")).unwrap();
    History::insert(&vault, &hist(h.id, "docker ps")).unwrap();

    // ≥3 字符：FTS MATCH，中缀子串命中（trigram 对 CJK 按字符切三元）
    let hits = History::search(&vault, "生产环境", None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].command, "echo 生产环境部署检查");
    assert_eq!(
        History::search(&vault, "境部署", None, 10).unwrap().len(),
        1
    );

    // 2 字符 / 1 字符：LIKE 兜底必须命中（trigram 对 <3 字符 MATCH 恒 0 行）
    assert_eq!(
        History::search(&vault, "生产", None, 10).unwrap().len(),
        1,
        "2 字符查询必须 LIKE 兜底命中"
    );
    assert_eq!(History::search(&vault, "生", None, 10).unwrap().len(), 1);

    // ASCII 同语义：≥3 走 FTS、2 字符走 LIKE
    assert_eq!(
        History::search(&vault, "docker ps", None, 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(History::search(&vault, "ps", None, 10).unwrap().len(), 1);

    assert!(History::search(&vault, "彻底不存在的检索词", None, 10)
        .unwrap()
        .is_empty());
    // FTS 语法注入字面量化：AND/OR/* 按普通文本检索，不当语法执行
    assert!(History::search(&vault, "\"docker\" OR ps", None, 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        History::search(&vault, "  ", None, 10).unwrap().len(),
        2,
        "空查询返回最近记录（全量）"
    );
}

/// host 过滤两条分支（FTS 与 LIKE/空查询都带）；时间倒序（后插者在前）+ limit 截断。
#[test]
fn search_filters_by_host_and_orders_recency() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let a = Hosts::create(&vault, host_input("alpha")).unwrap();
    let b = Hosts::create(&vault, host_input("beta")).unwrap();
    for i in 0..5 {
        History::insert(&vault, &hist(a.id, &format!("cmd-alpha-{i}"))).unwrap();
    }
    History::insert(&vault, &hist(b.id, "cmd-beta-only")).unwrap();

    let hits = History::search(&vault, "", Some(a.id), 10).unwrap();
    assert_eq!(hits.len(), 5, "host 过滤：beta 行不混入");
    assert_eq!(hits[0].command, "cmd-alpha-4", "id DESC = 最近优先");
    assert_eq!(hits[4].command, "cmd-alpha-0");

    // FTS 分支的 host 过滤（4 字符查询）
    let fts = History::search(&vault, "alpha", Some(b.id), 10).unwrap();
    assert!(fts.is_empty(), "FTS 分支 host 过滤：alpha 命令不属于 beta");

    // LIKE 分支的 host 过滤（2 字符查询）
    let like = History::search(&vault, "cm", Some(b.id), 10).unwrap();
    assert_eq!(like.len(), 1);
    assert_eq!(like[0].command, "cmd-beta-only");

    // limit 截断（截最近的）
    let top2 = History::search(&vault, "", Some(a.id), 2).unwrap();
    assert_eq!(top2.len(), 2);
    assert_eq!(top2[0].command, "cmd-alpha-4");
}

/// 滚动清理：插满 KEEP+超额 → 旧行删尽、最近 KEEP 条保留；FTS 索引同步（删除
/// 触发器回放后，被删命令不再可搜、幸存命令仍可搜）。
#[test]
fn prune_keeps_recent_rows_and_syncs_fts_index() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    let keep = ottr_vault::HISTORY_KEEP_ROWS as usize;

    // 5 万行级灌数走 WAL+NORMAL（免逐 commit fsync）：纯测试机速优化，
    // 不改生产 open 的 PRAGMA 面（tempfile 连接，pragma 不持久）。
    {
        let conn = vault.connection();
        conn.pragma_update(None, "synchronous", "NORMAL").unwrap();
    }
    // 首条标记行 + 超额填充（KEEP+10 条，最旧的标记行必然越界被清）
    History::insert(&vault, &hist(h.id, "echo 最早一笔会被清理")).unwrap();
    for i in 0..keep + 10 {
        History::insert(&vault, &hist(h.id, &format!("fill-{i}"))).unwrap();
    }

    let recent = History::search(&vault, "", None, keep + 100).unwrap();
    assert_eq!(recent.len(), keep, "滚动窗口：恰好保留最近 KEEP 条");
    assert_eq!(recent[0].command, format!("fill-{}", keep + 9));
    assert!(
        History::search(&vault, "最早一笔", None, 10)
            .unwrap()
            .is_empty(),
        "被清理的旧命令从 FTS 索引消失（删除触发器回放正确）"
    );
    assert_eq!(
        History::search(&vault, &format!("fill-{}", keep + 9), None, 10)
            .unwrap()
            .len(),
        1,
        "幸存命令仍可搜（FTS 索引未漂移；取无子串歧义的最新一条）"
    );
}

/// FK ON DELETE CASCADE：删主机 → 其历史随删（跨主机历史互不影响），
/// ⌘R 结果永不出现「未知主机」死条目。
#[test]
fn deleting_host_cascades_history_rows() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let a = Hosts::create(&vault, host_input("alpha")).unwrap();
    let b = Hosts::create(&vault, host_input("beta")).unwrap();
    History::insert(&vault, &hist(a.id, "only-on-alpha delete-me-later")).unwrap();
    History::insert(&vault, &hist(b.id, "survives-on-beta")).unwrap();

    Hosts::delete(&vault, a.id).unwrap();
    let rest = History::search(&vault, "", None, 10).unwrap();
    assert_eq!(rest.len(), 1, "alpha 的历史随主机级联删除");
    assert_eq!(rest[0].command, "survives-on-beta");
    assert!(
        History::search(&vault, "delete-me-later", None, 10)
            .unwrap()
            .is_empty(),
        "级联删除同步清 FTS 索引"
    );
}
