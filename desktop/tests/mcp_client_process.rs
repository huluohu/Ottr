//! MCP 客户端的**进程级**端到端测试（2026-11-03）。
//!
//! 单元测试（`desktop/src/mcp_client.rs` 内）用的是内存管道，**没有覆盖真实的
//! `Command::spawn` 路径**——而那正是最容易出问题的一段：环境最小化
//! （`env_clear`）、stderr 排空、`kill_on_drop`、子进程早退的收尾。
//!
//! 本文件用「**当前测试二进制自举**」当 mock MCP server：带环境变量重跑自己
//! 时进入 mock 模式（读 stdin 的行 → 回一行 JSON-RPC 响应）。这样不依赖
//! python/sh 等外部运行时，CI 与真机都能跑。
//!
//! 用法：cargo test --test mcp_client_process

use std::io::{BufRead, Write};

use ottr_lib::mcp_client::McpClient;

/// mock 模式的环境变量开关。
const MOCK_ENV: &str = "OTTR_TEST_MCP_MOCK";

/// 进入 mock 模式：按 MCP 基础三方法应答，然后退出。
fn run_mock_server() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = req.get("id").cloned();
        let result = match method {
            "initialize" => serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "ottr-test-mock", "version": "0" }
            }),
            "tools/list" => serde_json::json!({
                "tools": [{
                    "name": "echo",
                    "description": "回显传入的文本",
                    "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } }
                }]
            }),
            "tools/call" => {
                // 工具结果：把参数里的 text 原样回显（便于断言调用链路真的走通了）
                let text = req
                    .get("params")
                    .and_then(|p| p.get("arguments"))
                    .and_then(|a| a.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                serde_json::json!({
                    "content": [{ "type": "text", "text": format!("echo: {text}") }],
                    "isError": false
                })
            }
            _ => serde_json::json!({}),
        };
        // notification（无 id）不回响应
        let Some(id) = id else { continue };
        let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}

fn mock_command() -> (String, Vec<String>) {
    (
        std::env::current_exe()
            .expect("current test exe")
            .to_string_lossy()
            .to_string(),
        vec![],
    )
}

#[tokio::test]
async fn spawns_real_process_lists_tools_and_calls_tool() {
    // 自举：当前测试二进制以 mock 模式重跑
    let (exe, args) = mock_command();
    let client = McpClient::spawn_with_timeout(
        &exe,
        &args,
        &[("OTTR_TEST_MCP_MOCK".to_string(), "1".to_string())],
        std::time::Duration::from_secs(10),
    )
    .expect("spawn mock MCP server");

    client.initialize().await.expect("initialize");

    let tools = client.list_tools().await.expect("tools/list");
    assert_eq!(tools.len(), 1, "应列出 1 个工具");
    assert_eq!(tools[0].name, "echo");
    assert!(
        tools[0].description.contains("回显"),
        "工具描述应原样带回：{}",
        tools[0].description
    );

    let result = client
        .call_tool("echo", serde_json::json!({ "text": "你好 ottr" }))
        .await
        .expect("tools/call");
    assert!(!result.is_error, "工具不应报错");
    assert!(
        result.text.contains("echo: 你好 ottr"),
        "工具结果应含回显文本：{}",
        result.text
    );

    client.shutdown();
}

#[tokio::test]
async fn nonexistent_command_fails_fast_with_reason() {
    let err = McpClient::spawn_with_timeout(
        "/nonexistent/definitely-not-a-real-binary-ottr",
        &[],
        &[],
        std::time::Duration::from_secs(5),
    )
    .expect_err("不存在的命令必须失败");
    assert!(
        err.contains("failed to start"),
        "错误应说明是启动失败：{err}"
    );
}

/// 当本二进制以 mock 模式被拉起时（而不是被测试框架调用），进入 mock server。
///
/// 判据：环境变量存在 且 参数里没有 `--test` 之类的测试框架标记。
/// （测试框架每次运行都会带 `--test-threads` / `--exact` 等参数。）
fn maybe_run_mock_server() -> bool {
    if std::env::var(MOCK_ENV).is_err() {
        return false;
    }
    let args: Vec<String> = std::env::args().collect();
    let looks_like_test_run = args
        .iter()
        .any(|a| a.starts_with("--test") || a.starts_with("--nocapture") || a == "--list");
    if looks_like_test_run {
        return false;
    }
    run_mock_server();
    true
}

// 测试二进制被 spawn 时没有测试框架参数 → 进 mock 模式。
// 这里用一个「哑测试」承载：它本身不做断言，只负责在自举时切换行为。
#[test]
fn mock_server_entrypoint() {
    if maybe_run_mock_server() {
        // 已在 mock 模式里服务完毕（stdin 关闭即退出）。
    }
}
