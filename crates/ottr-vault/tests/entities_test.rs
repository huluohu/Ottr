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
        protocol: Default::default(),
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
        is_production: false,
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

    // 0002 实体表 + 0003（hosts.username）+ 0004（known_hosts host 绑定，Task 8）
    // + 0005（notifications，Task 12）→ 最新版本
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

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
    assert!(
        c2.id > c1.id,
        "credentials rowid 复用：{} → {}",
        c1.id,
        c2.id
    );

    let h1 = Hosts::create(&vault, host_input("a", "")).unwrap();
    Hosts::delete(&vault, h1.id).unwrap();
    let h2 = Hosts::create(&vault, host_input("b", "")).unwrap();
    assert!(h2.id > h1.id, "hosts rowid 复用：{} → {}", h1.id, h2.id);

    let g1 = HostGroups::create(&vault, "g1", None, None).unwrap();
    HostGroups::delete(&vault, g1.id).unwrap();
    let g2 = HostGroups::create(&vault, "g2", None, None).unwrap();
    assert!(
        g2.id > g1.id,
        "host_groups rowid 复用：{} → {}",
        g1.id,
        g2.id
    );

    let s1 = Snippets::create(
        &vault,
        &SnippetInput {
            name: "s1".into(),
            body: "x".into(),
            variables: vec![],
            tags: vec![],
            host_scope: None,
        },
    )
    .unwrap();
    Snippets::delete(&vault, s1.id).unwrap();
    let s2 = Snippets::create(
        &vault,
        &SnippetInput {
            name: "s2".into(),
            body: "x".into(),
            variables: vec![],
            tags: vec![],
            host_scope: None,
        },
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
    let hk = "10.0.0.1:22";
    let fp = "SHA256:AAAA-BBBB-cccc";

    let k = KnownHosts::upsert(&vault, hk, fp).unwrap();
    assert_eq!(k.host_key, hk);
    assert_eq!(k.state, KnownHostState::Pending, "首次握手先记 pending");
    assert!(!k.verified);
    assert!(k.first_seen > 0);
    assert_eq!(k.changed_at, None);

    // 重复 upsert 幂等：不新增、first_seen 不变、**信任锚不被覆盖**（换钥必须走
    // changed 流程，upsert 静默换锚 = 绕过 TOFU 提醒）。
    let again = KnownHosts::upsert(&vault, hk, "SHA256:OTHER").unwrap();
    assert_eq!(
        again.first_seen, k.first_seen,
        "重复 upsert 不得刷新 first_seen"
    );
    assert_eq!(again.fingerprint, fp, "upsert 不得覆盖既有信任锚");
    assert_eq!(KnownHosts::list(&vault).unwrap().len(), 1);

    let ok = KnownHosts::verify(&vault, hk, fp).unwrap();
    assert_eq!(ok.state, KnownHostState::Ok);
    assert!(ok.verified);

    // key 变更：state=changed、verified 作废、changed_at 落值；
    // **信任锚保留旧指纹**（mark_changed 不覆盖——拒绝疑似 MITM 后仍钉原钥匙）。
    let changed = KnownHosts::mark_changed(&vault, hk, "SHA256:new").unwrap();
    assert_eq!(changed.state, KnownHostState::Changed);
    assert!(!changed.verified, "key 变更后旧 verified 作废");
    assert!(changed.changed_at.is_some());
    assert_eq!(
        changed.fingerprint, fp,
        "mark_changed 不得覆盖信任锚（新指纹由 verify 在用户接受后接管）"
    );

    // changed_at 语义钉死（Task 6 裁定 #4）：re-verify 回 ok 后 changed_at
    // **保留**——它是最近一次变更的事件时间，不随信任恢复清空。
    let reverted = KnownHosts::verify(&vault, hk, "SHA256:new").unwrap();
    assert_eq!(reverted.state, KnownHostState::Ok);
    assert!(reverted.verified);
    assert_eq!(reverted.fingerprint, "SHA256:new", "verify 接管新指纹");
    assert_eq!(
        reverted.changed_at, changed.changed_at,
        "re-verify 回 ok 后 changed_at 必须保留"
    );

    // 未入库端点直接 mark_changed：以 changed 状态入库（异常流）。
    let fresh = KnownHosts::mark_changed(&vault, "10.0.0.9:22", "SHA256:new").unwrap();
    assert_eq!(fresh.state, KnownHostState::Changed);
    assert_eq!(KnownHosts::list(&vault).unwrap().len(), 2);
}

