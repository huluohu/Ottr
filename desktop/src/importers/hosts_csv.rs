//! 主机清单 CSV 回导入（2026-10-12 用户反馈：导出的格式必须能导回）。
//! 与 export.rs hosts_csv 完全对表：RFC4180（`,` 分隔、引号包裹、内部引号
//! 翻倍），表头 8 列 name,username,address,port,group,tags,encoding,notes；
//! tags 以 `|` 分隔；分组按名解析、缺失即建；去重键与 ssh_config 导入一致
//! （address+port+username）。报告复用 ImportReport（skipped_wildcards 恒 0，
//! 前端对非 ssh 源已按「跳过条目」语义展示）。

use std::collections::HashSet;

use ottr_vault::Vault;
use ottr_vault::entities::HostProtocol;

use crate::ssh_config::{ImportIssue, ImportReport};

/// 导出表头（与 export.rs hosts_csv 固定表头一致；容忍 UTF-8 BOM 前缀）。
pub const HEADER: &str = "name,username,address,port,group,tags,encoding,notes";
/// 11 列表头（CSV 往返修复：带 protocol/monitor_enabled/is_production——
/// 此前导出→导入把 FTP/FTPS 主机静默变回 SSH、监控/生产标记归 false）。
pub const HEADER_V2: &str =
    "name,username,address,port,group,tags,encoding,notes,protocol,monitor_enabled,is_production";

/// 解析产物：port 已校验为 i64 的数据行 + 逐行错误（行号从 2 起计，1 为表头）。
pub struct CsvOutcome {
    pub rows: Vec<CsvRow>,
    pub errors: Vec<ImportIssue>,
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
    /// 11 列表头才有；旧 8 列 CSV 缺省 Ssh（与旧导入语义一致）。
    pub protocol: HostProtocol,
    pub monitor_enabled: bool,
    pub is_production: bool,
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
            let expected_v2: Vec<&str> = HEADER_V2.split(',').collect();
            let actual: Vec<String> = header
                .iter()
                .map(|h| h.trim().trim_start_matches('\u{feff}').to_string())
                .collect();
            let extended = actual == expected_v2;
            if (!extended && actual != expected) || normalized != expected[0] {
                out.errors.push(ImportIssue::with(
                    "csv.header_mismatch",
                    &[
                        ("expected", HEADER_V2.to_string()),
                        ("actual", actual.join(",")),
                    ],
                ));
                return out;
            }
        }
        None => {
            out.errors.push(ImportIssue::new("csv.empty_file"));
            return out;
        }
    }
    for (idx, row) in data.enumerate() {
        let line = idx + 2; // 表头占第 1 行
        if row.iter().all(|f| f.trim().is_empty()) {
            continue; // 空行静默跳过
        }
        // 8 列 = 旧格式；11 列 = 带 protocol/monitor_enabled/is_production。
        // 行级判断（与表头解耦：同一文件混排旧行也按列数走）。
        let extended = row.len() == 11;
        if row.len() != 8 && !extended {
            out.errors.push(ImportIssue::with(
                "csv.row_field_count",
                &[
                    ("line", line.to_string()),
                    ("actual", row.len().to_string()),
                ],
            ));
            continue;
        }
        let port = match row[3].trim().parse::<i64>() {
            Ok(p) => p,
            Err(_) => {
                out.errors.push(ImportIssue::with(
                    "csv.port_not_number",
                    &[("line", line.to_string()), ("value", row[3].clone())],
                ));
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
            out.errors.push(ImportIssue::with(
                "csv.missing_name_or_address",
                &[("line", line.to_string())],
            ));
            continue;
        }
        // 协议列：空 = 缺省；非法值 = 行级报错跳过（绝不静默映射成别的协议）。
        let protocol = if extended {
            let raw = row[8].trim();
            if raw.is_empty() {
                HostProtocol::default()
            } else {
                match raw.to_ascii_lowercase().parse::<HostProtocol>() {
                    Ok(p) => p,
                    Err(_) => {
                        out.errors.push(ImportIssue::with(
                            "csv.protocol_invalid",
                            &[("line", line.to_string()), ("value", raw.to_string())],
                        ));
                        continue;
                    }
                }
            }
        } else {
            HostProtocol::default()
        };
        let flag =
            |s: &String| matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes");
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
            protocol,
            monitor_enabled: extended && flag(&row[9]),
            is_production: extended && flag(&row[10]),
        });
    }
    out
}

