//! Task 5 双设备端到端（Phase 5）——「第二台设备」桥夹具（example 驱动模式，
//! encoding_fixture 同款：`cargo build -p ottr --example sync_bridge_fixture`
//! 后由 `src/sync/e2e.dualdevice.test.ts` spawn，两实例 = 两台设备）。
//!
//! 每实例驱动**一台真 vault**：独立数据目录（argv[1]，`Vault::open_with` 自建）
//! + 独立 Master Key（InMemoryStorage，打开即解锁——测试纪律：绝不触真钥匙链）。
//! 命令面与 src-tauri vault.rs 同步相关命令**同款函数直调**：ottr-vault
//! `sync_snapshot::{export_categories, import_categories}`、
//! `Settings::{get, set}` + `validate_known_setting`（settings_set 命令体的
//! 薄委托链，T3 fix I-1 单一事实源）——生产 Tauri 命令体即这些函数的薄包装。
//!
//! 协议（stdio JSON 线）：stdin 每行一个请求
//! `{"id":N,"method":"...","params":{...}}`，stdout 回一行
//! `{"id":N,"ok":true,"result":...}` 或 `{"id":N,"ok":false,"error":"..."}`。
//! 启动失败（目录不可建 / 库打不开）→ stderr 说明 + exit 1。
//!
//! 方法面（params 均为对象）：
//! * `ping` → `"pong"`（就绪探针）；
//! * `host_create` `{name,address,port,group?,username?,notes?}` → Host JSON
//!   （group 给了就先建顶层分组，返回的 Host 与之绑定）；
//! * `host_update` `{name,port?,notes?}` → Host JSON（按 name 定位，其余字段
//!   原样保留——Hosts::update 是全量输入，从现值重建）；
//! * `host_list` `{}` → `[Host]`；
//! * `export_categories` `{cats:[...]}` → 快照 JSON；
//! * `import_categories` `{cats:[...],data,mode}` → SyncImportReport；
//! * `settings_get` `{key}` → Value | null；
//! * `settings_set` `{key,value}` → null。

use std::io::{BufRead, Write};

use ottr_vault::entities::HostInput;
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::settings::validate_known_setting;
use ottr_vault::{HostGroups, Hosts, Settings, SyncImportMode, Vault};
use serde_json::{json, Value};

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| usage_exit());
    let vault = Vault::open_with(std::path::Path::new(&dir), &InMemoryStorage::new())
        .unwrap_or_else(|e| {
            eprintln!("sync_bridge_fixture: open vault at {dir}: {e}");
            std::process::exit(1);
        });
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("sync_bridge_fixture: read stdin: {e}");
                std::process::exit(1);
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                match dispatch(
                    &vault,
                    req.get("method").and_then(Value::as_str),
                    req.get("params"),
                ) {
                    Ok(result) => json!({"id": id, "ok": true, "result": result}),
                    Err(err) => json!({"id": id, "ok": false, "error": err}),
                }
            }
            Err(e) => json!({"id": null, "ok": false, "error": format!("bad request line: {e}")}),
        };
        if let Err(e) = writeln!(out, "{response}").and_then(|_| out.flush()) {
            eprintln!("sync_bridge_fixture: write stdout: {e}");
            std::process::exit(1);
        }
    }
}

fn usage_exit() -> ! {
    eprintln!("usage: sync_bridge_fixture <vault-data-dir>");
    std::process::exit(2);
}

