//! entities TDD（Task 4）：五表 CRUD、FTS5 trigram 检索（≥3 字符 MATCH + 超短 LIKE 兜底）、
//! credential secret 密文落库、删除解绑语义、known_hosts 状态机。
//! 纪律（同 Task 3）：tempfile 临时目录 + InMemoryStorage，绝不触碰真实用户目录与真钥匙链；
//! 密文断言按裁定 #2 绕过 API——另开 rusqlite 连接直读同一库文件。

use ottr_vault::entities::{
    CredentialInput, CredentialKind, CredentialPatch, KnownHostState, SecretField, SnippetInput,
};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{
    Credentials, HostGroups, HostInput, Hosts, KnownHosts, Snippets, Vault, VaultError,
};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn host_input(name: &str, notes: &str) -> HostInput {
    HostInput {
        name: name.into(),
        group_id: None,
        tags: vec![],
        address: "10.0.0.1".into(),
        port: 22,
        username: None,
        credential_id: None,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: false,
        notes: Some(notes.into()),
    }
}

fn password_input(plain: &str) -> CredentialInput {
    CredentialInput {
        kind: CredentialKind::Password,
        secret: Some(plain.into()),
        key_pub: None,
        passphrase: None,
        totp_secret: None,
    }
}

#[test]
fn migration_0002_creates_entity_tables_and_fts() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    // 0002 实体表 + 0003（hosts.username，Task 5）→ 最新版本
    assert_eq!(vault.schema_version().unwrap(), 3);

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
    for t in [
        "host_groups",
        "credentials",
        "hosts",
        "snippets",
        "known_hosts",
    ] {
        assert!(tables.contains(&t.to_string()), "缺实体表 {t}: {tables:?}");
    }
    for fts in ["hosts_fts", "snippets_fts"] {
        assert!(
            tables.contains(&fts.to_string()),
            "缺 FTS 虚表 {fts}: {tables:?}"
        );
    }
}

#[test]
fn host_crud_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let group = HostGroups::create(&vault, "生产组", None, Some("#ff0000")).unwrap();
    let cred = Credentials::create(&vault, &password_input("pw")).unwrap();

    let mut input = host_input("web-01", "入口机");
    input.group_id = Some(group.id);
    input.tags = vec!["prod".into(), "nginx".into()];
    input.port = 2222;
    input.username = Some("deploy".into());
    input.credential_id = Some(cred.id);
    input.encoding_override = Some("gbk".into());
    input.monitor_enabled = true;

    let created = Hosts::create(&vault, input).unwrap();
    let host = Hosts::get(&vault, created.id).unwrap().unwrap();
    assert_eq!(host.name, "web-01");
    assert_eq!(host.group_id, Some(group.id));
    assert_eq!(host.tags, vec!["prod".to_string(), "nginx".to_string()]);
    assert_eq!(host.address, "10.0.0.1");
    assert_eq!(host.port, 2222);
    assert_eq!(host.username.as_deref(), Some("deploy"));
    assert_eq!(host.credential_id, Some(cred.id));
    assert_eq!(host.encoding_override.as_deref(), Some("gbk"));
    assert!(host.monitor_enabled);
    assert_eq!(host.notes.as_deref(), Some("入口机"));
    assert!(host.created_at > 0 && host.updated_at >= host.created_at);

    let mut upd = host_input("web-02", "");
    upd.port = 22;
    upd.tags = vec![];
    upd.group_id = None;
    upd.credential_id = None;
    upd.username = None;
    upd.monitor_enabled = false;
    upd.notes = None;
    let updated = Hosts::update(&vault, created.id, upd).unwrap();
    assert_eq!(updated.name, "web-02");
    assert_eq!(updated.port, 22);
    assert!(updated.tags.is_empty());
    assert_eq!(updated.group_id, None);
    assert_eq!(updated.credential_id, None);
    assert_eq!(updated.username, None);
    assert!(!updated.monitor_enabled);
    assert_eq!(updated.notes, None);
    assert_eq!(
        updated.created_at, host.created_at,
        "created_at 不得被 update 改写"
    );

    assert_eq!(
        Hosts::list_by_group(&vault, Some(group.id)).unwrap().len(),
        0,
        "已移出分组"
    );
    assert_eq!(
        Hosts::list_by_group(&vault, None).unwrap().len(),
        1,
        "未分组主机"
    );
    assert_eq!(Hosts::list(&vault).unwrap().len(), 1);

    Hosts::delete(&vault, created.id).unwrap();
    assert_eq!(Hosts::get(&vault, created.id).unwrap(), None);
}