/// 【核心回归（Task 8 义务①）】同 host 换钥 → changed 强提醒，而非新一轮 TOFU。
/// 旧 schema（fingerprint 主键）的病灶：换钥后的新指纹查无记录 → 当「首见」
/// pending 处理。本测试按 tofu_host_key_policy 的真实调用序列走一遍。
#[test]
fn same_host_key_rotation_is_changed_not_new_tofu() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let hk = "web.example:22";
    let fp_a = "SHA256:ORIGINAL-KEY";
    let fp_b = "SHA256:ROTATED-KEY";

    // 首连 TOFU：无记录 → upsert pending → 用户 verify → ok（静默放行态）。
    let first = KnownHosts::upsert(&vault, hk, fp_a).unwrap();
    assert_eq!(first.state, KnownHostState::Pending);
    KnownHosts::verify(&vault, hk, fp_a).unwrap();

    // 服务器换钥（或 MITM）：策略层 get(hk) 命中记录、比对 fingerprint 不一致
    // → mark_changed。换钥后同一端点必须还是**同一条记录**。
    let known = KnownHosts::get(&vault, hk)
        .unwrap()
        .expect("换钥后记录必须还在");
    assert_ne!(known.fingerprint, fp_b, "前提：出示的是新指纹");
    let flagged = KnownHosts::mark_changed(&vault, hk, fp_b).unwrap();
    assert_eq!(
        flagged.state,
        KnownHostState::Changed,
        "同 host 换钥 → changed"
    );
    assert!(!flagged.verified);
    assert_eq!(flagged.fingerprint, fp_a, "旧信任锚保留");

    // 用户显式接受新钥匙 → verify 接管新指纹回 ok，changed 历史保留。
    let accepted = KnownHosts::verify(&vault, hk, fp_b).unwrap();
    assert_eq!(accepted.state, KnownHostState::Ok);
    assert_eq!(accepted.fingerprint, fp_b);
    assert_eq!(accepted.changed_at, flagged.changed_at);
    assert_eq!(
        KnownHosts::list(&vault).unwrap().len(),
        1,
        "换钥不产生第二行"
    );
}

/// 不同 host 同指纹共存（义务①验收项）：信任按端点记账，指纹相同（如同一
/// 镜像批量装机）也不得互相吞行。
#[test]
fn different_hosts_same_fingerprint_coexist() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let fp = "SHA256:SHARED-IMAGE-KEY";

    let a = KnownHosts::upsert(&vault, "10.0.0.1:22", fp).unwrap();
    let b = KnownHosts::upsert(&vault, "10.0.0.2:2222", fp).unwrap();
    assert_ne!(a.host_key, b.host_key);
    assert_eq!(a.fingerprint, fp);
    assert_eq!(b.fingerprint, fp);

    // 各自独立流转状态：verify A 不影响 B。
    KnownHosts::verify(&vault, &a.host_key, fp).unwrap();
    assert_eq!(
        KnownHosts::get(&vault, &b.host_key).unwrap().unwrap().state,
        KnownHostState::Pending
    );
    let rows = KnownHosts::list(&vault).unwrap();
    assert_eq!(rows.len(), 2, "不同 host 同指纹必须共存为两行");
}

/// host_endpoint_key：普通地址直拼、IPv6 加方括号；端口段恒为十进制数字
/// （与 0004 迁移的 "legacy:" 虚拟端点不可能碰撞的结构前提）。
#[test]
fn host_endpoint_key_formats() {
    use ottr_vault::host_endpoint_key;
    assert_eq!(host_endpoint_key("10.0.0.1", 22), "10.0.0.1:22");
    assert_eq!(
        host_endpoint_key("web.example.com", 2222),
        "web.example.com:2222"
    );
    assert_eq!(host_endpoint_key("fe80::1", 22), "[fe80::1]:22");
}

