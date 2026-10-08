//! ssh config 导入（Task 5 Step 3）：
//!
//! 解析规则（裁定 #1）：逐行 `Keyword Value`（大小写不敏感），只取
//! Host / HostName / Port / User / IdentityFile，其余关键字忽略；
//! - `Host` 行支持多 pattern（OpenSSH 语义：每 pattern 一份独立主机条目）；
//! - 通配模式（含 `*`/`?`）与 `!` 排除模式跳过并计数（pattern 级）；
//! - 缺省：address = HostName 缺省时回落 Host 别名、port 缺省 22、user 可空；
//! - Port 值非法 → 整个块不导入，计入解析错误行列表（宁可少导不错导）；
//! - 去重：与库中已有主机或文件内先前者 address+port+username 全同 → 跳过计数；
//! - IdentityFile 非敏感、暂记入 notes（`IdentityFile: <path>`）——凭据实体化
//!   （读私钥内容 seal）属 Task 6 KeyManager 域，不在导入器里发明。

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;

use ottr_vault::{HostInput, Hosts, Vault};

/// 解析出的单个主机条目（通配/排除 pattern 不在此列）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SshConfigEntry {
    /// Host 别名（pattern 原文，作主机名）。
    pub host: String,
    pub hostname: Option<String>,
    /// None = 未指定（导入时缺省 22）。
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
}

/// 一次性解析结果：条目 + 通配跳过数 + 错误行列表（`L{行号}: {原因}`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseOutcome {
    pub entries: Vec<SshConfigEntry>,
    pub skipped_wildcards: usize,
    pub errors: Vec<String>,
}

/// 导入报告（裁定 #4：新增 N、跳过 N、解析错误行列表，导入完成对话框展示）。
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub added: usize,
    pub skipped_wildcards: usize,
    pub skipped_duplicates: usize,
    pub errors: Vec<String>,
}

/// 默认配置路径：`~/.ssh/config`（HOME / USERPROFILE 均兼顾三端）。
pub fn default_ssh_config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let home = PathBuf::from(home);
    if home.as_os_str().is_empty() {
        return None;
    }
    Some(home.join(".ssh").join("config"))
}

/// 解析 ssh config 文本。空文件/无可用条目返回空 outcome（不报错）。
pub fn parse_config(content: &str) -> ParseOutcome {
    let mut outcome = ParseOutcome::default();
    // 当前块：每个非通配 pattern 一份 pending 条目（共享后续 Keyword 赋值）。
    let mut pending: Vec<SshConfigEntry> = Vec::new();
    // 当前块是否已带致命错误（如 Port 非法）——置位后整块不导入。
    let mut block_error: Option<String> = None;

    for (idx, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, value) = split_keyword(line);
        match keyword.to_ascii_lowercase().as_str() {
            "host" => {
                flush_block(&mut pending, &mut block_error, &mut outcome);
                for pattern in split_patterns(value) {
                    // 通配 / 排除 pattern：跳过并计数（裁定 #1）。
                    if pattern.contains('*') || pattern.contains('?') || pattern.starts_with('!') {
                        outcome.skipped_wildcards += 1;
                    } else {
                        pending.push(SshConfigEntry {
                            host: pattern,
                            hostname: None,
                            port: None,
                            user: None,
                            identity_file: None,
                        });
                    }
                }
            }
            "hostname" => {
                if !value.is_empty() {
                    for e in &mut pending {
                        e.hostname = Some(value.to_string());
                    }
                }
            }
            "port" => match value.parse::<u16>() {
                Ok(p) if p > 0 => {
                    for e in &mut pending {
                        e.port = Some(p);
                    }
                }
                _ => {
                    block_error = Some(format!("L{}: Port '{}' 不可解析", idx + 1, value));
                }
            },
            "user" => {
                if !value.is_empty() {
                    for e in &mut pending {
                        e.user = Some(value.to_string());
                    }
                }
            }
            "identityfile" => {
                let path = unquote(value);
                if !path.is_empty() {
                    for e in &mut pending {
                        e.identity_file = Some(path.to_string());
                    }
                }
            }
            _ => {} // ForwardAgent 等其余关键字：忽略
        }
    }
    flush_block(&mut pending, &mut block_error, &mut outcome);
    outcome
}

