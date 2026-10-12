//! 主机清单 CSV 回导入（2026-10-12 用户反馈：导出的格式必须能导回）。
//! 与 export.rs hosts_csv 完全对表：RFC4180（`,` 分隔、引号包裹、内部引号
//! 翻倍），表头 8 列 name,username,address,port,group,tags,encoding,notes；
//! tags 以 `|` 分隔；分组按名解析、缺失即建；去重键与 ssh_config 导入一致
//! （address+port+username）。报告复用 ImportReport（skipped_wildcards 恒 0，
//! 前端对非 ssh 源已按「跳过条目」语义展示）。

use std::collections::HashSet;

use ottr_vault::Vault;
use ottr_vault::entities::{HostGroups, HostInput, Hosts};

use crate::ssh_config::ImportReport;

/// 导出表头（与 export.rs hosts_csv 固定表头一致；容忍 UTF-8 BOM 前缀）。
pub const HEADER: &str = "name,username,address,port,group,tags,encoding,notes";

/// 解析产物：port 已校验为 i64 的数据行 + 逐行错误（行号从 2 起计，1 为表头）。
pub struct CsvOutcome {
    pub rows: Vec<CsvRow>,
    pub errors: Vec<String>,
}

pub struct CsvRow {
    pub name: String,
    pub username: Option<String>,
    pub address: String,
    pub port: i64,
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub encoding: Option<String>,
    pub notes: Option<String>,
}

/// RFC4180 解析：`"` 包裹字段内 `,`/换行/双引号按 CSV 规则折叠；裸引号视为
/// 字面字符。
fn split_csv(content: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut field = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut in_quotes = false;
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' if field.is_empty() => in_quotes = true,
                ',' => row.push(std::mem::take(&mut field)),
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                '\r' => {}
                c => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(std::mem::take(&mut field));
        rows.push(row);
    }
    rows
}

/// 解析：表头校验 + 行级字段数/端口校验（坏行进 errors 不中断）。
pub fn parse(content: &str) -> CsvOutcome {
    let rows = split_csv(content);
    let mut out = CsvOutcome {
        rows: Vec::new(),
        errors: Vec::new(),
    };
    let mut data = rows.into_iter().filter(|r| !r.is_empty());
    match data.next() {
        Some(header) => {
            let first = header.first().map(String::as_str).unwrap_or("");
            let normalized = first.strip_prefix('\u{feff}').unwrap_or(first);
            let expected: Vec<&str> = HEADER.split(',').collect();
            let actual: Vec<String> = header
                .iter()
                .map(|h| h.trim().trim_start_matches('\u{feff}').to_string())
                .collect();
            if actual != expected || normalized != expected[0] {
                out.errors.push(format!(
                    "表头不符：期望「{HEADER}」，实际「{}」",
                    actual.join(",")
                ));
                return out;
            }
        }
        None => {
            out.errors.push("文件为空".to_string());
            return out;
        }
    }
    for (idx, row) in data.enumerate() {
        let line = idx + 2; // 表头占第 1 行
        if row.iter().all(|f| f.trim().is_empty()) {
            continue; // 空行静默跳过
        }
        if row.len() != 8 {
            out.errors
                .push(format!("第 {line} 行字段数 {} ≠ 8，已跳过", row.len()));
            continue;
        }
        let port = match row[3].trim().parse::<i64>() {
            Ok(p) => p,
            Err(_) => {
                out.errors
                    .push(format!("第 {line} 行端口「{}」不是数字，已跳过", row[3]));
                continue;
            }
        };
        let opt = |s: &String| {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        };
        let name = row[0].trim().to_string();
        let address = row[2].trim().to_string();
        if name.is_empty() || address.is_empty() {
            out.errors
                .push(format!("第 {line} 行名称或地址为空，已跳过"));
            continue;
        }
        out.rows.push(CsvRow {
            name,
            username: opt(&row[1]),
            address,
            port,
            group: opt(&row[4]),
            tags: row[5]
                .split('|')
                .filter(|t| !t.is_empty())
                .map(String::from)
                .collect(),
            encoding: opt(&row[6]),
            notes: opt(&row[7]),
        });
    }
    out
}