/// parse_endpoint_key（B9 巡检/管理页，Task 6 Phase 3）：host_endpoint_key 的
/// 逆映射——端点键 → (address, port)。legacy 虚拟端点与任意畸形键显式拒绝
/// （巡检面只吃可探测的端点，parse 失败 = 跳过，绝不误报 changed）。
#[test]
fn parse_endpoint_key_roundtrip_and_rejects() {
    use ottr_vault::{host_endpoint_key, parse_endpoint_key};
    // 与 host_endpoint_key 互为逆映射（含 IPv6 方括号形态）。
    assert_eq!(
        parse_endpoint_key("10.0.0.1:22"),
        Some(("10.0.0.1".into(), 22))
    );
    assert_eq!(
        parse_endpoint_key("web.example.com:2222"),
        Some(("web.example.com".into(), 2222))
    );
    assert_eq!(
        parse_endpoint_key("[fe80::1]:22"),
        Some(("fe80::1".into(), 22))
    );
    assert_eq!(
        parse_endpoint_key(&host_endpoint_key("2001:db8::1", 2200)),
        Some(("2001:db8::1".into(), 2200))
    );
    // 拒绝面：legacy 虚拟端点、无端口、非数字端口、端口越界、空串。
    assert_eq!(parse_endpoint_key("legacy:SHA256:xxx"), None);
    assert_eq!(parse_endpoint_key("10.0.0.1"), None);
    assert_eq!(parse_endpoint_key("10.0.0.1:"), None);
    assert_eq!(parse_endpoint_key("10.0.0.1:ssh"), None);
    assert_eq!(parse_endpoint_key("10.0.0.1:-1"), None);
    assert_eq!(
        parse_endpoint_key("10.0.0.1:99999"),
        None,
        "端口越 u16 范围拒绝"
    );
    assert_eq!(parse_endpoint_key(""), None);
}

/// KnownHosts::delete（B9 管理页，Task 6 Phase 3）：删除 = 忘记该端点——
/// 行消失后下次连接重走 TOFU（首见 pending）。删除不存在的键返回 false
/// （幂等面），不影响其他端点。
#[test]
fn known_hosts_delete_forgets_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let hk = "10.0.0.7:22";
    KnownHosts::upsert(&vault, hk, "SHA256:FP").unwrap();
    KnownHosts::verify(&vault, hk, "SHA256:FP").unwrap();
    KnownHosts::upsert(&vault, "10.0.0.8:22", "SHA256:OTHER").unwrap();

    assert!(
        KnownHosts::delete(&vault, hk).unwrap(),
        "存在的行删除返回 true"
    );
    assert_eq!(
        KnownHosts::get(&vault, hk).unwrap(),
        None,
        "删除 = 记录消失"
    );
    assert_eq!(
        KnownHosts::list(&vault).unwrap().len(),
        1,
        "其他端点不受影响"
    );
    // 忘记后再连 = 全新 TOFU（pending 重记，first_seen 刷新）。
    let fresh = KnownHosts::upsert(&vault, hk, "SHA256:FP").unwrap();
    assert_eq!(fresh.state, KnownHostState::Pending, "删除后重连重走 TOFU");
    assert!(
        !KnownHosts::delete(&vault, "never-seen:22").unwrap(),
        "删除不存在的键 = false（幂等）"
    );
}

