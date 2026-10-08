//! recordings 存储面 TDD（Phase 3 Task 5 Step 2）：插入/列表/FTS 检索/触发器
//! 清理/主机级联/删除。纪律同库内其他测试：tempfile 临时目录 + InMemoryStorage
//! master key（keyring 测试纪律），不触真实钥匙链。

use ottr_vault::{HostInput, Hosts, RecordingInput, Recordings, TEXT_INDEX_PREFIX, Vault};

fn vault() -> Vault {
    let dir = tempfile::tempdir().unwrap();
    Vault::open_with(dir.path(), &ottr_vault::master_key::InMemoryStorage::new())
        .expect("open in-memory vault")
}

fn host(vault: &Vault, name: &str) -> i64 {
    Hosts::create(
        vault,
        HostInput {
            name: name.into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.1".into(),
            port: 22,
            username: Some("spike".into()),
            protocol: ottr_vault::HostProtocol::Ssh,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .expect("create host")
    .id
}

fn input(host_id: i64, path: &str, duration: f64, text: Option<&str>) -> RecordingInput {
    RecordingInput {
        host_id,
        path: path.into(),
        duration,
        text: text.map(String::from),
    }
}

/// 插入 → 列表：id/指针列/created_at 由存储层定；id DESC（最近优先）。
#[test]
fn insert_and_list_returns_entries_newest_first() {
    let v = vault();
    let h = host(&v, "web-01");
    let a = Recordings::insert(
        &v,
        &input(h, "/data/recordings/a.cast", 12.5, Some("hello")),
    )
    .unwrap();
    let b = Recordings::insert(&v, &input(h, "/data/recordings/b.cast", 0.0, None)).unwrap();

    let rows = Recordings::list(&v, None, 50).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, b.id, "id DESC");
    assert_eq!(rows[1].id, a.id);
    assert_eq!(a.text_index_path, format!("{TEXT_INDEX_PREFIX}{}", a.id));
    assert!(a.created_at > 0);
    assert_eq!(a.duration, 12.5);
    // host 过滤
    assert!(Recordings::list(&v, Some(h), 50).unwrap().len() == 2);
    assert!(Recordings::list(&v, Some(h + 999), 50).unwrap().is_empty());
    // get 单条
    assert_eq!(Recordings::get(&v, a.id).unwrap().unwrap(), a);
    assert!(Recordings::get(&v, -1).unwrap().is_none());
}

/// CJK 全文检索（spec §3 trigram）：≥3 字符 FTS MATCH 命中 + snippet 高亮；
/// 空查询 = 全量（LIKE 兜底路径）；超短查询 LIKE 兜底。
#[test]
fn search_hits_cjk_via_fts_with_snippet() {
    let v = vault();
    let h = host(&v, "web-01");
    let text =
        "root@web:~$ docker logs ottr-api\r\n部署完成 deployed to prod-cluster01.example.com";
    let hit_row = Recordings::insert(&v, &input(h, "/r/x.cast", 9.0, Some(text))).unwrap();
    Recordings::insert(&v, &input(h, "/r/y.cast", 1.0, Some("unrelated content"))).unwrap();

    // CJK ≥3 字符走 FTS
    let hits = Recordings::search(&v, "部署完成", None, 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entry.id, hit_row.id);
    assert!(
        hits[0].snippet.contains("部署完成"),
        "snippet: {}",
        hits[0].snippet
    );
    // snippet() 高亮标记（fix round 1/5 I-2：6 参签名 `snippet(t, col, start,
    // end, ellipsis, tokens)`，列在前）
    assert!(
        hits[0].snippet.contains("[部署完成]"),
        "高亮标记: {}",
        hits[0].snippet
    );

    // ASCII ≥3 字符
    let hits = Recordings::search(&v, "docker logs", None, 50).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entry.id, hit_row.id);
    assert!(hits[0].snippet.contains("[docker logs]"));

    // 空查询 = LIKE 全量（两行都回）
    assert_eq!(Recordings::search(&v, "", None, 50).unwrap().len(), 2);
    // 超短（2 字符）LIKE 兜底（"gs" ⊂ "logs"；trigram 不吃 <3 字符）
    let hits = Recordings::search(&v, "gs", None, 50).unwrap();
    assert_eq!(hits.len(), 1, "LIKE 兜底命中 'logs'");
    // host 过滤参与分派
    assert!(
        Recordings::search(&v, "docker", Some(h + 5), 50)
            .unwrap()
            .is_empty()
    );
    // 语法注入安全：FTS 操作符按字面处理
    assert!(
        Recordings::search(&v, "logs\" OR 1=1 --", None, 50)
            .unwrap()
            .is_empty()
    );
}

