//! 主机清单 CSV 导出 TDD（BL-206：导出函数归 vault crate——数据层职责随
//! Hosts/HostGroups 同库，独立于 Tauri 层可单测；RFC4180 转义面 + 实体
//! join/序列化端到端）。
//! 纪律（同既有 vault 测试）：tempfile 临时目录 + InMemoryStorage。

use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostGroups, HostInput, Hosts, Vault};

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
        protocol: Default::default(),
        credential_id: None,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: false,
        is_production: false,
        notes: Some(notes.into()),
    }
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