#[test]
fn input_validation_and_missing_row_errors() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    assert!(matches!(
        Hosts::create(&vault, host_input("  ", "")),
        Err(VaultError::InvalidInput(_))
    ));
    let mut bad_port = host_input("x", "");
    bad_port.port = 0;
    assert!(matches!(
        Hosts::create(&vault, bad_port),
        Err(VaultError::InvalidInput(_))
    ));
    let mut bad_port = host_input("x", "");
    bad_port.port = 70_000;
    assert!(matches!(
        Hosts::create(&vault, bad_port),
        Err(VaultError::InvalidInput(_))
    ));
    assert!(matches!(
        HostGroups::create(&vault, " ", None, None),
        Err(VaultError::InvalidInput(_))
    ));

    assert!(matches!(
        Hosts::update(&vault, 999, host_input("n", "")),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        Hosts::delete(&vault, 999),
        Err(VaultError::NotFound(_))
    ));
    assert!(matches!(
        Credentials::delete(&vault, 999),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn search_hits_chinese_via_trigram_and_like_fallback_for_short_queries() {
    // 硬要求（task-3 实测钉死）：trigram 只命中 ≥3 字符查询，2 字符 MATCH 恒 0 行，
    // 检索 API 必须带 LIKE 兜底分支。
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    Hosts::create(&vault, host_input("生产环境-web01", "部署了 nginx")).unwrap();
    Hosts::create(&vault, host_input("dev-box", "本地开发机")).unwrap();

    // ≥3 字符：FTS MATCH 路径，name 命中
    let hits = Hosts::search(&vault, "生产环境").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "生产环境-web01");

    // notes 同样进索引（5 字符 → FTS 路径）
    assert_eq!(Hosts::search(&vault, "nginx").unwrap().len(), 1);

    // 中缀子串（≥3 字符，FTS 路径）
    assert_eq!(Hosts::search(&vault, "环境-web").unwrap().len(), 1);

    // 2 字符 / 1 字符：LIKE 兜底必须命中
    assert_eq!(
        Hosts::search(&vault, "生产").unwrap().len(),
        1,
        "2 字符查询必须 LIKE 兜底命中"
    );
    assert_eq!(
        Hosts::search(&vault, "环").unwrap().len(),
        1,
        "1 字符查询同样兜底"
    );

    assert!(Hosts::search(&vault, "彻底不存在的检索词")
        .unwrap()
        .is_empty());
    assert_eq!(
        Hosts::search(&vault, "  ").unwrap().len(),
        2,
        "空查询返回全量"
    );
}

#[test]
fn host_update_and_delete_sync_fts_index() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("old-name-生产", "")).unwrap();
    assert_eq!(Hosts::search(&vault, "old-name").unwrap().len(), 1);

    Hosts::update(&vault, h.id, host_input("new-name-测试", "")).unwrap();
    assert!(
        Hosts::search(&vault, "old-name").unwrap().is_empty(),
        "改名后旧词必须出索引"
    );
    assert_eq!(
        Hosts::search(&vault, "new-name").unwrap().len(),
        1,
        "新词必须进索引"
    );

    Hosts::delete(&vault, h.id).unwrap();
    assert!(
        Hosts::search(&vault, "new-name").unwrap().is_empty(),
        "删除后必须出索引"
    );
}