/// 空文本录制：只入元数据，不进 FTS（搜不到、列表可见）。
#[test]
fn empty_text_recording_stays_out_of_fts() {
    let v = vault();
    let h = host(&v, "db-01");
    let e = Recordings::insert(&v, &input(h, "/r/empty.cast", 0.0, None)).unwrap();
    assert!(
        Recordings::search(&v, "", None, 50).unwrap().is_empty(),
        "FTS 无行可 LIKE"
    );
    assert_eq!(Recordings::list(&v, None, 50).unwrap(), vec![e]);
    assert_eq!(
        Recordings::search(&v, "anything", None, 50).unwrap().len(),
        0
    );
}

/// 删除录制 → AFTER DELETE 触发器同步清 FTS（不留幽灵命中）；删除不存在的
/// id → NotFound。
#[test]
fn delete_cleans_fts_and_missing_id_is_not_found() {
    let v = vault();
    let h = host(&v, "web-01");
    let e = Recordings::insert(&v, &input(h, "/r/x.cast", 3.0, Some("delete me marker"))).unwrap();
    assert_eq!(Recordings::search(&v, "marker", None, 50).unwrap().len(), 1);
    Recordings::delete(&v, e.id).unwrap();
    assert!(
        Recordings::search(&v, "marker", None, 50)
            .unwrap()
            .is_empty()
    );
    assert!(Recordings::list(&v, None, 50).unwrap().is_empty());
    assert!(matches!(
        Recordings::delete(&v, e.id),
        Err(ottr_vault::VaultError::NotFound(_))
    ));
}

/// 删主机 → CASCADE 删录制行且 FTS 同清（触发器在级联路径同样触发——
/// 「删主机即删其审计痕迹」的完整语义）。
#[test]
fn host_cascade_removes_rows_and_fts() {
    let v = vault();
    let h = host(&v, "web-01");
    Recordings::insert(&v, &input(h, "/r/x.cast", 3.0, Some("cascade marker"))).unwrap();
    assert_eq!(
        Recordings::search(&v, "cascade", None, 50).unwrap().len(),
        1
    );
    Hosts::delete(&v, h).unwrap();
    assert!(Recordings::list(&v, None, 50).unwrap().is_empty());
    assert!(
        Recordings::search(&v, "cascade", None, 50)
            .unwrap()
            .is_empty()
    );
}

/// 空 path 显式拒绝（InvalidInput）；schema 版本不低于 15（0016 起后续
/// 迁移继续推进——断言改对 ottr_vault::LATEST_SCHEMA_VERSION，避免每加一个
/// 迁移改一次测试；0015 本体的「推进到 15」钉子由迁移器顺序测试承担）。
#[test]
fn empty_path_is_invalid_and_schema_at_least_15() {
    let v = vault();
    let h = host(&v, "web-01");
    assert!(matches!(
        Recordings::insert(&v, &input(h, "   ", 0.0, None)),
        Err(ottr_vault::VaultError::InvalidInput(_))
    ));
    assert!(v.schema_version().unwrap() >= 15);
}

/// 大小写不敏感命中 + snippet 上下文（fix round 1/5 I-2 核心回归）：内容大写
/// 'DOCKER'，小写查询命中（trigram 缺省 case-folding），片段带高亮标记与
/// 命中词上下文（非「开头预览」退化）。
#[test]
fn snippet_is_case_insensitive_with_context() {
    let v = vault();
    let h = host(&v, "web-01");
    let text =
        "root@web:~$ SYSTEMCTL status DOCKER service\r\nthen some trailing context words here";
    Recordings::insert(&v, &input(h, "/r/case.cast", 4.0, Some(text))).unwrap();

    let hits = Recordings::search(&v, "docker", None, 50).unwrap();
    assert_eq!(hits.len(), 1, "小写查询命中大写内容");
    let snip = &hits[0].snippet;
    assert!(snip.contains("[DOCKER]"), "高亮标记包裹原词: {snip}");
    // 上下文保真：命中词两侧相邻词在片段里（tokens=24 trigram ≈ ±36 字符窗口，
    // 窗口边界可能截断远端长词，断言相邻词不假设整词边界）
    assert!(snip.contains("status"), "前文上下文: {snip}");
    assert!(snip.contains("service"), "后文上下文: {snip}");
}
