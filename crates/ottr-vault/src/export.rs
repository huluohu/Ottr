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

// --- 多格式导出（2026-10-16 用户需求：导出对齐导入四类型）-------------------
// Tabby JSON / Xshell 会话目录 / OpenSSH config 三格式与对应导入器解析面对表，
// 与 CSV 同一口径：**只出元数据，不出凭据**（秘密不出库）。

use crate::entities::HostProtocol;

/// SSH 域主机过滤：Tabby/Xshell/OpenSSH 三格式是 SSH 生态，FTP/FTPS 不进
/// （对应导入器同样只收 SSH）。
fn ssh_hosts(vault: &Vault) -> Result<Vec<crate::entities::Host>> {
    Ok(Hosts::list(vault)?
        .into_iter()
        .filter(|h| h.protocol == HostProtocol::Ssh)
        .collect())
}

/// Tabby 配置 JSON（`{"profiles":[…]}`）。字段与 `importers::tabby` 解析面对表：
/// name / type("ssh") / host / port / user（可空省略）；serde_json 端到端转义。
pub fn tabby_json(vault: &Vault) -> Result<String> {
    #[derive(serde::Serialize)]
    struct Profile<'a> {
        name: &'a str,
        #[serde(rename = "type")]
        kind: &'static str,
        host: &'a str,
        port: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        user: Option<&'a str>,
    }
    #[derive(serde::Serialize)]
    struct Doc<'a> {
        profiles: Vec<Profile<'a>>,
    }
    let hosts = ssh_hosts(vault)?;
    let profiles = hosts
        .iter()
        .map(|h| Profile {
            name: h.name.as_str(),
            kind: "ssh",
            host: h.address.as_str(),
            port: h.port,
            user: h.username.as_deref(),
        })
        .collect::<Vec<_>>();
    let doc = Doc { profiles };
    Ok(serde_json::to_string_pretty(&doc)?)
}

/// OpenSSH config 文本：每主机一个 Host 块（HostName/User/Port）。别名 = 主机
/// 名（OpenSSH pattern 不容空白，空白替换为 `-`）；分组/标签以注释行保留上下文。
pub fn ssh_config_text(vault: &Vault) -> Result<String> {
    let groups: HashMap<i64, String> = HostGroups::list(vault)?
        .into_iter()
        .map(|g| (g.id, g.name))
        .collect();
    let mut out = String::from("# Exported from Ottr — OpenSSH compatible host entries\n");
    for h in ssh_hosts(vault)? {
        let alias = h.name.replace([' ', '\t'], "-");
        let group = h
            .group_id
            .and_then(|id| groups.get(&id))
            .map(String::as_str)
            .unwrap_or("");
        out.push_str(&format!(
            "\n# {group}\nHost {alias}\n  HostName {}\n",
            h.address
        ));
        if let Some(user) = h.username.as_deref().filter(|u| !u.is_empty()) {
            out.push_str(&format!("  User {user}\n"));
        }
        out.push_str(&format!("  Port {}\n", h.port));
    }
    Ok(out)
}

/// Xshell 会话条目（每主机一个 .xsh）：返回 `(文件名, 内容)`；键面与
/// `importers::xshell` 解析面对表（description/host/port/username 跨 section
/// 大小写不敏感）。INI 是 Windows 血统：CRLF 行尾，UTF-8 BOM 由落盘方统一加。
/// 文件名 sanitize：Windows 文件名保留字符与首尾空白替换为 `_`，防落盘失败。
pub fn xshell_sessions(vault: &Vault) -> Result<Vec<(String, String)>> {
    fn safe_name(name: &str) -> String {
        let cleaned: String = name
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                _ => c,
            })
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            "_".to_string()
        } else {
            trimmed.to_string()
        }
    }
    let mut out = Vec::new();
    for h in ssh_hosts(vault)? {
        let name = safe_name(&h.name);
        let content = format!(
            "[{}]\r\ndescription={}\r\nhost={}\r\nport={}\r\nprotocol=SSH\r\nusername={}\r\n",
            name,
            h.name,
            h.address,
            h.port,
            h.username.as_deref().unwrap_or_default(),
        );
        out.push((format!("{name}.xsh"), content));
    }
    Ok(out)
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
