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

use ottr_vault::{HostProtocol, Vault};

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

/// 导入问题（2026-11-01 功能审计 P2-5）：此前 errors 是写死的中文字符串，
/// 前端原样渲染 → 八语界面里导入报错仍然是中文。改为**稳定错误码 + 参数表**：
/// 前端按码本地化（未知码退化为原样展示，不丢信息）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
pub struct ImportIssue {
    /// 稳定错误码（前端 i18n 映射键；如 `csv.header_mismatch`）。
    pub code: String,
    /// 参数表（行号/实际值等）→ 前端按码插值。
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, String>,
}

impl ImportIssue {
    /// 无参问题。
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            params: std::collections::BTreeMap::new(),
        }
    }

    /// 带参问题（参数值按字符串存；数字在前端插值时自行格式化）。
    pub fn with(code: &str, params: &[(&str, String)]) -> Self {
        let mut map = std::collections::BTreeMap::new();
        for (k, v) in params {
            map.insert((*k).to_string(), v.clone());
        }
        Self {
            code: code.to_string(),
            params: map,
        }
    }
}

/// 一次性解析结果：条目 + 通配跳过数 + 错误列表（结构化问题）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseOutcome {
    pub entries: Vec<SshConfigEntry>,
    pub skipped_wildcards: usize,
    pub errors: Vec<ImportIssue>,
}

/// 导入报告（裁定 #4：新增 N、跳过 N、解析错误行列表，导入完成对话框展示）。
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ImportReport {
    pub added: usize,
    pub skipped_wildcards: usize,
    pub skipped_duplicates: usize,
    pub errors: Vec<ImportIssue>,
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
    let mut block_error: Option<ImportIssue> = None;

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
                    block_error = Some(ImportIssue::with(
                        "sshconfig.port_not_parseable",
                        &[
                            ("line", (idx + 1).to_string()),
                            ("value", value.to_string()),
                        ],
                    ));
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
    block_error: &mut Option<ImportIssue>,
    outcome: &mut ParseOutcome,
) {
    if let Some(err) = block_error.take() {
        outcome.errors.push(err);
    } else {
        outcome.entries.append(pending);
    }
    pending.clear();
}

/// 秒级 unix 时间（落库 created_at/updated_at；entities.rs `now_ts` 镜像）。
pub(crate) fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// 控制字符拒绝（ottr-vault `reject_control_chars` 镜像，2026-11-01 P1-2）：
/// name/address/username 逐字进 OpenSSH config 导出——换行即等于注入任意
/// ssh_config 指令（恶意主机清单经导入落库后持久化执行）。
fn reject_control_chars(field: &str, value: &str) -> Result<(), String> {
    if let Some(c) = value.chars().find(|c| c.is_control()) {
        return Err(format!(
            "{field} must not contain control characters (found U+{:04X})",
            c as u32
        ));
    }
    Ok(())
}

/// 主机行校验（ottr-vault `Hosts::validate` 镜像：name/address 非空、端口
/// 1-65535、控制字符）。vault 校验器私有不出 crate，事务化导入在 desktop 侧
/// 执行同一规则——ssh_config / hosts_csv 两个导入器共用。
pub(crate) fn validate_host_row(
    name: &str,
    address: &str,
    port: i64,
    username: Option<&str>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("host name must not be empty".into());
    }
    if address.trim().is_empty() {
        return Err("host address must not be empty".into());
    }
    if !(1..=65535).contains(&port) {
        return Err(format!("port {port} out of range 1-65535"));
    }
    reject_control_chars("host name", name)?;
    reject_control_chars("host address", address)?;
    if let Some(user) = username {
        reject_control_chars("host username", user)?;
    }
    Ok(())
}

/// 分组名校验（ottr-vault `HostGroups::validate` 镜像：非空 + 控制字符——
/// 分组名进导出的注释行）。
pub(crate) fn validate_group_row(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("group name must not be empty".into());
    }
    reject_control_chars("group name", name)
}