/// 0004 迁移三件套①：v3 库（fingerprint 主键）原位升级——存量行以
/// "legacy:{fingerprint}" 虚拟端点保留（state/changed_at/verified 不丢）。
#[test]
fn migration_0004_preserves_legacy_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vault.db");
    // 手工搭一个 v3 库（meta + 0002 已落地的 hosts/credentials 形状 + 旧
    // known_hosts 形状；0004 只触碰 known_hosts。0010 起后续迁移会 ALTER
    // hosts / 重建 credentials——真实 v3 库必然带有 0002 的实体表，夹具同形）。
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '3');
             CREATE TABLE credentials (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'totp')),
                 secret_enc      BLOB,
                 key_pub         TEXT,
                 passphrase_enc  BLOB,
                 totp_secret_enc BLOB,
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE TABLE hosts (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 group_id INTEGER,
                 tags TEXT NOT NULL DEFAULT '[]',
                 address TEXT NOT NULL,
                 port INTEGER NOT NULL DEFAULT 22,
                 username TEXT,
                 credential_id INTEGER REFERENCES credentials (id) ON DELETE SET NULL,
                 jump_chain_id INTEGER,
                 encoding_override TEXT,
                 theme_override TEXT,
                 monitor_enabled INTEGER NOT NULL DEFAULT 0,
                 notes TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE known_hosts (
                 fingerprint TEXT PRIMARY KEY,
                 first_seen  INTEGER NOT NULL,
                 verified    INTEGER NOT NULL DEFAULT 0,
                 changed_at  INTEGER,
                 state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('ok','changed','pending'))
             );
             INSERT INTO known_hosts (fingerprint, first_seen, verified, changed_at, state)
                 VALUES ('SHA256:OLD-KEY', 1000, 1, 2000, 'changed');",
        )
        .unwrap();
    }
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    let rows = KnownHosts::list(&vault).unwrap();
    assert_eq!(rows.len(), 1, "存量行必须保留，不得静默丢弃重 TOFU");
    let row = &rows[0];
    assert_eq!(row.host_key, "legacy:SHA256:OLD-KEY");
    assert_eq!(row.fingerprint, "SHA256:OLD-KEY");
    assert_eq!(row.state, KnownHostState::Changed);
    assert!(row.verified);
    assert_eq!(row.changed_at, Some(2000));
    assert_eq!(row.first_seen, 1000);
}

/// 0004 迁移三件套②：host_key 唯一性在 schema 层兜底——同端点第二次插入
/// （绕过 upsert 的 DO NOTHING 直写 SQL）必须被 PK 拒绝。
#[test]
fn migration_0004_host_key_is_unique_primary_key() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let conn = vault.connection();
    conn.execute(
        "INSERT INTO known_hosts (host_key, fingerprint, first_seen, verified, state)
         VALUES ('h:22', 'SHA256:A', 1, 0, 'pending')",
        [],
    )
    .unwrap();
    let dup = conn.execute(
        "INSERT INTO known_hosts (host_key, fingerprint, first_seen, verified, state)
         VALUES ('h:22', 'SHA256:B', 2, 0, 'pending')",
        [],
    );
    assert!(dup.is_err(), "host_key 为主键：同端点第二行必须被拒绝");
}

/// 0004 迁移三件套③：新库直接建在 v4——known_hosts 具备 host_key 列且
/// 空表可用（upsert/get/list 走通）。
#[test]
fn migration_0004_fresh_schema_has_host_binding() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
    let k = KnownHosts::upsert(&vault, "10.0.0.1:22", "SHA256:X").unwrap();
    assert_eq!(k.host_key, "10.0.0.1:22");
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );
}

// ---------------------------------------------------------------------------
// 0010_ftp_ftps（Phase 2 Task 5）：hosts.protocol + credentials.kind CHECK 放开
// ---------------------------------------------------------------------------

#[test]
fn migration_0010_host_protocol_roundtrip_and_default() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    // 缺省 = ssh（存量语义零迁移）；显式 ftp/ftps 往返一致
    let plain = Hosts::create(&vault, host_input("legacy", "")).unwrap();
    assert_eq!(plain.protocol, ottr_vault::HostProtocol::Ssh);

    let mut input = host_input("nas", "ftp box");
    input.protocol = ottr_vault::HostProtocol::Ftp;
    input.address = "192.168.1.50".into();
    input.port = 21;
    let ftp = Hosts::create(&vault, input.clone()).unwrap();
    assert_eq!(ftp.protocol, ottr_vault::HostProtocol::Ftp);
    assert_eq!(
        Hosts::get(&vault, ftp.id).unwrap().unwrap().protocol,
        ottr_vault::HostProtocol::Ftp
    );

    input.protocol = ottr_vault::HostProtocol::Ftps;
    input.port = 990;
    let ftps = Hosts::create(&vault, input).unwrap();
    let updated = Hosts::get(&vault, ftps.id).unwrap().unwrap();
    assert_eq!(updated.protocol, ottr_vault::HostProtocol::Ftps);

    // update 全量替换携带 protocol（表单编辑不改协议也不丢）
    let mut edit = host_input("nas", "ftp box");
    edit.protocol = ottr_vault::HostProtocol::Ftps;
    edit.notes = Some("edited".into());
    let after = Hosts::update(&vault, ftp.id, edit).unwrap();
    assert_eq!(after.protocol, ottr_vault::HostProtocol::Ftps);

    // 非法协议值被 CHECK 拒绝（DB 层完整性，非仅应用层）
    let conn = vault.connection();
    let bad = conn.execute(
        "INSERT INTO hosts (name, tags, address, port, protocol, monitor_enabled, created_at, updated_at)
         VALUES ('x', '[]', '1.2.3.4', 22, 'gopher', 0, 0, 0)",
        [],
    );
    assert!(bad.is_err(), "protocol CHECK must reject unknown values");
}