/// 落库：分组按名解析、缺失即建；去重键 = (address, port, username)。
pub fn import_entries(vault: &Vault, outcome: CsvOutcome) -> ottr_vault::Result<ImportReport> {
    let mut groups: std::collections::HashMap<String, i64> = HostGroups::list(vault)?
        .into_iter()
        .map(|g| (g.name, g.id))
        .collect();
    let mut seen: HashSet<(String, i64, Option<String>)> = Hosts::list(vault)?
        .into_iter()
        .map(|h| (h.address, h.port, h.username))
        .collect();
    let mut report = ImportReport {
        added: 0,
        skipped_wildcards: 0,
        skipped_duplicates: 0,
        errors: outcome.errors,
    };
    for row in outcome.rows {
        let key = (row.address.clone(), row.port, row.username.clone());
        if seen.contains(&key) {
            report.skipped_duplicates += 1;
            continue;
        }
        let group_id = match &row.group {
            Some(name) => match groups.get(name) {
                Some(id) => Some(*id),
                None => {
                    let g = HostGroups::create(vault, name, None, None)?;
                    groups.insert(name.clone(), g.id);
                    Some(g.id)
                }
            },
            None => None,
        };
        Hosts::create(
            vault,
            HostInput {
                protocol: Default::default(),
                name: row.name,
                group_id,
                tags: row.tags,
                address: row.address,
                port: row.port,
                username: row.username,
                credential_id: None,
                jump_chain_id: None,
                encoding_override: row.encoding,
                theme_override: None,
                monitor_enabled: false,
                is_production: false,
                notes: row.notes,
            },
        )?;
        seen.insert(key);
        report.added += 1;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trip_with_quotes_and_multiline() {
        let content = "name,username,address,port,group,tags,encoding,notes\n\
                       web,root,10.0.0.1,22,prod,web|edge,,普通备注\n\
                       \"a,b\",\"u\"\"x\",10.0.0.2,2222,,,\"\",\n";
        let out = parse(content);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.rows.len(), 2);
        let first = &out.rows[0];
        assert_eq!(first.name, "web");
        assert_eq!(first.tags, vec!["web", "edge"]);
        assert_eq!(first.group.as_deref(), Some("prod"));
        let second = &out.rows[1];
        assert_eq!(second.name, "a,b");
        assert_eq!(second.username.as_deref(), Some("u\"x"));
        assert_eq!(second.port, 2222);
    }

    #[test]
    fn parse_rejects_wrong_header_and_bad_port() {
        let out = parse("foo,bar,baz,qux,a,b,c,d\n");
        assert!(out.rows.is_empty());
        assert!(out.errors[0].contains("表头不符"));

        let out = parse(
            "name,username,address,port,group,tags,encoding,notes\nweb,root,10.0.0.1,ssh,,,,\n",
        );
        assert!(out.rows.is_empty());
        assert!(out.errors[0].contains("不是数字"));
    }

    #[test]
    fn import_creates_groups_and_dedupes() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .unwrap();
        let out = parse(
            "name,username,address,port,group,tags,encoding,notes\n\
             web,root,10.0.0.1,22,prod,web,,\n\
             db,,10.0.0.2,5432,prod,,,\n\
             web,root,10.0.0.1,22,prod,,,\n",
        );
        let report = import_entries(&vault, out).unwrap();
        assert_eq!(report.added, 2);
        assert_eq!(report.skipped_duplicates, 1);
        // 分组按名解析（两行共用 prod 组，只建一次）
        let groups = HostGroups::list(&vault).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "prod");
        let hosts = Hosts::list(&vault).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].group_id, Some(groups[0].id));
    }
}
