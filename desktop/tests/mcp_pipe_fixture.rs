//! Windows 命名管道 MCP e2e（2026-10-13 命名管道形态的验收面）：
//! **relay 子进程 + named pipe + 授权矩阵**全链——引擎真跑（内存库 + 授权
//! 种子），relay 经 `--pipe` 接入，验证：
//! * initialize → serverInfo / notifications 静默 / tools/list 三件；
//! * list_hosts：授权主机可见、未授权不可见；
//! * exec_command 无在册会话 → `isError: true` 的正常 result（非协议错误
//!   ——引擎路径真被走到，与 mcp_fixture 的 unix 全链口径一致）；
//! * 未知工具 → -32602 协议错误。
//!
//! unix 侧等价夹具 = tests/mcp_fixture.rs（UDS + 真 SSH 容器全链）。本文件
//! 只在 Windows 编译运行（验证环境 = CI windows runner 真机，每次推送实跑
//! ——spike-build 的 Windows 测试步骤）。
//!
//! Run: `cargo test -p ottr --test mcp_pipe_fixture`
#![cfg(windows)]
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_lib::{ApprovalGate, McpEngine, spawn_listener};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostInput, Hosts, McpGrantInput, McpGrants, Vault};

/// 管道名逐测试进程唯一（防 CI 并发/重跑撞名）。
fn pipe_name() -> String {
    format!(
        "\\\\.\\pipe\\com.ottr.app.mcp.fixture-{}",
        std::process::id()
    )
}

/// 脚本化审批门（本夹具不触发审批路径；记录请求防意外）。
struct NoGate;

impl ApprovalGate for NoGate {
    fn request_exec_approval(
        &self,
        _host_id: i64,
        host_name: &str,
        command: &str,
    ) -> Result<bool, String> {
        Err(format!("unexpected approval: {host_name}: {command}"))
    }
}

/// relay 子进程句柄 + 响应行读取线程（模拟 MCP 客户端的另一半）。
struct RelayClient {
    child: Child,
    responses: std::sync::mpsc::Receiver<String>,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
}

/// relay 可执行文件路径（同 mcp_fixture：ottr-mcp 已拆独立 crate，Cargo 的
/// CARGO_BIN_EXE 注入不再覆盖，退回工作区 target 目录推导）。
fn relay_exe() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("CARGO_BIN_EXE_ottr-mcp") {
        return p.into();
    }
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target") // ottr-mcp 独立 crate：workspace target 在仓库根（desktop 的上一级）
        .join(profile)
        .join("ottr-mcp");
    if cfg!(windows) {
        p.set_extension("exe");
    }
    p
}

