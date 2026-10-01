//! Tabby 配置导入（Phase 2 Task 10，B3 迁移导入器）。
//!
//! 格式：Tabby 配置导出的 JSON——`{"profiles": [...]}` / 裸数组 / 单 profile
//! 对象三形态都收（用户手里的导出件裁剪层不一）。SSH profile 字段：
//! `name` / `type`（缺省按 ssh）/ `host` / `port` / `user`（`username` 同义）。
//! 解析规则（宁可少导不错导）：
//!   * `type` 存在且非 ssh → 跳过计数（serial/telnet 等非本域 profile）；
//!   * 缺 host → 跳过计数；port 非法 → 该条不导入并计入错误（带 profiles[i] 定位）；
//!   * 主机名 = name，缺则回落 host；port 缺省 22（导入层回落）；user 可空。
//!
//! 去重与落库复用 [`crate::ssh_config::import_entries`]（ImportReport 同构）。

use ottr_vault::Vault;
use serde_json::Value;

use crate::ssh_config::{import_entries, ImportReport, ParseOutcome, SshConfigEntry};

/// 解析 Tabby 配置文本 → [`ParseOutcome`]。非 JSON / 无 profiles 面 → Err。
pub fn parse_config(content: &str) -> Result<ParseOutcome, String> {
    let doc: Value = serde_json::from_str(content).map_err(|e| format!("not valid JSON: {e}"))?;
    let profiles = match &doc {
        Value::Array(a) => a.clone(),
        Value::Object(o) => match o.get("profiles") {
            Some(Value::Array(a)) => a.clone(),
            Some(v) if v.is_object() => vec![v.clone()],
            // 无 profiles 键但自带 host 面 → 单 profile 导出件
            None if o.contains_key("host") => vec![doc.clone()],
            _ => return Err("no profiles array found".into()),
        },
        _ => return Err("not a tabby config".into()),
    };

    let mut outcome = ParseOutcome::default();
    for (idx, profile) in profiles.iter().enumerate() {
        let Some(obj) = profile.as_object() else {
            outcome.skipped_wildcards += 1;
            continue;
        };
        let kind = obj
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("ssh")
            .to_ascii_lowercase();
        if kind != "ssh" {
            outcome.skipped_wildcards += 1;
            continue;
        }
        let host = obj
            .get("host")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|h| !h.is_empty());
        let Some(address) = host else {
            outcome.skipped_wildcards += 1;
            continue;
        };
        let port = match obj.get("port") {
            None | Some(Value::Null) => None,
            Some(v) => match v.as_u64() {
                Some(p) if p > 0 && p <= 65535 => Some(p as u16),
                _ => {
                    outcome
                        .errors
                        .push(format!("profiles[{idx}]: port 不可解析"));
                    continue;
                }
            },
        };
        let user = obj
            .get("user")
            .or_else(|| obj.get("username"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(String::from);
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(address);
        outcome.entries.push(SshConfigEntry {
            host: name.to_string(),
            hostname: Some(address.to_string()),
            port,
            user,
            identity_file: None,
        });
    }
    Ok(outcome)
}

/// 导入入口：path = 配置 JSON 文件。解析 → 复用 ssh_config 去重落库。
pub fn import_path(vault: &Vault, path: &std::path::Path) -> ottr_vault::Result<ImportReport> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        ottr_vault::VaultError::InvalidInput(format!("read {}: {e}", path.display()))
    })?;
    let outcome = parse_config(&content).map_err(ottr_vault::VaultError::InvalidInput)?;
    import_entries(vault, outcome)
}

// ---------------------------------------------------------------------------
// 解析 golden（fixtures/tabby/config.json 脱敏样例）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/tabby/config.json"
        ))
        .expect("read fixtures/tabby/config.json")
    }

    #[test]
    fn parse_golden_fixture() {
        let outcome = parse_config(&fixture()).unwrap();
        // 3 个可导入（web-01 全字段 / db 缺 port / cache 用 username 键）；
        // telnet profile 跳过；缺 host 的 profile 跳过；坏 port 计错误
        assert_eq!(outcome.entries.len(), 3);
        assert_eq!(outcome.skipped_wildcards, 2);
        assert_eq!(outcome.errors, vec!["profiles[5]: port 不可解析"]);

        let web = &outcome.entries[0];
        assert_eq!(web.host, "web-01");
        assert_eq!(web.hostname.as_deref(), Some("192.168.1.10"));
        assert_eq!(web.port, Some(2222));
        assert_eq!(web.user.as_deref(), Some("deploy"));

        let db = &outcome.entries[1];
        assert_eq!(db.host, "db-master");
        assert_eq!(db.hostname.as_deref(), Some("10.0.0.5"));
        assert_eq!(db.port, None);

        let cache = &outcome.entries[2];
        assert_eq!(cache.host, "cache-01");
        assert_eq!(cache.user.as_deref(), Some("ops"));
    }

    #[test]
    fn bare_array_and_single_object_shapes() {
        let one = r#"{"name":"solo","host":"10.9.9.9","port":2200}"#;
        assert_eq!(parse_config(&format!("[{one}]")).unwrap().entries.len(), 1);
        let single = parse_config(one).unwrap();
        assert_eq!(single.entries.len(), 1);
        assert_eq!(single.entries[0].host, "solo");
    }

    #[test]
    fn bad_shapes_are_errors() {
        assert!(parse_config("not json")
            .unwrap_err()
            .contains("not valid JSON"));
        assert!(parse_config(r#"{"settings":{}}"#)
            .unwrap_err()
            .contains("no profiles"));
        assert!(parse_config("42")
            .unwrap_err()
            .contains("not a tabby config"));
    }

    #[test]
    fn import_into_vault_dedups_by_address_port_user() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            tmp.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .unwrap();
        let report = import_path(
            &vault,
            std::path::Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../fixtures/tabby/config.json"
            )),
        )
        .unwrap();
        assert_eq!(report.added, 3);
        assert_eq!(report.skipped_wildcards, 2);
        assert_eq!(report.errors.len(), 1);
        // 重跑幂等：全部按 address+port+user 去重
        let rerun = import_path(
            &vault,
            std::path::Path::new(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../fixtures/tabby/config.json"
            )),
        )
        .unwrap();
        assert_eq!(rerun.added, 0);
        assert_eq!(rerun.skipped_duplicates, 3);
    }
}
