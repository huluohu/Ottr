//! AI 作用域命令名契约守护（Ask Ottr 执行模式 · 第一步 Plan 档 / 第二步
//! Manual 档）。
//!
//! 两步新增的命令必须落在 lib.rs 的 `generate_handler![...]` 注册表里：
//! * `ai_scope_list_dir` —— 只读：列目录（SFTP / 本机 FS 面）；
//! * `ai_scope_read_file` —— 只读：读文件（SFTP / 本机 FS 面）；
//! * `ai_scope_exec` —— 执行类：按模式分派（plan/manual 只登记计划步骤、
//!   auto 拒）；
//! * `ai_scope_run_step` —— 执行类：**真执行**一个已登记的计划步骤
//!   （第二步 Manual 档；独立 exec 通道 + 消费侧硬超时）；
//! * `ai_scope_upgrade_step` —— 执行类：**档位升级**（把 plan 档登记的步骤
//!   以 manual 档新登记一条；命令原文只从该作用域的登记簿里取——2026-11-04
//!   修补 I-1）。
//!
//! 前端 `invoke("<name>")` 调到未注册的命令名 = 运行时必败。本测试从
//! **注册表真源**（desktop/src/lib.rs 的注册块文本）取名做断言——口径与
//! tests/command_contract.rs 同款（注册名 = 注册路径的最后一段；注册块内
//! 无字符串字面量，方括号配平可裸计数）。
//!
//! 前端 → 注册表的全量集合比对由 tests/command_contract.rs 负责（它扫
//! frontend/** 的 invoke 字面量）；本测试只钉住"新增命令名在册"，避免前端
//! 与后端并行开发时把命令名写歪却无人拦。

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// lib.rs 注册表：generate_handler 块内所有路径的最后一段。
fn registered_commands() -> Vec<String> {
    let lib = std::fs::read_to_string(repo_root().join("desktop/src/lib.rs"))
        .expect("read desktop/src/lib.rs");
    let start = lib
        .find("generate_handler!")
        .unwrap_or_else(|| panic!("lib.rs 未找到 generate_handler! 注册表"));
    let open = lib[start..].find('[').unwrap() + start;
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
        .map(|l| l.split("//").next().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    body.split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.split("::").last().unwrap().trim().to_string())
        .collect()
}

#[test]
fn ask_ottr_execution_mode_commands_are_registered() {
    let registered = registered_commands();
    for command in [
        "ai_scope_list_dir",
        "ai_scope_read_file",
        "ai_scope_exec",
        "ai_scope_run_step",
        "ai_scope_upgrade_step",
    ] {
        assert!(
            registered.iter().any(|c| c == command),
            "unregistered command: {command}"
        );
    }
}

/// 第三步（自动档）的**主机授权面**命令必须在册：
/// 前端设置页与面板都靠它们读写授权（`ai_policy_get/set/list/delete`）。
/// 漏注册 = 设置页写不进去、面板判不出「未授权」。
#[test]
fn auto_mode_policy_commands_are_registered() {
    let registered = registered_commands();
    for command in [
        "ai_policy_get",
        "ai_policy_set",
        "ai_policy_list",
        "ai_policy_delete",
    ] {
        assert!(
            registered.iter().any(|c| c == command),
            "unregistered command: {command}"
        );
    }
}

/// 既有四个作用域命令不得被本步改名/摘除（回归锚点）。
#[test]
fn existing_ai_scope_commands_stay_registered() {
    let registered = registered_commands();
    for command in [
        "ai_scope_open",
        "ai_scope_context",
        "ai_scope_insert",
        "ai_scope_revoke",
    ] {
        assert!(
            registered.iter().any(|c| c == command),
            "unregistered command: {command}"
        );
    }
}
