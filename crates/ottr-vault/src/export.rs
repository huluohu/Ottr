//! 主机清单 CSV 导出（BL-206：导出函数归 vault crate——实体 join 与序列化
//! 是数据层职责，随 Hosts/HostGroups 同库可独立单测；desktop 命令面只保留
//! 路径解析（下载目录缺省）与落盘，见 desktop vault.rs `export_hosts_csv`）。
//!
//! 口径（RFC4180）：分隔符 `,`、行尾 `\n`；含逗号/引号/换行的字段整体加引号、
//! 内部引号翻倍；无引号需求的字段原样。表头固定八列。

use std::collections::HashMap;

use crate::entities::{HostGroups, Hosts};
use crate::{Result, Vault};

/// 主机清单 CSV（RFC4180：含逗号/引号/换行的字段加引号、引号翻倍）。
/// 分组列按 group_id join 分组名（悬空/无分组 = 空串）。
pub fn hosts_csv(vault: &Vault) -> Result<String> {
    let groups: HashMap<i64, String> = HostGroups::list(vault)?
        .into_iter()
        .map(|g| (g.id, g.name))
        .collect();
    let mut out = String::from("name,username,address,port,group,tags,encoding,notes\n");
    for h in Hosts::list(vault)? {
        let group = h
            .group_id
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
        let row: Vec<String> = vec![
            h.name.clone(),
            h.username.clone().unwrap_or_default(),
            h.address.clone(),
            h.port.to_string(),
            group.to_string(),
            h.tags.join("|"),
            h.encoding_override.clone().unwrap_or_default(),
            h.notes.clone().unwrap_or_default(),
        ];
        let cells: Vec<String> = row.iter().map(|c| csv_field(c)).collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    Ok(out)
}

/// 单字段转义：危险字符（`,` `"` CR LF）任一出现即整体加引号、内部引号翻倍。
fn csv_field(v: &str) -> String {
    if v.contains(',') || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    /// 转义纯函数直测面（集成测试经 `hosts_csv` 间接覆盖行级转义）。
    #[test]
    fn csv_field_quotes_only_when_needed() {
        assert_eq!(super::csv_field("plain"), "plain");
        assert_eq!(super::csv_field("a,b"), "\"a,b\"");
        assert_eq!(super::csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
        assert_eq!(super::csv_field("line\nbreak"), "\"line\nbreak\"");
        assert_eq!(super::csv_field("carriage\rreturn"), "\"carriage\rreturn\"");
    }
}