/// 落库：分组按名解析、缺失即建；去重键 = (address, port, username)。
///
/// **全程单事务**（robustness 审计 P2：此前逐行 create 各自独立事务，中途
/// 失败 `?` 上抛留半截 + ImportReport 丢失）：`with_conn` +
/// `unchecked_transaction` 形态（先例 ottr-vault sync_snapshot），单行失败
/// 记入 report.errors 并 continue，最后统一提交。行为兼容：成功行照常入库，
/// 失败行在报告里可见。行级校验/INSERT 与 ottr-vault `Hosts::create` 同规则
/// （校验器与 SQL 不出 crate——依赖纪律 desktop 不引 rusqlite——镜像见
/// [`crate::ssh_config::validate_host_row`] 与 [`crate::ssh_config::HOST_INSERT_SQL`]）。
pub fn import_entries(vault: &Vault, outcome: CsvOutcome) -> ottr_vault::Result<ImportReport> {
    use crate::ssh_config::{HOST_INSERT_SQL, now_ts, validate_group_row, validate_host_row};
    vault.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let ts = now_ts();
        let mut groups: std::collections::HashMap<String, i64> = {
            let mut stmt = tx.prepare("SELECT id, name FROM host_groups")?;
            let rows = stmt.query_map([], |r| Ok((r.get(1)?, r.get(0)?)))?;
            rows.collect::<Result<std::collections::HashMap<_, _>, _>>()?
        };
        let mut seen: HashSet<(String, i64, Option<String>)> = {
            let mut stmt = tx.prepare("SELECT address, port, username FROM hosts")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<Result<HashSet<_>, _>>()?
        };
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
            // 行级校验（与 Hosts::create 同规则）：失败记报告并跳过该行
            if let Err(reason) =
                validate_host_row(&row.name, &row.address, row.port, row.username.as_deref())
            {
                report.errors.push(ImportIssue::with(
                    "csv.row_invalid",
                    &[("name", row.name.clone()), ("reason", reason)],
                ));
                continue;
            }
            let group_id = match &row.group {
                Some(name) => match groups.get(name) {
                    Some(id) => Some(*id),
                    None => {
                        // 分组按名解析、缺失即建（同事务；建组失败 = 该行失败）
                        if let Err(reason) = validate_group_row(name) {
                            report.errors.push(ImportIssue::with(
                                "csv.row_invalid",
                                &[("name", row.name.clone()), ("reason", reason)],
                            ));
                            continue;
                        }
                        let created = tx.execute(
                            "INSERT INTO host_groups (name, parent_id, color, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?4)",
                            (
                                name.as_str(),
                                Option::<i64>::None,
                                Option::<String>::None,
                                ts,
                            ),
                        );
                        match created {
                            Ok(_) => {
                                let id = tx.last_insert_rowid();
                                groups.insert(name.clone(), id);
                                Some(id)
                            }
                            Err(e) => {
                                report.errors.push(ImportIssue::with(
                                    "csv.row_invalid",
                                    &[(
                                        "name",
                                        row.name.clone(),
                                    ), ("reason", format!("create group {name}: {e}"))],
                                ));
                                continue;
                            }
                        }
                    }
                },
                None => None,
            };
            let tags_json =
                serde_json::to_string(&row.tags).expect("Vec<String> 总能序列化");
            // 参数 15 元组：?15 占位符出现两次（created_at/updated_at 同 ts），
            // 只绑一个值——entities.rs Hosts::create 的 params! 同款计数。
            let inserted = tx.execute(
                HOST_INSERT_SQL,
                (
                    row.name.as_str(),
                    group_id,
                    tags_json.as_str(),
                    row.address.as_str(),
                    row.port,
                    row.username.as_deref(),
                    row.protocol.as_str(),
                    Option::<i64>::None,
                    Option::<i64>::None,
                    row.encoding.as_deref(),
                    Option::<String>::None,
                    row.monitor_enabled,
                    row.is_production,
                    row.notes.as_deref(),
                    ts,
                ),
            );
            if let Err(e) = inserted {
                report.errors.push(ImportIssue::with(
                    "csv.row_invalid",
                    &[("name", row.name), ("reason", e.to_string())],
                ));
                continue;
            }
            seen.insert(key);
            report.added += 1;
        }
        tx.commit()?;
        Ok(report)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // 断言面直驱 vault 实体（导入本体走单事务 SQL，与实体入口互不依赖）
    use ottr_vault::entities::{HostGroups, Hosts};

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
        assert_eq!(out.errors[0].code, "csv.header_mismatch");

        let out = parse(
            "name,username,address,port,group,tags,encoding,notes\nweb,root,10.0.0.1,ssh,,,,\n",
        );
        assert!(out.rows.is_empty());
        assert_eq!(out.errors[0].code, "csv.port_not_number");
    }

    #[test]
    fn parse_v2_round_trip_preserves_protocol_and_flags() {
        // 11 列表头：protocol/monitor_enabled/is_production 往返不丢
        // （此前导出→导入把 FTP/FTPS 主机静默变回 SSH、两个标记归 false）。
        let out = parse(
            "name,username,address,port,group,tags,encoding,notes,protocol,monitor_enabled,is_production\n\
             nas,admin,10.0.0.9,21,,nas,,,ftp,true,true\n\
             web,root,10.0.0.1,22,,web,,,ftps,false,TRUE\n\
             old,root,10.0.0.3,22,,,,\n",
        );
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(out.rows[0].protocol, HostProtocol::Ftp);
        assert!(out.rows[0].monitor_enabled);
        assert!(out.rows[0].is_production);
        assert_eq!(out.rows[1].protocol, HostProtocol::Ftps);
        assert!(!out.rows[1].monitor_enabled);
        assert!(out.rows[1].is_production, "TRUE 大小写不敏感");
        // 混排旧行（8 列）按行级列数走旧缺省
        assert_eq!(out.rows[2].protocol, HostProtocol::Ssh);
        assert!(!out.rows[2].monitor_enabled);

        // 非法协议值：行级报错跳过，绝不静默映射
        let out = parse(
            "name,username,address,port,group,tags,encoding,notes,protocol,monitor_enabled,is_production\n\
             bad,root,10.0.0.4,22,,,,,sftp,true,false\n",
        );
        assert!(out.rows.is_empty());
        assert_eq!(out.errors[0].code, "csv.protocol_invalid");
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