#[test]
fn migration_0010_credential_kind_ftp_rebuild_preserves_secrets_and_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    // 0010 重建后：kind=ftp/ftps 可写入并读回（CHECK 放开），密文通道照常
    let input = CredentialInput {
        kind: CredentialKind::Ftp,
        secret: Some("ftp-secret".into()),
        key_pub: None,
        passphrase: None,
        totp_secret: None,
    };
    let cred = Credentials::create(&vault, &input).unwrap();
    assert_eq!(cred.kind, CredentialKind::Ftp);
    let revealed = Credentials::reveal(&vault, cred.id, SecretField::Secret)
        .unwrap()
        .expect("secret survives table rebuild pipeline");
    assert_eq!(revealed, "ftp-secret");

    let ftps = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Ftps,
            secret: Some("ftps-secret".into()),
            key_pub: None,
            passphrase: None,
            totp_secret: None,
        },
    )
    .unwrap();
    assert_eq!(ftps.kind, CredentialKind::Ftps);

    // kind 更新到新值面（UI 分型切换）
    let patch = CredentialPatch {
        kind: Some(CredentialKind::Ftps),
        secret: None,
        key_pub: None,
        passphrase: None,
        totp_secret: None,
    };
    let changed = Credentials::update(&vault, cred.id, &patch).unwrap();
    assert_eq!(changed.kind, CredentialKind::Ftps);

    // 密文纪律：secret_enc 仍为密文（直读库文件不含明文）。连接守卫在块内
    // 释放——connection() 是互斥锁，持锁调 Credentials::* 会自锁死。
    {
        let conn = vault.connection();
        let raw: Vec<u8> = conn
            .query_row(
                "SELECT secret_enc FROM credentials WHERE id = ?1",
                [cred.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!raw.is_empty());
        let raw_str = raw.iter().map(|&b| b as char).collect::<String>();
        assert!(
            !raw_str.contains("ftp-secret"),
            "plaintext must never touch disk"
        );
    }

    // AUTOINCREMENT 水位在重建中保留：删最大 id 行后新行不复用 id
    // （重建本身等价于一次「水位重放」——迁移 SQL 把旧 seq 搬进新表）
    Credentials::delete(&vault, ftps.id).unwrap();
    let next = Credentials::create(&vault, &password_input("after-migration")).unwrap();
    assert!(
        next.id > ftps.id,
        "credentials id 复用（0010 重建丢水位）：{} vs {}",
        ftps.id,
        next.id
    );
}

