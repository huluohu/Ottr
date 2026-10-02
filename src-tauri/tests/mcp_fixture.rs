//! MCP 真夹具端到端（Phase 4 Task 3 Step 3）：**relay 子进程 + UDS + 引擎 +
//! 授权矩阵 + 真 exec/SFTP 通道**全链——脚本模拟 MCP 客户端（echo JSON-RPC 进
//! stdin 读 stdout，`ottr-mcp` relay 子进程即被测客户端面）：
//! * initialize → serverInfo / notifications 静默 / tools/list 三件；
//! * list_hosts：授权主机可见、未授权不可见、无凭据面字段；
//! * exec_command：授权 + 免审批档真执行（真夹具 exec 通道）；
//! * 逐次审批档：门放行 → 真执行；门拒绝 → isError（门不触发执行）；
//! * exec 未授权主机 → isError；read_file 白名单内读真文件 / 白名单外拒绝；
//! * 协议错误面（未知工具 -32602）。
//!
//! 夹具不可达即 SKIP 并提示启动命令（batch_fixture 同纪律）。
//!
//! Run: `cargo test -p ottr --test mcp_fixture`
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_lib::{spawn_listener, ApprovalGate, HostSessionResolver, McpEngine};
use ottr_ssh::{connect, AuthMethod, HostKeyPolicy, SshSession};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostInput, Hosts, McpGrantInput, McpGrants, Vault};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

fn fixture_up() -> bool {
    std::net::TcpStream::connect((HOST, PORT)).is_ok()
}

fn pinned_host_key_policy() -> HostKeyPolicy {
    use russh::keys::{parse_public_key_base64, HashAlg};
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .expect("read fixtures/known_hosts —— 先跑 scripts/spike-sshd.sh");
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let base64 = line
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line shape");
    let pinned = parse_public_key_base64(base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_fp)
}

/// 脚本化审批门（夹具引擎注入；记录请求供断言）。
struct ScriptGate {
    script: Mutex<VecDeque<bool>>,
    requests: Mutex<Vec<String>>,
}

impl ApprovalGate for ScriptGate {
    fn request_exec_approval(
        &self,
        _host_id: i64,
        host_name: &str,
        command: &str,
    ) -> Result<bool, String> {
        self.requests
            .lock()
            .unwrap()
            .push(format!("{host_name}: {command}"));
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| "gate exhausted".to_string())
    }
}

