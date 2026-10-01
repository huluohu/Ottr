//! session_summaries TDD（Phase 2 Task 7，B1 会话纪要）：
//! 0011 迁移建表、insert（upsert 同 (host_id, session_id) 保 rowid/AAD 稳定、
//! 校验拒绝、锁定拒绝、FK 悬空拒绝）、list（id DESC / host 过滤 / limit）、
//! 密文落库直查（库中无明文 + 随机 nonce）、主密码升级重密封覆盖本表、
//! host 删除 CASCADE。
//! 纪律（同 entities_test）：tempfile 临时目录 + InMemoryStorage，绝不触碰
//! 真实用户目录与真钥匙链。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    History, HistoryInput, HostInput, Hosts, SessionSummaries, SummaryInput, Vault, VaultError,
};

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

fn summary_input(host_id: i64, session_id: &str, summary: &str) -> SummaryInput {
    SummaryInput {
        host_id,
        session_id: session_id.into(),
        summary: summary.into(),
        command_count: 3,
    }
}

/// 0011 迁移建表 + insert/list 回读（ts 存储层定、id DESC 排序）。
#[test]
fn migration_0011_creates_session_summaries_and_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let h1 = Hosts::create(&vault, host_input("web01")).unwrap();
    let h2 = Hosts::create(&vault, host_input("db01")).unwrap();

    let a = SessionSummaries::insert(
        &vault,
        &summary_input(h1.id, "tab-a", "排查了 ottr-api 的日志 tail。"),
    )
    .unwrap();
    let b = SessionSummaries::insert(
        &vault,
        &summary_input(h2.id, "tab-b", "巡检了数据库磁盘水位。"),
    )
    .unwrap();

    assert!(a.id > 0 && b.id > a.id, "AUTOINCREMENT 严格递增");
    assert!(a.ts > 0, "ts 由存储层落值");

    let all = SessionSummaries::list(&vault, None, 10).unwrap();
    assert_eq!(all, vec![b.clone(), a.clone()], "列表 id DESC（最近优先）");

    let only_h1 = SessionSummaries::list(&vault, Some(h1.id), 10).unwrap();
    assert_eq!(only_h1, vec![a], "host 过滤");
}

/// limit 截断（id DESC 保留最近 N 条）。
#[test]
fn list_limit_keeps_newest() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    for i in 0..3 {
        SessionSummaries::insert(
            &vault,
            &summary_input(h.id, &format!("tab-{i}"), &format!("第 {i} 轮")),
        )
        .unwrap();
    }
    let got = SessionSummaries::list(&vault, None, 2).unwrap();
    assert_eq!(got.len(), 2);
    assert!(got[0].summary.contains("2"), "最新一条在前");
}

/// upsert：同 (host_id, session_id) 覆盖（rowid 稳定 → AAD 稳定），id 不增。
#[test]
fn insert_upserts_same_session_rowid_stable() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let first =
        SessionSummaries::insert(&vault, &summary_input(h.id, "tab-a", "第一轮纪要")).unwrap();
    let second =
        SessionSummaries::insert(&vault, &summary_input(h.id, "tab-a", "第二轮纪要（覆盖）"))
            .unwrap();
    assert_eq!(first.id, second.id, "同会话 upsert：rowid 不变");

    let rows = SessionSummaries::list(&vault, None, 10).unwrap();
    assert_eq!(rows.len(), 1, "同 (host_id, session_id) 只有一行");
    assert_eq!(rows[0].summary, "第二轮纪要（覆盖）");
    // 密文开封路径随 upsert 依然成立（AAD 未换绑）
    assert!(rows[0].ts >= first.ts, "ts 刷新为最新生成时刻");

    // 不同 session_id 各自成行
    SessionSummaries::insert(&vault, &summary_input(h.id, "tab-b", "另一会话")).unwrap();
    assert_eq!(SessionSummaries::list(&vault, None, 10).unwrap().len(), 2);
}

/// 校验：session_id / summary 空白拒绝、command_count 负数拒绝。
#[test]
fn insert_rejects_blank_and_negative() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let blank_session = SummaryInput {
        host_id: h.id,
        session_id: "   ".into(),
        summary: "ok".into(),
        command_count: 1,
    };
    assert!(matches!(
        SessionSummaries::insert(&vault, &blank_session),
        Err(VaultError::InvalidInput(_))
    ));
    let blank_summary = SummaryInput {
        host_id: h.id,
        session_id: "tab-a".into(),
        summary: "  \n ".into(),
        command_count: 1,
    };
    assert!(matches!(
        SessionSummaries::insert(&vault, &blank_summary),
        Err(VaultError::InvalidInput(_))
    ));
    let negative = SummaryInput {
        host_id: h.id,
        session_id: "tab-a".into(),
        summary: "ok".into(),
        command_count: -1,
    };
    assert!(matches!(
        SessionSummaries::insert(&vault, &negative),
        Err(VaultError::InvalidInput(_))
    ));
}

/// 悬空 host_id 被 FK 拒绝（CASCADE 只管删主机联动，不产生悬空纪要）。
#[test]
fn insert_rejects_dangling_host() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert!(matches!(
        SessionSummaries::insert(&vault, &summary_input(424_242, "tab-a", "ok")),
        Err(VaultError::Sql(_))
    ));
}