/// 单请求分发。参数缺失 / 类型错 → Err 文本（测试侧 fail-loud）。
fn dispatch(vault: &Vault, method: Option<&str>, params: Option<&Value>) -> Result<Value, String> {
    let params = params
        .and_then(Value::as_object)
        .ok_or_else(|| "params must be an object".to_string())?;
    let p = Value::Object(params.clone());
    match method {
        Some("ping") => Ok(json!("pong")),

        Some("host_create") => {
            let name = str_field(&p, "name")?;
            let group = match opt_str_field(&p, "group")? {
                Some(g) => Some(HostGroups::create(vault, &g, None, None).map_err(e)?),
                None => None,
            };
            let host = Hosts::create(
                vault,
                HostInput {
                    name,
                    group_id: group.map(|g| g.id),
                    tags: vec![],
                    address: str_field(&p, "address")?,
                    port: p.get("port").and_then(Value::as_i64).unwrap_or(22),
                    username: opt_str_field(&p, "username")?,
                    protocol: Default::default(),
                    credential_id: None,
                    jump_chain_id: None,
                    encoding_override: None,
                    theme_override: None,
                    monitor_enabled: false,
                    is_production: false,
                    notes: opt_str_field(&p, "notes")?,
                },
            )
            .map_err(e)?;
            serde_json::to_value(host).map_err(je)
        }

        Some("host_update") => {
            let name = str_field(&p, "name")?;
            let existing = Hosts::list(vault)
                .map_err(e)?
                .into_iter()
                .find(|h| h.name == name)
                .ok_or_else(|| format!("no host named {name:?}"))?;
            let host = Hosts::update(
                vault,
                existing.id,
                HostInput {
                    port: p
                        .get("port")
                        .and_then(Value::as_i64)
                        .unwrap_or(existing.port),
                    notes: match p.get("notes") {
                        Some(Value::Null) => None,
                        Some(v) => Some(v.as_str().ok_or("notes must be a string")?.to_string()),
                        None => existing.notes.clone(),
                    },
                    ..rebuild_input(&existing)
                },
            )
            .map_err(e)?;
            serde_json::to_value(host).map_err(je)
        }

        Some("host_list") => serde_json::to_value(Hosts::list(vault).map_err(e)?).map_err(je),

        Some("export_categories") => {
            let cats = cats_field(&p)?;
            ottr_vault::sync_snapshot::export_categories(vault, &cats).map_err(e)
        }

        Some("import_categories") => {
            let cats = cats_field(&p)?;
            let data = p.get("data").cloned().ok_or("params.data required")?;
            let mode = match p.get("mode").and_then(Value::as_str) {
                Some("replace") | None => SyncImportMode::Replace,
                Some(other) => return Err(format!("unknown sync import mode: {other}")),
            };
            let report = ottr_vault::sync_snapshot::import_categories(vault, &cats, &data, mode)
                .map_err(e)?;
            serde_json::to_value(report).map_err(je)
        }

        Some("settings_get") => {
            let key = str_field(&p, "key")?;
            Ok(Settings::get(vault, &key)
                .map_err(e)?
                .unwrap_or(Value::Null))
        }

        Some("settings_set") => {
            let key = str_field(&p, "key")?;
            let value = p.get("value").cloned().unwrap_or(Value::Null);
            // settings_set 命令体同款：先 validate（未注册键放行）再落库。
            validate_known_setting(&key, &value)?;
            Settings::set(vault, &key, &value).map_err(e)?;
            Ok(Value::Null)
        }

        other => Err(format!(
            "unknown method {other:?}（合法面：ping/host_create/host_update/host_list/\
             export_categories/import_categories/settings_get/settings_set）"
        )),
    }
}

fn rebuild_input(h: &ottr_vault::Host) -> HostInput {
    HostInput {
        name: h.name.clone(),
        group_id: h.group_id,
        tags: h.tags.clone(),
        address: h.address.clone(),
        port: h.port,
        username: h.username.clone(),
        protocol: h.protocol,
        credential_id: h.credential_id,
        jump_chain_id: h.jump_chain_id,
        encoding_override: h.encoding_override.clone(),
        theme_override: h.theme_override.clone(),
        monitor_enabled: h.monitor_enabled,
        is_production: h.is_production,
        notes: h.notes.clone(),
    }
}

fn je(err: serde_json::Error) -> String {
    err.to_string()
}

fn e(err: ottr_vault::VaultError) -> String {
    err.to_string()
}

fn str_field(p: &Value, key: &str) -> Result<String, String> {
    p.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("params.{key} must be a string"))
}

fn opt_str_field(p: &Value, key: &str) -> Result<Option<String>, String> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(format!("params.{key} must be a string, got {other}")),
    }
}

fn cats_field(p: &Value) -> Result<Vec<String>, String> {
    p.get("cats")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or("cats items must be strings")
                })
                .collect::<Result<Vec<String>, _>>()
        })
        .transpose()?
        .ok_or_else(|| "params.cats must be an array".to_string())
}
