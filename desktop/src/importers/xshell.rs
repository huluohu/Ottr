//! Xshell .xsh 会话目录导入（Phase 2 Task 10，B3 迁移导入器）。
//!
//! 格式：.xsh = ini 变体——`[Section]` 头 + `Key=Value` 行；与本导入相关的键
//! （大小写不敏感、跨 section 全局扫描，首见生效）：
//!   Host / Port / UserName(=User) / Description / Protocol。
//! 解析规则（宁可少导不错导）：
//!   * Protocol 存在且非 SSH 系（SSH/SSH1/SSH2）→ 非终端会话（telnet/serial），
//!     跳过计数（不算错误——文件本身有效）；
//!   * 缺 Host → 跳过计数（无法成主机条目）；
//!   * Port 非法 → 整文件不导入，计入解析错误（带文件名）；
//!   * 主机名取 Description（用户可见名），缺则回落文件名去扩展名；
//!     address = Host；port 缺省 22（导入层回落）；user 可空。
//!
//! 编码：Xshell 各版本导出不齐——read_text 按 BOM 嗅探（UTF-16LE/UTF-8 BOM），
//! 无 BOM 按 UTF-8 lossy。
//!
//! 去重与落库复用 [`crate::ssh_config::import_entries`]（address+port+username
//! 去重、ImportReport 同构——前端报告对话框零特判复用）。

use std::path::{Path, PathBuf};

use ottr_vault::Vault;

use crate::ssh_config::{ImportReport, ParseOutcome, SshConfigEntry, import_entries};

/// 单文件解析结论（三态：可导入 / 有效但不可导入 / 损坏）。
#[derive(Debug, Clone, PartialEq)]
pub enum XshParse {
    Entry(SshConfigEntry),
    /// 有效 .xsh 但无可导入内容（非 SSH 协议 / 缺 Host）。
    Skipped(&'static str),
    /// 结构损坏（如 Port 非法）——整文件不导入。
    Error(String),
}

/// BOM 嗅探读文本（Xshell 老版本 .xsh 是 UTF-16LE）。
fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok(String::from_utf16_lossy(
            &bytes[2..]
                .chunks(2)
                .map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)]))
                .collect::<Vec<_>>(),
        ));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok(String::from_utf16_lossy(
            &bytes[2..]
                .chunks(2)
                .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
                .collect::<Vec<_>>(),
        ));
    }
    let s = String::from_utf8_lossy(&bytes);
    Ok(s.strip_prefix('\u{feff}')
        .map(Into::into)
        .unwrap_or_else(|| s.into()))
}

/// 解析 .xsh 文本。`fallback_name` = 文件名去扩展名（Description 缺席时的主机名）。
pub fn parse_xsh(content: &str, fallback_name: &str) -> XshParse {
    let mut host: Option<String> = None;
    let mut port: Option<String> = None;
    let mut user: Option<String> = None;
    let mut description: Option<String> = None;
    let mut protocol: Option<String> = None;

    for raw in content.lines() {
        let line = raw.trim();
        // ini 注释（; 与 #）与 section 头跳过
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        let val = v.trim().trim_matches('"').trim().to_string();
        if val.is_empty() {
            continue;
        }
        // 首见生效（同键多 section 时以最前的为准——Xshell 模板文件的常见形态）
        match key.as_str() {
            "host" if host.is_none() => host = Some(val),
            "port" if port.is_none() => port = Some(val),
            "username" | "user" if user.is_none() => user = Some(val),
            "description" if description.is_none() => description = Some(val),
            "protocol" if protocol.is_none() => protocol = Some(val.to_ascii_uppercase()),
            _ => {}
        }
    }

    if let Some(p) = &protocol
        && !matches!(p.as_str(), "SSH" | "SSH1" | "SSH2" | "SSHTUNNEL")
    {
        return XshParse::Skipped("non-ssh session");
    }
    let Some(address) = host else {
        return XshParse::Skipped("no Host= entry");
    };
    let port = match port.as_deref() {
        None => None,
        Some(s) => match s.parse::<u16>() {
            Ok(p) if p > 0 => Some(p),
            _ => return XshParse::Error(format!("Port '{s}' 不可解析")),
        },
    };
    let name = description
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    XshParse::Entry(SshConfigEntry {
        host: name,
        hostname: Some(address),
        port,
        user,
        identity_file: None,
    })
}

/// 目录解析：只看 *.xsh（大小写不敏感，文件名排序保证报告稳定）；
/// 其余文件静默忽略（不是会话文件，不算「跳过」）。
pub fn parse_dir(dir: &Path) -> ParseOutcome {
    let mut outcome = ParseOutcome::default();
    let Ok(read) = std::fs::read_dir(dir) else {
        outcome
            .errors
            .push(format!("read dir {}: 无法读取", dir.display()));
        return outcome;
    };
    let mut files: Vec<PathBuf> = read
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase() == "xsh")
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    for path in files {
        push_file(&mut outcome, &path);
    }
    outcome
}

/// 单文件解析并入 outcome（目录与单文件路径共用）。
fn push_file(outcome: &mut ParseOutcome, path: &Path) {
    let display = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let fallback_name = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| display.clone());
    let content = match read_text(path) {
        Ok(c) => c,
        Err(e) => {
            outcome.errors.push(format!("{display}: read: {e}"));
            return;
        }
    };
    match parse_xsh(&content, &fallback_name) {
        XshParse::Entry(entry) => outcome.entries.push(entry),
        XshParse::Skipped(_) => outcome.skipped_wildcards += 1,
        XshParse::Error(err) => outcome.errors.push(format!("{display}: {err}")),
    }
}