/// hosts 表 INSERT（列清单/参数序与 ottr-vault entities.rs `Hosts::create`
/// 逐字对齐——vault 的校验器与 INSERT 不出 crate（依赖纪律：desktop 不引
/// rusqlite），事务化导入在 desktop 侧执行同一语句；**改列必两处同改**）。
pub(crate) const HOST_INSERT_SQL: &str =
    "INSERT INTO hosts (name, group_id, tags, address, port, username, protocol,
                            credential_id, jump_chain_id, encoding_override, theme_override,
                            monitor_enabled, is_production, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)";

/// 把解析条目导入 vault（去重 + 落库）。错误行原样透传进报告。
///
/// 去重键 = (address, port, username)：先取库内全量主机建索引，再边导边查
/// （同键的文件内重复一并去重）。
///
/// **全程单事务**（robustness 审计 P2：此前逐条 create 各自独立事务，中途
/// 失败留半截 + ImportReport 丢失）：`with_conn` + `unchecked_transaction`
/// 形态（先例 ottr-vault sync_snapshot），单行失败记入 report.errors 并
/// continue，最后统一提交。行为兼容：成功行照常入库，失败行在报告里可见。
pub fn import_entries(vault: &Vault, outcome: ParseOutcome) -> ottr_vault::Result<ImportReport> {
    vault.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let ts = now_ts();
        let mut seen: HashSet<(String, i64, Option<String>)> = {
            let mut stmt = tx.prepare("SELECT address, port, username FROM hosts")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<Result<HashSet<_>, _>>()?
        };
        let mut report = ImportReport {
            added: 0,
            skipped_wildcards: outcome.skipped_wildcards,
            skipped_duplicates: 0,
            errors: outcome.errors,
        };
        for entry in outcome.entries {
            let SshConfigEntry {
                host: name,
                hostname,
                port: port_opt,
                user,
                identity_file,
            } = entry;
            let address = hostname.unwrap_or_else(|| name.clone());
            let port = i64::from(port_opt.unwrap_or(22));
            let notes = identity_file.map(|f| format!("IdentityFile: {f}"));
            let key = (address.clone(), port, user.clone());
            if seen.contains(&key) {
                report.skipped_duplicates += 1;
                continue;
            }
            if let Err(reason) = validate_host_row(&name, &address, port, user.as_deref()) {
                report.errors.push(ImportIssue::with(
                    "sshconfig.row_invalid",
                    &[("name", name.clone()), ("reason", reason)],
                ));
                continue;
            }
            // 参数 15 元组：?15 占位符出现两次（created_at/updated_at 同 ts），
            // 只绑一个值——entities.rs Hosts::create 的 params! 同款计数。
            let inserted = tx.execute(
                HOST_INSERT_SQL,
                (
                    name.as_str(),
                    Option::<i64>::None,
                    "[]",
                    address.as_str(),
                    port,
                    user.as_deref(),
                    HostProtocol::Ssh.as_str(),
                    Option::<i64>::None,
                    Option::<i64>::None,
                    Option::<String>::None,
                    Option::<String>::None,
                    false,
                    false,
                    notes.as_deref(),
                    ts,
                ),
            );
            if let Err(e) = inserted {
                report.errors.push(ImportIssue::with(
                    "sshconfig.row_invalid",
                    &[("name", name), ("reason", e.to_string())],
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

// ---------------------------------------------------------------------------
// 解析 golden（裁定 #1：fixtures/ssh_config 样例含通配、多主机、缺省字段）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    // 测试面直驱 vault 实体（事务化导入绕开 Hosts::create 的独立事务面）
    use ottr_vault::{HostInput, Hosts};

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
        assert_eq!(outcome.errors.len(), 1);
        assert_eq!(outcome.errors[0].code, "sshconfig.port_not_parseable");
        assert_eq!(
            outcome.errors[0].params.get("line").map(String::as_str),
            Some("29")
        );
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
