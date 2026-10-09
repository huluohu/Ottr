//! 前后端命令名契约守护（2026-10-08 结构收敛批次）：前端 `invoke("<name>")`
//! 的每一个命令名都必须在 lib.rs 的 `generate_handler![...]` 注册表里。
//!
//! 背景：TS 侧命令名与 Rust 命令 fn 是手工镜像（frontend/vault/api.ts 文件头契约），
//! 漂移目前只能靠前端单测的 mock 命中兜底。本测试从**两侧真源**（lib.rs 注册
//! 文本 + frontend/ 全部 invoke 字面量）做集合校验——前端调到未注册的命令名 = 运行
//! 时 invoke 必败，直接红灯到具体名字，不再等人工排查。
//!
//! 口径：
//! * 注册名 = generate_handler 块内每个路径的**最后一段**（`vault::hosts_list`
//!   → `hosts_list`）；`#[tauri::command]` 宏默认以 fn 名注册，无 rename 例外。
//! * 前端名 = `invoke(` / `invoke<T>((` 后的第一个字符串字面量（单/双/反引号）。
//!   全仓无动态拼接命令名（模板串调用为零），字面量口径无漏网。
//! * 只做单向断言（前端 → 注册表）。反向（注册了但前端未调）不判红：驱动
//!   脚本/菜单/托盘等非 webview 消费面合法存在。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// lib.rs 注册表：generate_handler![...] 块内所有路径的最后一段。
fn registered_commands() -> BTreeSet<String> {
    let lib = std::fs::read_to_string(repo_root().join("desktop/src/lib.rs"))
        .expect("read desktop/src/lib.rs");
    let start = lib
        .find("generate_handler!")
        .unwrap_or_else(|| panic!("lib.rs 未找到 generate_handler! 注册表"));
    let open = lib[start..].find('[').unwrap() + start;
    // 方括号配平（注册表内无字符串字面量，裸计数安全）
    let mut depth = 0usize;
    let mut end = open;
    for (i, ch) in lib[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = open + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body: String = lib[open + 1..end]
        .lines()
        .map(|l| l.split("//").next().unwrap()) // 去行注释
        .collect::<Vec<_>>()
        .join("\n");
    body.split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.split("::").last().unwrap().trim().to_string())
        .collect()
}

/// 前端 frontend/**/*.{ts,tsx} 里全部 invoke 字面量命令名。
fn invoked_commands() -> BTreeSet<(String, PathBuf)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read frontend/") {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("ts") | Some("tsx")
            ) {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&repo_root().join("frontend"), &mut files);

    let mut found = BTreeSet::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read frontend file");
        let bytes = text.as_bytes();
        let mut i = 0;
        while let Some(pos) = text[i..].find("invoke") {
            let at = i + pos;
            i = at + 6;
            // 跳过泛型参数 <...>（跨行安全：找配对的 '>'，遇到 '(' 先于 '>' 则无泛型）
            let mut j = at + 6;
            let rest = &text[j..];
            if let Some(stripped) = rest.strip_prefix('<') {
                let mut depth = 1;
                for (k, ch) in stripped.char_indices() {
                    match ch {
                        '<' => depth += 1,
                        '>' => {
                            depth -= 1;
                            if depth == 0 {
                                j = j + 1 + k + 1;
                                break;
                            }
                        }
                        ';' => break, // 泛型列表意外终止（非 invoke 泛型，放弃本处）
                        _ => {}
                    }
                }
            }
            // 吃掉空白后必须是 '('
            let after = &text[j..];
            let Some(paren_off) = after.find('(') else {
                continue;
            };
            if !after[..paren_off].trim().is_empty() {
                continue; // invoke 与 ( 之间有其他 token（如 .catch）——非调用点
            }
            let mut k = j + paren_off + 1;
            // 跳过空白/换行到第一个引号（三种引号都接受；非引号 = 变量实参，
            // 全仓当前为零，出现时人工确认口径）
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if !matches!(bytes.get(k), Some(b'"') | Some(b'\'') | Some(b'`')) {
                continue;
            }
            let rest = &text[k + 1..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
                .collect();
            if name.is_empty() {
                continue;
            }
            found.insert((name, file.clone()));
        }
    }
    found
}

#[test]
fn every_frontend_invoke_targets_a_registered_command() {
    let registered = registered_commands();
    assert!(
        registered.len() >= 100,
        "注册表解析异常（命令数 {}<100），口径失守先修解析",
        registered.len()
    );

    let invoked = invoked_commands();
    let names: BTreeSet<String> = invoked.iter().map(|(n, _)| n.clone()).collect();
    assert!(
        names.len() >= 100,
        "前端 invoke 解析异常（唯一命令名 {}<100），口径失守先修解析",
        names.len()
    );

    let unknown: Vec<(String, PathBuf)> = invoked
        .iter()
        .filter(|(n, _)| !registered.contains(n))
        .cloned()
        .collect();
    assert!(
        unknown.is_empty(),
        "前端 invoke 了未注册的命令名（运行时必败）：\n{}",
        unknown
            .iter()
            .map(|(n, f)| format!("  {n}  <- {}", f.display()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// 注册名集合快照（防误删）：仅锚定抽样代表，全量对比交给前端 api.test.ts。
#[test]
fn registration_snapshot_keeps_domain_anchors() {
    let registered = registered_commands();
    for anchor in [
        "attach_host_session", // session
        "hosts_search",        // vault hosts
        "sftp_list",           // transfer（改名即红，提醒同步 api.ts）
        "mcp_status",          // mcp
        "cj_list",             // cron
        "monitor_start",       // monitor
    ] {
        assert!(registered.contains(anchor), "注册表缺锚点命令 {anchor}");
    }
}