#[test]
fn rowids_never_reused_after_delete() {
    // I-1 回归（AAD 防换绑不变量）：裸 rowid = max+1，删掉最大 id 行后新行会复用
    // 该 id——同主密钥下被删凭据的旧密文即可原样通过 GCM 认证注入复用同 id 的新行。
    // 0002 的 INTEGER PK 全部 AUTOINCREMENT，新行 rowid 必须严格大于被删行。
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let c1 = Credentials::create(&vault, &password_input("pw")).unwrap();
    Credentials::delete(&vault, c1.id).unwrap();
    let c2 = Credentials::create(&vault, &password_input("pw2")).unwrap();
    assert!(c2.id > c1.id, "credentials rowid 复用：{} → {}", c1.id, c2.id);

    let h1 = Hosts::create(&vault, host_input("a", "")).unwrap();
    Hosts::delete(&vault, h1.id).unwrap();
    let h2 = Hosts::create(&vault, host_input("b", "")).unwrap();
    assert!(h2.id > h1.id, "hosts rowid 复用：{} → {}", h1.id, h2.id);

    let g1 = HostGroups::create(&vault, "g1", None, None).unwrap();
    HostGroups::delete(&vault, g1.id).unwrap();
    let g2 = HostGroups::create(&vault, "g2", None, None).unwrap();
    assert!(g2.id > g1.id, "host_groups rowid 复用：{} → {}", g1.id, g2.id);

    let s1 = Snippets::create(
        &vault,
        &SnippetInput { name: "s1".into(), body: "x".into(), variables: vec![], tags: vec![], host_scope: None },
    )
    .unwrap();
    Snippets::delete(&vault, s1.id).unwrap();
    let s2 = Snippets::create(
        &vault,
        &SnippetInput { name: "s2".into(), body: "x".into(), variables: vec![], tags: vec![], host_scope: None },
    )
    .unwrap();
    assert!(s2.id > s1.id, "snippets rowid 复用：{} → {}", s1.id, s2.id);
}