/// relay 子进程句柄 + 响应行读取线程（模拟 MCP 客户端的另一半）。
struct RelayClient {
    child: Child,
    responses: std::sync::mpsc::Receiver<String>,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl RelayClient {
    fn spawn(socket: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ottr-mcp"))
            .arg("--socket")
            .arg(socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ottr-mcp relay (CARGO_BIN_EXE)");
        let stdin = child.stdin.take().expect("relay stdin");
        let stdout = child.stdout.take().expect("relay stdout");
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

    fn response(&self, what: &str) -> serde_json::Value {
        let line = self
            .responses
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|_| panic!("relay response timeout: {what}"));
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad JSON for {what}: {e}: {line}"))
    }

    /// 发帧收响应（notification 后的下一帧响应用 id 对账——静默无回线的
    /// 语义靠它间接验证）。
    fn roundtrip(&self, id: i64, method: &str, params: &str, what: &str) -> serde_json::Value {
        let frame = if params.is_empty() {
            format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}"}}"#)
        } else {
            format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{params}}}"#)
        };
        self.send(&frame);
        let v = self.response(what);
        assert_eq!(v["id"], id, "{what}: id 对账");
        v
    }

    /// tools/call 快捷面 → (isError?, 结果 text 或 error.message)。
    fn call_tool(&self, id: i64, name: &str, args: &str) -> (bool, String) {
        let params = format!(r#"{{"name":"{name}","arguments":{args}}}"#);
        let v = self.roundtrip(id, "tools/call", &params, name);
        if let Some(err) = v.get("error") {
            (true, err["message"].as_str().unwrap_or_default().into())
        } else {
            let is_error = v["result"]["isError"].as_bool().unwrap_or(false);
            let text = v["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            (is_error, text)
        }
    }
}

impl Drop for RelayClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn mcp_relay_end_to_end_over_real_fixture() {
    if !fixture_up() {
        println!("SKIP mcp_relay_end_to_end_over_real_fixture: fixture down —— 先跑 scripts/spike-sshd.sh");
        return;
    }
    // 显式测试 runtime：SSH connect/exec 的 async 宿主 + engine block_on 桥
    // （conn 线程是独立 std 线程，不占 worker）。
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("test runtime");

    rt.block_on(mcp_flow(rt.handle().clone()));
    rt.shutdown_timeout(Duration::from_secs(2));
}

/// 全流程主体（async：前段真连接；后续 relay 驱动是同步阻塞面，跑在
/// block_on 专属线程上——multi_thread 运行时其余 worker 照常可用）。
async fn mcp_flow(handle: tokio::runtime::Handle) {
    // --- 播种 vault：三主机（A 全授权免审批 / B 只可见 / C 全授权 + 审批档）---
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
                address: HOST.into(),
                port: PORT as i64,
                username: Some(USER.into()),
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
    let host_b = mk_host("mcp-fx-b");
    let host_c = mk_host("mcp-fx-c");
    mk_host("mcp-fx-hidden"); // 无授权行 = 全不可见（id 不出现在 list_hosts）
    McpGrants::upsert(
        &vault,
        &McpGrantInput {
            host_id: host_a,
            can_list: true,
            can_exec: true,
            exec_approval: false, // 免审批档（用户显式选择）
            read_paths: vec!["/tmp".into()],
        },
    )
    .unwrap();
    McpGrants::upsert(
        &vault,
        &McpGrantInput {
            host_id: host_b,
            can_list: true,
            can_exec: false, // 只可见不可执行
            exec_approval: false,
            read_paths: vec![],
        },
    )
    .unwrap();
    McpGrants::upsert(
        &vault,
        &McpGrantInput {
            host_id: host_c,
            can_list: true,
            can_exec: true,
            exec_approval: true, // 逐次审批档
            read_paths: vec!["/tmp".into()],
        },
    )
    .unwrap();

    // --- 真 session×2（同容器双连 = 两台主机，batch_fixture 裁定口径）---
    let policy = pinned_host_key_policy();
    let connect_one = || {
        connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            Arc::clone(&policy),
        )
    };
    let s_a = Arc::new(connect_one().await.expect("connect fixture A"));
    let s_c = Arc::new(connect_one().await.expect("connect fixture C"));
    let mut table: HashMap<i64, Arc<SshSession>> = HashMap::new();
    table.insert(host_a, Arc::clone(&s_a));
    table.insert(host_c, Arc::clone(&s_c));
    let table = Arc::new(Mutex::new(table));
    let resolver: HostSessionResolver = {
        let table = Arc::clone(&table);
        Arc::new(move |id| table.lock().unwrap().get(&id).map(Arc::clone))
    };

    // 引擎 + UDS listener（审批门脚本：先放行后拒绝）。
    let gate = Arc::new(ScriptGate {
        script: Mutex::new(VecDeque::from(vec![true, false])),
        requests: Mutex::new(Vec::new()),
    });
    let engine = Arc::new(McpEngine {
        vault: Arc::clone(&vault),
        sessions: resolver,
        gate: Arc::clone(&gate) as Arc<dyn ApprovalGate>,
        rt: handle,
        exec_timeout: Duration::from_secs(30),
    });
    let sock = dir.path().join("mcp.sock");
    let listener = spawn_listener(sock.clone(), Arc::clone(&engine)).expect("bind listener");

    // --- MCP 客户端全流程（经 relay 子进程）---
    let client = RelayClient::spawn(&sock);
    let init = client.roundtrip(
        1,
        "initialize",
        r#"{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-fixture","version":"0"}}"#,
        "initialize",
    );
    assert_eq!(
        init["result"]["serverInfo"]["name"],
        ottr_lib::mcp::SERVER_NAME
    );
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");

    // notification 无回线：紧跟 tools/list，首个响应必须是 id=2（roundtrip 内对账）。
    client.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    let tools = client.roundtrip(2, "tools/list", "", "tools/list");
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["list_hosts", "exec_command", "read_file"]);

    // list_hosts：授权可见 / 未授权不可见 / 无凭据面。
    let (is_err, text) = client.call_tool(3, "list_hosts", "{}");
    assert!(!is_err, "list_hosts 应成功: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let rows = v.as_array().unwrap();
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(
        ids,
        vec![host_a, host_b, host_c],
        "未授权主机不可见: {text}"
    );
    assert!(
        rows.iter().all(|r| r.get("username").is_none()
            && r.get("credential_id").is_none()
            && r.get("notes").is_none()),
        "密钥/备注面不出工具面: {text}"
    );

    // exec_command（免审批档）：真 exec 通道跑算术，输出原样返回。
    let (is_err, text) = client.call_tool(
        4,
        "exec_command",
        &format!(r#"{{"host_id":{host_a},"command":"echo mcp-e2e-$((41+1))"}}"#),
    );
    assert!(!is_err, "exec 应成功: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["stdout"].as_str().unwrap().trim(), "mcp-e2e-42");
    assert_eq!(v["exit_code"], 0);
    assert_eq!(v["host"], "mcp-fx-a");
    assert_eq!(gate.requests.lock().unwrap().len(), 0, "免审批档不问门");

    // read_file：白名单内真文件（经 session exec 造数）。
    let stamp = std::process::id();
    let remote = format!("/tmp/ottr-mcp-e2e-{stamp}.txt");
    s_a.exec(&format!("printf 'mcp-e2e-content' > {remote}"))
        .await
        .expect("seed file");
    let (is_err, text) = client.call_tool(
        5,
        "read_file",
        &format!(r#"{{"host_id":{host_a},"path":"{remote}"}}"#),
    );
    assert!(!is_err, "read_file 应成功: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(
        v["content"]
            .as_str()
            .unwrap()
            .starts_with("mcp-e2e-content"),
        "{text}"
    );
    assert_eq!(v["path"].as_str().unwrap(), remote, "canonical 路径回显");

    // read_file：白名单外 → isError（canonical 终判）。
    let (is_err, text) = client.call_tool(
        6,
        "read_file",
        &format!(r#"{{"host_id":{host_a},"path":"/etc/hostname"}}"#),
    );
    assert!(is_err, "白名单外必须拒: {text}");
    assert!(text.contains("outside the read_file whitelist"), "{text}");
    // 清理造数文件。
    let _ = s_a.exec(&format!("rm -f {remote}")).await;

    // exec_command 未授权主机 → isError。
    let (is_err, text) = client.call_tool(
        7,
        "exec_command",
        &format!(r#"{{"host_id":{host_b},"command":"whoami"}}"#),
    );
    assert!(is_err, "只可见不可执行: {text}");
    assert!(text.contains("not granted"), "{text}");

    // 审批档：门放行 → 真执行；门拒绝 → isError 且不执行。
    let (is_err, text) = client.call_tool(
        8,
        "exec_command",
        &format!(r#"{{"host_id":{host_c},"command":"echo gated-ok"}}"#),
    );
    assert!(!is_err, "审批放行应执行: {text}");
    assert!(text.contains("gated-ok"), "{text}");
    let (is_err, text) = client.call_tool(
        9,
        "exec_command",
        &format!(r#"{{"host_id":{host_c},"command":"echo should-not-run"}}"#),
    );
    assert!(is_err, "审批拒绝应 isError: {text}");
    assert!(text.contains("denied by user"), "{text}");
    // 门按授权档精确触发：免审批档 0 次 + 审批档 2 次。
    assert_eq!(gate.requests.lock().unwrap().len(), 2, "门触发账目");

    // 未知工具 → 协议级错误。
    let (is_err, text) = client.call_tool(10, "write_file", "{}");
    assert!(is_err, "未知工具走协议错误");
    assert!(text.contains("unknown tool"), "{text}");

    drop(client);
    listener.cancel.cancel();
}