/// M-1 力度补强（Fix round 1）：构造**真实 v9 手工库**——credentials 已删过
/// 最大 id 行（AUTOINCREMENT seq=2 > max(id)=1），schema_version=9 走真实
/// 迁移通道 → 0010 重建必须把旧水位搬进新表：迁移后新行 id > 2（不复用已删
/// 行 id=2）。全新库测试在「无水位搬移也绿」的弱断言面上不设防——删行历史
/// 只有 seq > max(id) 的库能侦出。
#[test]
fn migration_0010_preserves_sequence_watermark_from_v9_db_with_delete_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("vault.db");
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            // v9 形状（0001 meta + 0002 hosts/credentials + 0003 username 已就位，
            // schema_version=9 → open 时只跑 0010）
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('schema_version', '9');
             CREATE TABLE credentials (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'totp')),
                 secret_enc      BLOB,
                 key_pub         TEXT,
                 passphrase_enc  BLOB,
                 totp_secret_enc BLOB,
                 created_at      INTEGER NOT NULL,
                 updated_at      INTEGER NOT NULL
             );
             CREATE TABLE hosts (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 group_id INTEGER,
                 tags TEXT NOT NULL DEFAULT '[]',
                 address TEXT NOT NULL,
                 port INTEGER NOT NULL DEFAULT 22,
                 username TEXT,
                 credential_id INTEGER REFERENCES credentials (id) ON DELETE SET NULL,
                 jump_chain_id INTEGER,
                 encoding_override TEXT,
                 theme_override TEXT,
                 monitor_enabled INTEGER NOT NULL DEFAULT 0,
                 notes TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO credentials (id, kind, secret_enc, created_at, updated_at)
                 VALUES (1, 'password', NULL, 1, 1), (2, 'key', NULL, 2, 2);
             DELETE FROM credentials WHERE id = 2;",
        )
        .unwrap();
        // 确认弱面前提：seq > max(id)（删行历史在 sqlite_sequence 留痕）
        let seq: i64 = conn
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='credentials'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let max_id: i64 = conn
            .query_row("SELECT COALESCE(MAX(id), 0) FROM credentials", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            (seq, max_id),
            (2, 1),
            "fixture must encode a delete history (seq > max id)"
        );
    }
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    // 迁移后：新行不复用已删 id=2（水位搬移生效；若 0010 丢水位，AUTOINCREMENT
    // 从 max(id)=1 起算 → 新行 id=2 = 复用 → AAD 旧密文注入面）
    let next = Credentials::create(&vault, &password_input("post-migration")).unwrap();
    assert!(
        next.id > 2,
        "0010 rebuild lost the AUTOINCREMENT watermark: new row id {} reuses deleted id 2",
        next.id
    );
}

#[test]
fn migration_0012_is_production_default_false_and_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    assert_eq!(
        vault.schema_version().unwrap(),
        ottr_vault::store::LATEST_SCHEMA_VERSION
    );

    // 缺省 = 非生产（存量语义零迁移；标记是显式动作）
    let plain = Hosts::create(&vault, host_input("plain", "")).unwrap();
    assert!(!plain.is_production);
    assert!(!Hosts::get(&vault, plain.id).unwrap().unwrap().is_production);

    // 显式标记往返一致；update 全量替换不丢标记
    let mut marked = host_input("prod-db", "production");
    marked.is_production = true;
    let created = Hosts::create(&vault, marked.clone()).unwrap();
    assert!(
        Hosts::get(&vault, created.id)
            .unwrap()
            .unwrap()
            .is_production
    );
    let mut edit = host_input("prod-db", "edited");
    edit.is_production = true;
    edit.notes = Some("edited".into());
    let after = Hosts::update(&vault, created.id, edit).unwrap();
    assert!(
        after.is_production,
        "full-replace update must carry the flag"
    );

    // 非法布尔被 CHECK 拒绝（DB 层完整性，非仅应用层）
    let conn = vault.connection();
    let bad = conn.execute(
        "INSERT INTO hosts (name, tags, address, port, protocol, monitor_enabled, is_production, created_at, updated_at)
         VALUES ('x', '[]', '1.2.3.4', 22, 'ssh', 0, 2, 0, 0)",
        [],
    );
    assert!(bad.is_err(), "is_production CHECK must reject non-0/1");
}

#[test]
fn migration_0012_legacy_v11_rows_default_to_zero() {
    // v11 库（无 is_production 列）打开即补列，存量行按非生产处理
    let dir = tempfile::tempdir().unwrap();
    {
        let vault = open_vault(dir.path());
        Hosts::create(&vault, host_input("legacy-row", "")).unwrap();
    }
    // 手工把 schema_version 拨回 11 + 摘掉 is_production 列 → 模拟旧库重开
    let db = dir.path().join("vault.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "UPDATE meta SET value='11' WHERE key='schema_version';
         ALTER TABLE hosts DROP COLUMN is_production;",
    )
    .unwrap();
    drop(conn);

    let vault = open_vault(dir.path());
    let host = Hosts::get(&vault, 1).unwrap().unwrap();
    assert_eq!(host.name, "legacy-row");
    assert!(
        !host.is_production,
        "v11 rows must migrate to non-production"
    );
}