#[test]
fn credential_secret_is_sealed_at_rest_and_revealable() {
    // 裁定 #2：密文落库断言必须绕过 API 直查 SQLite。
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let plain = "s3cret-密码-0123456789";
    let c1 = Credentials::create(&vault, &password_input(plain)).unwrap();
    let c2 = Credentials::create(&vault, &password_input(plain)).unwrap();

    // 另开连接直读同一库文件（WAL 已提交数据对第二连接可见）。
    let raw = rusqlite::Connection::open(dir.path().join("vault.db")).unwrap();
    let blob_at = |id: i64| -> Vec<u8> {
        raw.query_row(
            "SELECT secret_enc FROM credentials WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    };
    let b1 = blob_at(c1.id);
    let b2 = blob_at(c2.id);

    // 结构：nonce(12B) || ct(≥plain) || tag(16B)。
    assert!(
        b1.len() >= plain.len() + 28,
        "blob 应至少 {} 字节，实际 {}",
        plain.len() + 28,
        b1.len()
    );
    // 库中不得出现明文字节。
    assert!(
        !b1.windows(plain.len()).any(|w| w == plain.as_bytes()),
        "secret_enc 中出现了明文"
    );
    // 随机 nonce：同明文两次密封密文必须不同。
    assert_ne!(b1, b2, "nonce 必须随机");

    // reveal 单点回明文；行不存在 → NotFound。
    assert_eq!(
        Credentials::reveal(&vault, c1.id, SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some(plain)
    );
    assert!(matches!(
        Credentials::reveal(&vault, 424_242, SecretField::Secret),
        Err(VaultError::NotFound(_))
    ));
}

#[test]
fn credential_key_kind_roundtrip_and_patch_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let c = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Key,
            secret: Some("-----BEGIN OPENSSH PRIVATE KEY-----".into()),
            key_pub: Some("ssh-ed25519 AAA".into()),
            passphrase: Some("pp".into()),
            totp_secret: None,
        },
    )
    .unwrap();

    let got = Credentials::get(&vault, c.id).unwrap().unwrap();
    assert_eq!(got.kind, CredentialKind::Key);
    assert_eq!(got.key_pub.as_deref(), Some("ssh-ed25519 AAA"));
    // Credential 序列化面不得含任何密钥材料（TS 类型同构的前提）。
    let json = serde_json::to_string(&got).unwrap();
    assert!(!json.contains("OPENSSH"), "凭据序列化面泄漏密钥: {json}");
    assert!(json.contains("\"kind\":\"key\""), "{json}");

    assert_eq!(
        Credentials::reveal(&vault, c.id, SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("-----BEGIN OPENSSH PRIVATE KEY-----")
    );
    assert_eq!(
        Credentials::reveal(&vault, c.id, SecretField::Passphrase)
            .unwrap()
            .as_deref(),
        Some("pp")
    );
    assert_eq!(
        Credentials::reveal(&vault, c.id, SecretField::TotpSecret).unwrap(),
        None
    );

    // patch 语义：None = 保留现值（不重密封），Some = 重密封；key_pub None = 不改。
    Credentials::update(
        &vault,
        c.id,
        &CredentialPatch {
            kind: None,
            secret: None,
            key_pub: Some("ssh-ed25519 BBB".into()),
            passphrase: Some("pp2".into()),
            totp_secret: None,
        },
    )
    .unwrap();
    let after = Credentials::get(&vault, c.id).unwrap().unwrap();
    assert_eq!(after.kind, CredentialKind::Key, "kind None=不改");
    assert_eq!(after.key_pub.as_deref(), Some("ssh-ed25519 BBB"));
    assert_eq!(
        Credentials::reveal(&vault, c.id, SecretField::Secret)
            .unwrap()
            .as_deref(),
        Some("-----BEGIN OPENSSH PRIVATE KEY-----"),
        "secret None=保留原密文"
    );
    assert_eq!(
        Credentials::reveal(&vault, c.id, SecretField::Passphrase)
            .unwrap()
            .as_deref(),
        Some("pp2"),
        "passphrase Some=重密封"
    );
}

#[test]
fn delete_credential_unbinds_hosts_and_delete_host_preserves_credential() {
    // 裁定 #3：凭据可复用——删 host 不删凭据；删 credential → 引用它的 host 置空 credential_id。
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let cred = Credentials::create(&vault, &password_input("pw")).unwrap();

    let mut a = host_input("a", "");
    a.credential_id = Some(cred.id);
    let h1 = Hosts::create(&vault, a).unwrap();
    let mut b = host_input("b", "");
    b.credential_id = Some(cred.id);
    let h2 = Hosts::create(&vault, b).unwrap();

    // 删 host：credential 实体保留、另一台主机的绑定不受影响。
    Hosts::delete(&vault, h1.id).unwrap();
    assert!(
        Credentials::get(&vault, cred.id).unwrap().is_some(),
        "删 host 不得级联删凭据"
    );
    assert_eq!(
        Hosts::get(&vault, h2.id).unwrap().unwrap().credential_id,
        Some(cred.id)
    );

    // 删 credential：host.credential_id 置空（FK ON DELETE SET NULL）。
    Credentials::delete(&vault, cred.id).unwrap();
    assert_eq!(
        Hosts::get(&vault, h2.id).unwrap().unwrap().credential_id,
        None,
        "删 credential 必须解绑引用它的 host"
    );

    // 凭据可复用：新建主机可绑定既有凭据。
    let cred2 = Credentials::create(&vault, &password_input("pw2")).unwrap();
    let mut c = host_input("c", "");
    c.credential_id = Some(cred2.id);
    let h3 = Hosts::create(&vault, c).unwrap();
    assert_eq!(
        Hosts::get(&vault, h3.id).unwrap().unwrap().credential_id,
        Some(cred2.id)
    );
}

#[test]
fn host_groups_crud_and_delete_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let parent = HostGroups::create(&vault, "根组", None, None).unwrap();
    let child = HostGroups::create(&vault, "子组", Some(parent.id), Some("#00ff00")).unwrap();

    let mut i = host_input("web-01", "");
    i.group_id = Some(child.id);
    let h = Hosts::create(&vault, i).unwrap();

    assert_eq!(HostGroups::list(&vault).unwrap().len(), 2);

    // 删父组：子组提为根（parent_id SET NULL），子组内主机不受影响。
    HostGroups::delete(&vault, parent.id).unwrap();
    let child_after = HostGroups::get(&vault, child.id).unwrap().unwrap();
    assert_eq!(child_after.parent_id, None, "删父组：子组提根");
    assert_eq!(
        Hosts::get(&vault, h.id).unwrap().unwrap().group_id,
        Some(child.id)
    );

    // 删子组：组内主机脱离分组（SET NULL）。
    HostGroups::delete(&vault, child.id).unwrap();
    assert_eq!(
        Hosts::get(&vault, h.id).unwrap().unwrap().group_id,
        None,
        "删组：组内主机脱离分组"
    );
    assert_eq!(HostGroups::get(&vault, child.id).unwrap(), None);
}

