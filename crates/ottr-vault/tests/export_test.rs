//! 主机清单 CSV 导出 TDD（BL-206：导出函数归 vault crate——数据层职责随
//! Hosts/HostGroups 同库，独立于 Tauri 层可单测；RFC4180 转义面 + 实体
//! join/序列化端到端）。
//! 纪律（同既有 vault 测试）：tempfile 临时目录 + InMemoryStorage。

mod common;
use ottr_vault::{HostGroups, HostInput, Hosts, Vault};

fn open_vault(dir: &std::path::Path) -> Vault {
    common::open_vault(dir)
}

/// 端到端：分组 join（group_id → 名）+ 各字段序列化 + 危险字符转义。
/// （单字段转义纯函数面在 src/export.rs 单测内直测。）
#[test]
fn hosts_csv_joins_group_and_escapes_cells() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let group = HostGroups::create(&vault, "prod", None, None).unwrap();
    Hosts::create(
        &vault,
        HostInput {
            name: "web,1".into(),
            group_id: Some(group.id),
            tags: vec!["a|b".into()],
            address: "10.0.0.1".into(),
            port: 2222,
            username: Some("deploy".into()),
            protocol: Default::default(),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: Some("line\nbreak".into()),
        },
    )
    .unwrap();

    let csv = ottr_vault::hosts_csv(&vault).unwrap();
    assert!(
        csv.starts_with("name,username,address,port,group,tags,encoding,notes\n"),
        "表头固定：{csv}"
    );
    // name 含逗号 → 整格加引号；group join 出分组名；notes 换行 → 加引号。
    assert!(
        csv.contains("\"web,1\",deploy,10.0.0.1,2222,prod,a|b,,\"line\nbreak\"\n"),
        "行内容：{csv}"
    );
    // 空库 = 只有表头。
    let dir2 = tempfile::tempdir().unwrap();
    let empty = open_vault(dir2.path());
    assert_eq!(
        ottr_vault::hosts_csv(&empty).unwrap(),
        "name,username,address,port,group,tags,encoding,notes\n"
    );
}

/// 多格式导出共用的种子：一台 SSH（全字段）+ 一台 FTP（三格式不进）。
fn seed_ssh_and_ftp(dir: &std::path::Path) -> Vault {
    let vault = open_vault(dir);
    let group = HostGroups::create(&vault, "prod", None, None).unwrap();
    Hosts::create(
        &vault,
        HostInput {
            name: "web 1".into(),
            group_id: Some(group.id),
            tags: vec![],
            address: "10.0.0.1".into(),
            port: 2222,
            username: Some("deploy".into()),
            protocol: Default::default(),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap();
    Hosts::create(
        &vault,
        HostInput {
            name: "files".into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.9".into(),
            port: 21,
            username: None,
            protocol: ottr_vault::entities::HostProtocol::Ftp,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap();
    vault
}

#[test]
fn tabby_json_matches_importer_shape_and_filters_ssh() {
    let dir = tempfile::tempdir().unwrap();
    let vault = seed_ssh_and_ftp(dir.path());
    let json = ottr_vault::tabby_json(&vault).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&json).unwrap();
    let profiles = doc["profiles"].as_array().unwrap();
    assert_eq!(profiles.len(), 1, "FTP 不进 Tabby 导出：{json}");
    assert_eq!(profiles[0]["name"], "web 1");
    assert_eq!(profiles[0]["type"], "ssh");
    assert_eq!(profiles[0]["host"], "10.0.0.1");
    assert_eq!(profiles[0]["port"], 2222);
    assert_eq!(profiles[0]["user"], "deploy");
    // 空库 = 空 profiles 数组（形态仍合法，可回导入零条）。
    let dir2 = tempfile::tempdir().unwrap();
    let empty = open_vault(dir2.path());
    let empty_json = ottr_vault::tabby_json(&empty).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&empty_json).unwrap()["profiles"],
        serde_json::json!([])
    );
}

#[test]
fn ssh_config_text_renders_host_blocks_and_sanitizes_alias() {
    let dir = tempfile::tempdir().unwrap();
    let vault = seed_ssh_and_ftp(dir.path());
    let text = ottr_vault::ssh_config_text(&vault).unwrap();
    // 别名空白替换为 `-`；FTP 主机不进；分组注释保留。
    assert!(
        text.contains("Host web-1\n  HostName 10.0.0.1\n  User deploy\n  Port 2222\n"),
        "{text}"
    );
    assert!(text.contains("# prod"));
    assert!(
        !text.contains("10.0.0.9"),
        "FTP 主机不进 OpenSSH 导出：{text}"
    );
}

#[test]
fn xshell_sessions_render_ini_per_host_with_safe_filenames() {
    let dir = tempfile::tempdir().unwrap();
    let vault = seed_ssh_and_ftp(dir.path());
    let entries = ottr_vault::xshell_sessions(&vault).unwrap();
    assert_eq!(entries.len(), 1, "FTP 不进 Xshell 导出");
    let (filename, content) = &entries[0];
    assert_eq!(filename, "web 1.xsh");
    assert!(content.contains("description=web 1\r\n"), "{content}");
    assert!(content.contains("host=10.0.0.1\r\n"));
    assert!(content.contains("port=2222\r\n"));
    assert!(content.contains("username=deploy\r\n"));
    assert!(content.contains("protocol=SSH\r\n"));
    // 危险文件名字符替换为 `_`（Windows 保留字符不落盘失败）。
    Hosts::create(
        &vault,
        HostInput {
            name: "a/b:c".into(),
            group_id: None,
            tags: vec![],
            address: "10.0.0.2".into(),
            port: 22,
            username: None,
            protocol: Default::default(),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .unwrap();
    let entries = ottr_vault::xshell_sessions(&vault).unwrap();
    let names: Vec<&str> = entries.iter().map(|(f, _)| f.as_str()).collect();
    assert!(names.contains(&"a_b_c.xsh"), "{names:?}");
}