/// 锁定（password 模式）即拒：密文面与 secrets 同一锁定语义。
#[test]
fn locked_vault_rejects_insert_and_list() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Vault::open_password_only(dir.path()).unwrap();
    assert!(vault.is_locked());
    assert!(matches!(
        SessionSummaries::insert(&vault, &summary_input(1, "tab-a", "ok")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(
        SessionSummaries::list(&vault, None, 10),
        Err(VaultError::Locked)
    ));
}

/// 密文落库断言（裁定 #2 同款）：绕过 API 直查 SQLite——库中无明文字节、
/// blob 结构 nonce||ct||tag、随机 nonce 同明文密文不同。
#[test]
fn summary_is_sealed_at_rest() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    let plain = "部署了 v2.3.1，密码 hunter2 已轮换";
    let a = SessionSummaries::insert(&vault, &summary_input(h.id, "tab-a", plain)).unwrap();
    let b = SessionSummaries::insert(&vault, &summary_input(h.id, "tab-b", plain)).unwrap();

    let raw = rusqlite::Connection::open(dir.path().join("vault.db")).unwrap();
    let blob_at = |id: i64| -> Vec<u8> {
        raw.query_row(
            "SELECT summary_enc FROM session_summaries WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    let b1 = blob_at(a.id);
    let b2 = blob_at(b.id);
    assert!(
        b1.len() >= plain.len() + 28,
        "blob 应至少 nonce(12)+tag(16)+明文长度，实际 {}",
        b1.len()
    );
    assert!(
        !b1.windows(plain.len()).any(|w| w == plain.as_bytes()),
        "summary_enc 中出现了明文"
    );
    assert_ne!(b1, b2, "nonce 必须随机");

    // list 单点开封回明文
    let rows = SessionSummaries::list(&vault, Some(h.id), 10).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.summary == plain));
}

/// 主密码升级（keyring → password）重密封覆盖 session_summaries.summary_enc
/// （scan_registry 登记）。升级后旧 Cipher 已换，list 必须仍能开封。
#[test]
fn upgrade_to_master_password_reseals_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    SessionSummaries::insert(&vault, &summary_input(h.id, "tab-a", "升级前的纪要")).unwrap();

    let resealed = vault
        .set_master_password("correct-horse-battery", &mut |_, _| {})
        .unwrap();
    assert!(resealed >= 1, "重密封计数应包含 summary_enc");

    let rows = SessionSummaries::list(&vault, None, 10).unwrap();
    assert_eq!(rows[0].summary, "升级前的纪要", "升级后新钥开封一致");
}

/// 删主机 → 纪要随删（CASCADE，同 history 裁定：主机维度的运行痕迹）。
#[test]
fn host_delete_cascades_summaries() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();
    SessionSummaries::insert(&vault, &summary_input(h.id, "tab-a", "纪要")).unwrap();
    Hosts::delete(&vault, h.id).unwrap();
    assert!(SessionSummaries::list(&vault, None, 10).unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// 真库夹具一轮（Step 3）：3 命令会话 → 纪要入库可查——存储侧全链（真 SQLite +
// 真 AES-GCM）：history 灌入同 session_id 的 3 条命令 → History::list_session
// 按时序取回（纪要 prompt 的数据源契约）→ 摘要密封入库 → list 回读逐字段对上。
// ---------------------------------------------------------------------------

/// 会话命令序列取数（History::list_session）：id 升序 = ts 时序，session 维度过滤。
#[test]
fn list_session_returns_commands_in_order_and_summary_chain_roundtrips() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("web01")).unwrap();

    let cmd = |c: &str, sid: &str| HistoryInput {
        host_id: h.id,
        command: c.into(),
        cwd: None,
        exit_code: Some(0),
        session_id: Some(sid.into()),
    };
    let c1 = History::insert(&vault, &cmd("root@web01:~$ cd /srv/ottr", "tab-fixture")).unwrap();
    let c2 = History::insert(
        &vault,
        &cmd("root@web01:/srv/ottr$ docker compose up -d", "tab-fixture"),
    )
    .unwrap();
    let c3 = History::insert(
        &vault,
        &cmd("root@web01:/srv/ottr$ systemctl status ottr", "tab-fixture"),
    )
    .unwrap();

    let session = History::list_session(&vault, h.id, "tab-fixture", 200).unwrap();
    assert_eq!(
        session.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![c1.id, c2.id, c3.id],
        "按 id 升序（≈ts 时序）返回"
    );
    // 其他会话的命令不串味
    History::insert(&vault, &cmd("root@web01:~$ 不属于本会话", "tab-other")).unwrap();
    let other = History::list_session(&vault, h.id, "tab-other", 200).unwrap();
    assert_eq!(other.len(), 1);

    let rows = SessionSummaries::list(&vault, None, 10).unwrap();
    assert!(rows.is_empty(), "只有纪要面入 summaries，命令留 history");

    let entry = SessionSummaries::insert(
        &vault,
        &SummaryInput {
            host_id: h.id,
            session_id: "tab-fixture".into(),
            summary: "在 /srv/ottr 部署了 docker compose 服务（3 条命令）。".into(),
            command_count: 3,
        },
    )
    .unwrap();
    let got = SessionSummaries::list(&vault, Some(h.id), 50).unwrap();
    assert_eq!(got, vec![entry], "纪要入库可查：host 过滤 + 逐字段一致");
    assert_eq!(got[0].command_count, 3);
    assert_eq!(got[0].session_id, "tab-fixture");
}