#[test]
fn snippets_crud_search_and_host_scope_unset_on_host_delete() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let s = Snippets::create(
        &vault,
        &SnippetInput {
            name: "重启服务".into(),
            body: "systemctl restart {{svc}}  # 生产环境专用".into(),
            variables: vec!["svc".into()],
            tags: vec!["ops".into()],
            host_scope: None,
        },
    )
    .unwrap();

    let got = Snippets::get(&vault, s.id).unwrap().unwrap();
    assert_eq!(got.body, "systemctl restart {{svc}}  # 生产环境专用");
    assert_eq!(got.variables, vec!["svc".to_string()]);
    assert_eq!(got.tags, vec!["ops".to_string()]);

    assert_eq!(
        Snippets::search(&vault, "生产环境").unwrap().len(),
        1,
        "≥3 字符走 FTS MATCH"
    );
    assert_eq!(
        Snippets::search(&vault, "生产").unwrap().len(),
        1,
        "2 字符走 LIKE 兜底"
    );
    assert!(Snippets::search(&vault, "彻底不存在的检索词")
        .unwrap()
        .is_empty());

    // 更新 body：旧词出索引、新词进索引（触发器同步）。
    Snippets::update(
        &vault,
        s.id,
        &SnippetInput {
            name: "重启服务".into(),
            body: "journalctl -u {{svc}}  # 本地调试".into(),
            variables: vec!["svc".into()],
            tags: vec!["ops".into()],
            host_scope: None,
        },
    )
    .unwrap();
    assert!(
        Snippets::search(&vault, "生产环境").unwrap().is_empty(),
        "更新后旧词必须出索引"
    );
    assert_eq!(Snippets::search(&vault, "本地调试").unwrap().len(), 1);

    // host_scope：删 host → snippet 转全局（SET NULL）。
    let h = Hosts::create(&vault, host_input("h1", "")).unwrap();
    Snippets::update(
        &vault,
        s.id,
        &SnippetInput {
            name: "重启服务".into(),
            body: "journalctl -u {{svc}}  # 本地调试".into(),
            variables: vec!["svc".into()],
            tags: vec!["ops".into()],
            host_scope: Some(h.id),
        },
    )
    .unwrap();
    assert_eq!(
        Snippets::get(&vault, s.id).unwrap().unwrap().host_scope,
        Some(h.id)
    );
    Hosts::delete(&vault, h.id).unwrap();
    assert_eq!(
        Snippets::get(&vault, s.id).unwrap().unwrap().host_scope,
        None,
        "删 host：snippet 转全局"
    );

    Snippets::delete(&vault, s.id).unwrap();
    assert_eq!(Snippets::get(&vault, s.id).unwrap(), None);
}

#[test]
fn known_hosts_state_machine() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let fp = "SHA256:AAAA-BBBB-cccc";

    let k = KnownHosts::upsert(&vault, fp).unwrap();
    assert_eq!(k.state, KnownHostState::Pending, "首次握手先记 pending");
    assert!(!k.verified);
    assert!(k.first_seen > 0);
    assert_eq!(k.changed_at, None);

    // 重复 upsert 幂等：不新增、first_seen 不变。
    let again = KnownHosts::upsert(&vault, fp).unwrap();
    assert_eq!(
        again.first_seen, k.first_seen,
        "重复 upsert 不得刷新 first_seen"
    );
    assert_eq!(KnownHosts::list(&vault).unwrap().len(), 1);

    let ok = KnownHosts::verify(&vault, fp).unwrap();
    assert_eq!(ok.state, KnownHostState::Ok);
    assert!(ok.verified);

    // key 变更：state=changed、verified 作废、changed_at 落值。
    let changed = KnownHosts::mark_changed(&vault, fp).unwrap();
    assert_eq!(changed.state, KnownHostState::Changed);
    assert!(!changed.verified, "key 变更后旧 verified 作废");
    assert!(changed.changed_at.is_some());

    // 未入库指纹直接 mark_changed：以 changed 状态入库。
    let fresh = KnownHosts::mark_changed(&vault, "SHA256:new").unwrap();
    assert_eq!(fresh.state, KnownHostState::Changed);
    assert_eq!(KnownHosts::list(&vault).unwrap().len(), 2);
}