/// 拆出关键字与值：首个空白前为关键字，剩余为值（再剥一层成对引号）。
fn split_keyword(line: &str) -> (&str, &str) {
    match line.split_once(char::is_whitespace) {
        Some((k, v)) => (k, v.trim()),
        None => (line, ""),
    }
}

/// Host 行的多 pattern 拆分（空白分隔；pattern 本身不支持引号含空格——
/// OpenSSH 语法允许但实践罕见，遇引号按字面保留）。
fn split_patterns(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_string).collect()
}

/// 剥成对双引号（IdentityFile 路径含空格的常见写法）。
fn unquote(value: &str) -> &str {
    let v = value.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        &v[1..v.len() - 1]
    } else {
        v
    }
}

/// 块结束：无致命错误的 pending 条目落 outcome，清空当前块状态。
fn flush_block(
    pending: &mut Vec<SshConfigEntry>,
    block_error: &mut Option<String>,
    outcome: &mut ParseOutcome,
) {
    if let Some(err) = block_error.take() {
        outcome.errors.push(err);
    } else {
        outcome.entries.append(pending);
    }
    pending.clear();
}

/// 把解析条目导入 vault（去重 + 落库）。错误行原样透传进报告。
///
/// 去重键 = (address, port, username)：先取库内全量主机建索引，再边导边查
/// （同键的文件内重复一并去重）。逐条 create、无包裹事务：导入中断留已导入
/// 部分，重跑同一文件可续（重复项全被去重跳过）——幂等性优先于原子性。
pub fn import_entries(vault: &Vault, outcome: ParseOutcome) -> ottr_vault::Result<ImportReport> {
    let mut seen: HashSet<(String, i64, Option<String>)> = Hosts::list(vault)?
        .into_iter()
        .map(|h| (h.address, h.port, h.username))
        .collect();
    let mut report = ImportReport {
        added: 0,
        skipped_wildcards: outcome.skipped_wildcards,
        skipped_duplicates: 0,
        errors: outcome.errors,
    };
    for entry in outcome.entries {
        let address = entry.hostname.unwrap_or_else(|| entry.host.clone());
        let port = i64::from(entry.port.unwrap_or(22));
        let key = (address.clone(), port, entry.user.clone());
        if seen.contains(&key) {
            report.skipped_duplicates += 1;
            continue;
        }
        Hosts::create(
            vault,
            HostInput {
                protocol: Default::default(),
                name: entry.host,
                group_id: None,
                tags: vec![],
                address,
                port,
                username: entry.user,
                credential_id: None,
                jump_chain_id: None,
                encoding_override: None,
                theme_override: None,
                monitor_enabled: false,
                is_production: false,
                notes: entry.identity_file.map(|f| format!("IdentityFile: {f}")),
            },
        )?;
        seen.insert(key);
        report.added += 1;
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// 解析 golden（裁定 #1：fixtures/ssh_config 样例含通配、多主机、缺省字段）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/ssh_config"
        ))
        .expect("read fixtures/ssh_config")
    }

    /// golden：夹具全文的解析结果逐字段锁定（防解析器回归静默改变导入语义）。
    #[test]
    fn parse_golden_fixture() {
        let outcome = parse_config(&fixture());
        let entries = outcome.entries;
        assert_eq!(entries.len(), 6, "6 个可导入条目（通配/错误块除外）");
        // golden：port 缺省在解析层保持 null（未指定），导入层回落 22
        assert_eq!(
            serde_json::to_string(&entries).unwrap(),
            concat!(
                r#"[{"host":"web-01","hostname":"192.168.1.10","port":2222,"user":"deploy","identity_file":"~/.ssh/id_ed25519"},"#,
                r#"{"host":"db-master","hostname":"10.0.0.5","port":null,"user":"backup","identity_file":null},"#,
                r#"{"host":"192.168.1.20","hostname":"10.0.0.5","port":null,"user":"backup","identity_file":null},"#,
                r#"{"host":"bastion","hostname":"bastion.example.com","port":null,"user":null,"identity_file":null},"#,
                r#"{"host":"spaced-host","hostname":"10.0.0.9","port":null,"user":null,"identity_file":"/Users/ottr/My Keys/id_rsa"},"#,
                r#"{"host":"web-01-copy","hostname":"192.168.1.10","port":2222,"user":"deploy","identity_file":null}]"#
            )
        );
        // 通配 2（prod-*、*.lan）+ 排除 1（!exclude-me）
        assert_eq!(outcome.skipped_wildcards, 3);
        // bad-port 块整块不导入，错误行带行号
        assert_eq!(outcome.errors, vec!["L29: Port 'not-a-port' 不可解析"]);
    }

    #[test]
    fn parse_empty_and_comment_only_files_yield_nothing() {
        let empty = parse_config("");
        assert!(empty.entries.is_empty());
        let comments = parse_config("# only comments\n\n   \n");
        assert_eq!(comments, ParseOutcome::default());
    }

    /// 导入流：新增计数 + 库内去重 + 文件内去重 + 错误行透传（Vault 实库验证）。
    #[test]
    fn import_into_vault_counts_and_dedups() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .unwrap();

        // 库内预置与夹具 web-01 同键（address+port+username）的主机 → 去重跳过
        Hosts::create(
            &vault,
            HostInput {
                protocol: Default::default(),
                name: "预置重复机".into(),
                group_id: None,
                tags: vec![],
                address: "192.168.1.10".into(),
                port: 2222,
                username: Some("deploy".into()),
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

        let report = import_entries(&vault, parse_config(&fixture())).unwrap();
        // 6 条目 − web-01（库内同键预置）− 192.168.1.20 与 web-01-copy
        //（同一 address+port+username 已由先前条目占用）= 新增 3
        assert_eq!(report.added, 3);
        assert_eq!(report.skipped_wildcards, 3);
        assert_eq!(report.skipped_duplicates, 3);
        assert_eq!(report.errors.len(), 1);

        let hosts = Hosts::list(&vault).unwrap();
        assert_eq!(hosts.len(), 4, "预置 1 + 新增 3");
        let web01 = hosts.iter().find(|h| h.name == "web-01");
        assert!(web01.is_none(), "库内同键主机已存在，不得再建同名条目");
        let bastion = hosts.iter().find(|h| h.name == "bastion").unwrap();
        assert_eq!(
            bastion.address, "bastion.example.com",
            "缺省 Hostname 回落 Host 别名"
        );
        assert_eq!(bastion.port, 22);
        assert_eq!(bastion.username, None);
        let spaced = hosts.iter().find(|h| h.name == "spaced-host").unwrap();
        assert_eq!(
            spaced.notes.as_deref(),
            Some("IdentityFile: /Users/ottr/My Keys/id_rsa")
        );
    }

    #[test]
    fn default_ssh_config_path_resolves_home() {
        // 不依赖具体机器：固定 HOME 应得到 ~/.ssh/config；空 HOME 则 None
        let saved = std::env::var("HOME").ok();
        // SAFETY：测试进程单线程改 HOME（edition 2024 起 set_var 为 unsafe）
        unsafe { std::env::set_var("HOME", "/home/ottr-test") };
        unsafe { std::env::remove_var("USERPROFILE") };
        assert_eq!(
            default_ssh_config_path(),
            Some(PathBuf::from("/home/ottr-test/.ssh/config"))
        );
        unsafe { std::env::set_var("HOME", "") };
        assert_eq!(default_ssh_config_path(), None);
        if let Some(home) = saved {
            unsafe { std::env::set_var("HOME", home) };
        }
    }
}