impl RelayClient {
    fn spawn(pipe: &str) -> Self {
        let mut child = Command::new(relay_exe())
            .arg("--pipe")
            .arg(pipe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn ottr-mcp relay (CARGO_BIN_EXE)");
        let stdin = child.stdin.take().expect("relay stdin");
        let stdout = child.stdout.take().expect("relay stdout");
        let stderr = child.stderr.take().expect("relay stderr");
        // relay stderr（连接诊断日志）转发到测试 stderr，失败时可读
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[relay] {line}");
            }
        });
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            responses: rx,
            stdin: Arc::new(Mutex::new(Box::new(stdin))),
        }
    }

    fn send(&self, frame: &str) {
        let mut w = self.stdin.lock().unwrap();
        w.write_all(frame.as_bytes()).expect("relay write");
        w.write_all(b"\n").expect("relay newline");
        w.flush().expect("relay flush");
    }

    /// 发请求并等响应行（id 对账；超时 = relay/引擎挂死，fail 而非悬死）。
    fn roundtrip(&mut self, id: u64, method: &str, params: &str) -> serde_json::Value {
        let frame = if params.is_empty() {
            format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}"}}"#)
        } else {
            format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#)
        };
        self.send(&frame);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let remain = deadline.saturating_duration_since(std::time::Instant::now());
            let line = match self.responses.recv_timeout(remain) {
                Ok(line) => line,
                Err(timeout_err) => {
                    let exit = self.child.try_wait().ok().flatten();
                    panic!(
                        "relay response timeout ({timeout_err:?}) for {method}: relay exit = {exit:?}"
                    );
                }
            };
            let v: serde_json::Value = serde_json::from_str(&line).expect("valid json line");
            if v["id"] == serde_json::json!(id) {
                return v;
            }
            // id 不匹配（notification 等）→ 继续等对账
        }
    }

    /// tools/call 快捷面 → (isError?, 结果 text 或 error.message)。
    fn call_tool(&mut self, id: u64, name: &str, args: &str) -> (bool, String) {
        let params = format!(r#"{{"name":"{name}","arguments":{args}}}"#);
        let v = self.roundtrip(id, "tools/call", &params);
        if let Some(err) = v["error"].as_object() {
            (
                true,
                err["message"].as_str().unwrap_or_default().to_string(),
            )
        } else {
            (
                v["result"]["isError"].as_bool().unwrap_or(false),
                v["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        }
    }
}

#[test]
fn mcp_relay_end_to_end_over_named_pipe() {
    // 显式测试 runtime：引擎工具段的 async 宿主（SSH exec/blocking 桥同 unix
    // 夹具口径）；listener 线程自带 current_thread runtime，不占 worker。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime");

    rt.block_on(mcp_flow(rt.handle().clone()));
    rt.shutdown_timeout(Duration::from_secs(2));
}

async fn mcp_flow(handle: tokio::runtime::Handle) {
    // --- 播种 vault：A 全授权（免审批）/ B 隐藏（无授权行 = 全不可见）---
    let dir = tempfile::tempdir().unwrap();
    let vault =
        Arc::new(Vault::open_with(dir.path(), &InMemoryStorage::new()).expect("open vault"));
    let mk_host = |name: &str| {
        Hosts::create(
            &vault,
            HostInput {
                protocol: Default::default(),
                name: name.into(),
                group_id: None,
                tags: vec!["fixture".into()],
                address: "192.0.2.10".into(),
                port: 22,
                username: Some("spike".into()),
                credential_id: None,
                jump_chain_id: None,
                encoding_override: None,
                theme_override: None,
                monitor_enabled: false,
                is_production: false,
                notes: None,
            },
        )
        .expect("create host")
        .id
    };
    let host_a = mk_host("mcp-fx-a");
    mk_host("mcp-fx-hidden");
    McpGrants::upsert(
        &vault,
        &McpGrantInput {
            host_id: host_a,
            can_list: true,
            can_exec: true,
            exec_approval: false,
            read_paths: vec!["C:\\tmp".into()],
        },
    )
    .unwrap();

    // 无在册会话（CI 无 SSH 夹具）：resolver 恒 None——exec 走「无会话」
    // isError 路径（正常 result，非协议错误），引擎路径真被走到。
    let resolver: ottr_lib::HostSessionResolver = Arc::new(|_id| None);
    let engine = Arc::new(McpEngine {
        vault: Arc::clone(&vault),
        sessions: resolver,
        gate: Arc::new(NoGate) as Arc<dyn ApprovalGate>,
        rt: handle,
        exec_timeout: Duration::from_secs(10),
    });
    let pipe = pipe_name();
    eprintln!("[fx] pipe = {pipe}");
    let listener = spawn_listener(std::path::PathBuf::from(&pipe), Arc::clone(&engine))
        .expect("create pipe listener");
    std::thread::sleep(Duration::from_millis(500)); // listener 就绪窗（retry 兜底）

    // --- MCP 客户端全流程（经 relay 子进程）---
    eprintln!("[fx] spawning relay");
    let mut client = RelayClient::spawn(&pipe);
    eprintln!("[fx] relay spawned");

    // initialize：协议头 + serverInfo
    let init = client.roundtrip(1, "initialize", r#"{"protocolVersion":"2024-11-05"}"#);
    assert_eq!(init["result"]["serverInfo"]["name"], "ottr");
    assert_eq!(
        init["result"]["protocolVersion"],
        ottr_lib::mcp::PROTOCOL_VERSION
    );
    // notification 无回线：紧跟 tools/list，首个响应必须是 id=2（roundtrip 内对账）
    client.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    let tools = client.roundtrip(2, "tools/list", "");
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|t| t["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(names, ["list_hosts", "exec_command", "read_file"]);

    // list_hosts：授权主机可见、隐藏主机不可见（授权矩阵真跑）
    let (is_err, text) = client.call_tool(3, "list_hosts", "{}");
    assert!(!is_err, "list_hosts should succeed: {text}");
    assert!(text.contains("mcp-fx-a"), "granted host visible: {text}");
    assert!(
        !text.contains("mcp-fx-hidden"),
        "hidden host invisible: {text}"
    );

    // exec_command 无在册会话 → isError result（引擎路径；非协议错误）
    let (is_err, text) = client.call_tool(
        4,
        "exec_command",
        &format!(r#"{{"host_id":{host_a},"command":"echo hi"}}"#),
    );
    assert!(is_err, "no-session exec must be a tool error: {text}");

    // 未知工具 → -32602 协议错误
    let v = client.roundtrip(5, "tools/call", r#"{"name":"nope","arguments":{}}"#);
    assert_eq!(v["error"]["code"], -32602);

    let _ = listener; // listener 存活至测试收尾（进程退出即清管道）
}