/// 导入入口：path = 会话目录或单个 .xsh 文件。解析 → 复用 ssh_config 去重落库。
pub fn import_path(vault: &Vault, path: &Path) -> ottr_vault::Result<ImportReport> {
    let outcome = if path.is_dir() {
        parse_dir(path)
    } else {
        let mut outcome = ParseOutcome::default();
        push_file(&mut outcome, path);
        outcome
    };
    import_entries(vault, outcome)
}

/// Xshell 默认会话目录（Windows 惯例位置；不存在/非 Windows → None，必须显式传路径）。
pub fn default_sessions_dir() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(appdata)
        .join("NetSarang Computer")
        .join("7")
        .join("Xshell")
        .join("Sessions");
    if dir.is_dir() { Some(dir) } else { None }
}

// ---------------------------------------------------------------------------
// 解析 golden（fixtures/xshell 脱敏样例：完整键面 / 极简 / 非 SSH / 坏端口）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!("{}/../fixtures/xshell/{name}", env!("CARGO_MANIFEST_DIR"));
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn parse_golden_full_shape() {
        // 完整键面：Description 作主机名、Port 显式、UserName 在 [SSH\Connection]
        match parse_xsh(&fixture("web01.xsh"), "web01") {
            XshParse::Entry(e) => {
                assert_eq!(e.host, "Web Server 01");
                assert_eq!(e.hostname.as_deref(), Some("192.168.1.10"));
                assert_eq!(e.port, Some(2222));
                assert_eq!(e.user.as_deref(), Some("deploy"));
                assert_eq!(e.identity_file, None);
            }
            other => panic!("expected entry, got {other:?}"),
        }
    }

    #[test]
    fn parse_minimal_defaults_to_file_stem() {
        // 极简（仅 Host）：名字回落文件名、port 缺省（导入层回落 22）
        match parse_xsh(&fixture("dbmaster.xsh"), "dbmaster") {
            XshParse::Entry(e) => {
                assert_eq!(e.host, "dbmaster");
                assert_eq!(e.hostname.as_deref(), Some("10.0.0.5"));
                assert_eq!(e.port, None);
                assert_eq!(e.user, None);
            }
            other => panic!("expected entry, got {other:?}"),
        }
    }

    #[test]
    fn non_ssh_protocol_is_skipped_not_error() {
        assert!(matches!(
            parse_xsh(&fixture("telnet.xsh"), "telnet-box"),
            XshParse::Skipped("non-ssh session")
        ));
    }

    #[test]
    fn bad_port_is_error() {
        match parse_xsh(&fixture("badport.xsh"), "badport") {
            XshParse::Error(msg) => assert!(msg.contains("Port 'not-a-port'")),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn utf16le_bom_file_decodes() {
        // 真 BOM 文件走 read_text：UTF-16LE 会话文件（Xshell 老版本导出形态）
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.xsh");
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for unit in "Host=10.1.1.1\r\nPort=2200\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&path, &bytes).unwrap();
        let outcome = import_into_tmp(&path);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0].host, "legacy");
        assert_eq!(outcome.entries[0].hostname.as_deref(), Some("10.1.1.1"));
        assert_eq!(outcome.entries[0].port, Some(2200));
    }

    /// read_text 的独立验证入口（import_path 单文件路径，不触库）。
    fn import_into_tmp(path: &Path) -> ParseOutcome {
        let mut outcome = ParseOutcome::default();
        push_file(&mut outcome, path);
        outcome
    }

    #[test]
    fn parse_dir_golden_and_import_counts() {
        let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/xshell"));
        let outcome = parse_dir(dir);
        // web01 + dbmaster 可导入；telnet 跳过；badport 报错
        assert_eq!(outcome.entries.len(), 2);
        assert_eq!(outcome.skipped_wildcards, 1);
        assert_eq!(outcome.errors.len(), 1);
        assert!(outcome.errors[0].starts_with("badport.xsh:"));

        // 导入流（Vault 实库）：新增 2 + 去重语义复用 ssh_config（同键再导全跳）
        let tmp = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            tmp.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .unwrap();
        let report = import_path(&vault, dir).unwrap();
        assert_eq!(report.added, 2);
        assert_eq!(report.skipped_wildcards, 1);
        assert_eq!(report.skipped_duplicates, 0);
        assert_eq!(report.errors.len(), 1);
        // 重跑同一目录：全部去重（幂等续导语义与 ssh_config 一致）
        let rerun = import_path(&vault, dir).unwrap();
        assert_eq!(rerun.added, 0);
        assert_eq!(rerun.skipped_duplicates, 2);

        let hosts = ottr_vault::Hosts::list(&vault).unwrap();
        let web = hosts.iter().find(|h| h.name == "Web Server 01").unwrap();
        assert_eq!(web.address, "192.168.1.10");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username.as_deref(), Some("deploy"));
    }

    #[test]
    fn single_file_and_default_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            tmp.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .unwrap();
        let file = Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/xshell/dbmaster.xsh"
        ));
        let report = import_path(&vault, file).unwrap();
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped_wildcards, 0);

        // default_sessions_dir：APPDATA 指向不存在的结构 → None；存在且是目录 → Some
        let saved = std::env::var("APPDATA").ok();
        let fake = tempfile::tempdir().unwrap();
        let sessions = fake.path().join("NetSarang Computer/7/Xshell/Sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        // SAFETY：测试进程单线程改 APPDATA（edition 2024 起 set_var 为 unsafe）
        unsafe { std::env::set_var("APPDATA", fake.path()) };
        assert_eq!(default_sessions_dir(), Some(sessions));
        unsafe { std::env::set_var("APPDATA", "") };
        assert_eq!(default_sessions_dir(), None);
        if let Some(v) = saved {
            unsafe { std::env::set_var("APPDATA", v) };
        }
    }
}
