//! MCP 协议核（Phase 4 Task 3，C1）：JSON-RPC 2.0 over stdio 的消息层，
//! MCP 2024-11-05 基础面——`initialize` / `tools/list` / `tools/call`
//! （+ `ping`；notifications 容忍忽略）。resources/prompts 不在 C1 面
//! （配额裁定：规范面只做基础三方法）。
//!
//! 【分层】本模块是**纯协议层**（无 tauri 依赖、无 IO）：
//! * [`McpServer::handle_frame`]：一行输入 → 零或一行输出（None = notification/
//!   可忽略帧，不回线）。行内字节 → serde_json 解析 → 方法分发 → handler；
//! * 工具执行经 [`ToolHandler`] 注入——生产实现在 commands/mcp.rs（引擎：
//!   授权矩阵/审批门/SSH exec/SFTP 读），测试用 mock；协议层不碰安全面；
//! * 工具目录 [`tool_definitions`] 是三件工具的单一事实源（tools/list 输出
//!   与引擎 dispatch 共用名字面量）。
//!
//! 【错误面映射】JSON-RPC 协议级错误（-32700 parse / -32600 invalid request /
//! -32601 method not found / -32602 invalid params / -32603 internal）；
//! 工具**执行期**失败按 MCP 规范走 `isError: true` 的正常 result（不是协议
//! 错误）——AI 客户端要把失败原文读给用户/自纠，协议错误会丢失工具语义。
//!
//! 【帧纪律】行分隔 JSON（stdio transport）；输入行上限 [`MAX_FRAME_BYTES`]
//! （防御性：超长行按 parse error 回，不分配无界缓冲——引擎读侧同口径截断）。
//! initialize 之前调 tools/* → -32600（规范状态机：client 必须先 initialize）。

use serde_json::{json, Value};

/// 本 server 支持的最新 MCP 协议版本（2024-11-05 基础面）。
pub const PROTOCOL_VERSION: &str = "2024-11-05";
/// serverInfo.name（客户端配置展示面）。
pub const SERVER_NAME: &str = "ottr";
/// serverInfo.version（随 crate 版本走）。
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 输入行字节上限（1MB：三件工具的参数面——host_id + 命令/路径——远用不到，
/// 超限即客户端失控，按 parse error 回绝）。
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

// JSON-RPC 2.0 错误码（规范保留段）。
pub const ERR_PARSE: i64 = -32700;
pub const ERR_INVALID_REQUEST: i64 = -32600;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
pub const ERR_INTERNAL: i64 = -32603;

/// 三件工具名（tools/list 目录与引擎 dispatch 的单一事实源）。
pub const TOOL_LIST_HOSTS: &str = "list_hosts";
pub const TOOL_EXEC_COMMAND: &str = "exec_command";
pub const TOOL_READ_FILE: &str = "read_file";

/// 工具执行错误（协议层映射见模块文档【错误面映射】）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// 请求的工具不存在（协议级 -32602）。
    UnknownTool(String),
    /// arguments 形状非法（缺参/类型错，协议级 -32602）。
    InvalidParams(String),
    /// 执行期失败（授权拒绝/连接缺失/远端错误 → isError:true 的正常 result）。
    Execution(String),
}

/// 工具执行出口（引擎实现；mock 注入测试）。
pub trait ToolHandler {
    fn call_tool(&self, name: &str, arguments: &Value) -> Result<String, ToolError>;
}

/// 工具目录（tools/list 输出）。三件的 inputSchema 都是严格对象：
/// additionalProperties false + required 齐全——AI 侧参数越形状在协议层
/// 即拒（-32602），不进引擎。
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": TOOL_LIST_HOSTS,
            "description": "List the SSH hosts the user has explicitly exposed to MCP. \
        Returns id/name/address/port/tags/group only — never credentials.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": TOOL_EXEC_COMMAND,
            "description": "Run a shell command on one exposed host via the exec channel \
        (non-interactive, no PTY). Requires per-host exec grant; may require \
        per-exec approval in the Ottr UI. The host must have a live session \
        (a connected tab) in the running Ottr app.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "host_id": { "type": "integer", "description": "Host id from list_hosts" },
                    "command": { "type": "string", "description": "Shell command to run remotely" }
                },
                "required": ["host_id", "command"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": TOOL_READ_FILE,
            "description": "Read a text file from one exposed host over SFTP. Only paths \
        inside the directories whitelisted for that host are allowed; the \
        canonical (symlink-resolved) remote path must stay inside the whitelist.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "host_id": { "type": "integer", "description": "Host id from list_hosts" },
                    "path": { "type": "string", "description": "Absolute remote file path" }
                },
                "required": ["host_id", "path"],
                "additionalProperties": false
            }
        }),
    ]
}

/// MCP stdio server 消息核。状态面只有 initialize 状态机（规范要求 client
/// 先 initialize 再调其余方法）。
#[derive(Default)]
pub struct McpServer {
    initialized: bool,
}

impl McpServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一帧（一行，不含换行）。返回 Some(响应行 JSON) 或 None（notification
    /// / 无需回线的帧）。`handler` 只在 tools/call 时被触达。
    pub fn handle_frame(&mut self, frame: &[u8], handler: &dyn ToolHandler) -> Option<String> {
        if frame.len() > MAX_FRAME_BYTES {
            return Some(self.error_response(Value::Null, ERR_PARSE, "frame too large"));
        }
        let msg: Value = match serde_json::from_slice(frame) {
            Ok(v) => v,
            Err(e) => {
                return Some(self.error_response(
                    Value::Null,
                    ERR_PARSE,
                    &format!("parse error: {e}"),
                ));
            }
        };
        // 批量帧（数组）不在 2024-11-05 必需面——显式拒绝（不静默当单帧）。
        if msg.is_array() {
            return Some(self.error_response(
                Value::Null,
                ERR_INVALID_REQUEST,
                "batch requests are not supported",
            ));
        }
        let Some(obj) = msg.as_object() else {
            return Some(self.error_response(
                Value::Null,
                ERR_INVALID_REQUEST,
                "request must be a JSON object",
            ));
        };
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            // 无 method = 对 server 请求的 response（本 server 从不主动请求）
            // 或残缺帧——容错忽略（回线只会制造客户端混淆）。
            return None;
        };
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        if !obj.contains_key("id") {
            // notification：永不回线（JSON-RPC 纪律；未知 notification 也静默）。
            return None;
        }
        match method {
            "initialize" => {
                self.initialized = true;
                Some(self.success_response(
                    id,
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
                    }),
                ))
            }
            "ping" => Some(self.success_response(id, json!({}))),
            "tools/list" => {
                if !self.initialized {
                    return Some(self.error_response(
                        id,
                        ERR_INVALID_REQUEST,
                        "initialize must precede tools/list",
                    ));
                }
                Some(self.success_response(id, json!({ "tools": tool_definitions() })))
            }
            "tools/call" => {
                if !self.initialized {
                    return Some(self.error_response(
                        id,
                        ERR_INVALID_REQUEST,
                        "initialize must precede tools/call",
                    ));
                }
                Some(self.dispatch_tool_call(&id, obj, handler))
            }
            other => {
                let _ = other;
                Some(self.error_response(
                    id,
                    ERR_METHOD_NOT_FOUND,
                    &format!("method not found: {method}"),
                ))
            }
        }
    }

    /// tools/call 参数整形 → handler → 结果/错误映射。
    fn dispatch_tool_call(
        &self,
        id: &Value,
        req: &serde_json::Map<String, Value>,
        handler: &dyn ToolHandler,
    ) -> String {
        let params = req.get("params");
        let name = params.and_then(|p| p.get("name")).and_then(Value::as_str);
        let Some(name) = name else {
            return self.error_response(
                id.clone(),
                ERR_INVALID_PARAMS,
                "tools/call requires params.name (string)",
            );
        };
        // arguments 缺省空对象（规范允许省略——list_hosts 无参调用）。
        let empty = json!({});
        let arguments = params.and_then(|p| p.get("arguments")).unwrap_or(&empty);
        if !arguments.is_object() {
            return self.error_response(
                id.clone(),
                ERR_INVALID_PARAMS,
                "tools/call params.arguments must be an object",
            );
        }
        match handler.call_tool(name, arguments) {
            Ok(text) => self.success_response(
                id.clone(),
                json!({ "content": [ { "type": "text", "text": text } ] }),
            ),
            Err(ToolError::Execution(msg)) => self.success_response(
                id.clone(),
                json!({ "content": [ { "type": "text", "text": msg } ], "isError": true }),
            ),
            Err(ToolError::UnknownTool(t)) => self.error_response(
                id.clone(),
                ERR_INVALID_PARAMS,
                &format!("unknown tool: {t}"),
            ),
            Err(ToolError::InvalidParams(msg)) => {
                self.error_response(id.clone(), ERR_INVALID_PARAMS, &msg)
            }
        }
    }

    fn success_response(&self, id: Value, result: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
    }

    fn error_response(&self, id: Value, code: i64, message: &str) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// mock handler：记录调用 + 可编排返回（协议层测试不碰引擎/SSH）。
    struct MockHandler {
        calls: Mutex<Vec<(String, Value)>>,
        outcome: Result<String, ToolError>,
    }

    impl MockHandler {
        fn ok(text: &str) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                outcome: Ok(text.to_string()),
            }
        }
        fn err(e: ToolError) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                outcome: Err(e),
            }
        }
    }

    impl ToolHandler for MockHandler {
        fn call_tool(&self, name: &str, arguments: &Value) -> Result<String, ToolError> {
            self.calls
                .lock()
                .unwrap()
                .push((name.to_string(), arguments.clone()));
            self.outcome.clone()
        }
    }

    fn initialize(server: &mut McpServer) -> String {
        server
            .handle_frame(
                br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}"#,
                &MockHandler::ok(""),
            )
            .expect("initialize responds")
    }

    #[test]
    fn parse_error_gives_32700_with_null_id() {
        let mut s = McpServer::new();
        let out = s.handle_frame(b"not json", &MockHandler::ok(""));
        let v: Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], ERR_PARSE);
        assert_eq!(v["jsonrpc"], "2.0");
    }

    #[test]
    fn oversized_frame_is_parse_error_without_unbounded_alloc() {
        let mut s = McpServer::new();
        let big = vec![b' '; MAX_FRAME_BYTES + 1];
        let out = s.handle_frame(&big, &MockHandler::ok(""));
        let v: Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(v["error"]["code"], ERR_PARSE);
    }

    #[test]
    fn batch_array_and_non_object_are_invalid_request() {
        let mut s = McpServer::new();
        for frame in [
            br#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#.as_slice(),
            b"42",
        ] {
            let v: Value =
                serde_json::from_str(&s.handle_frame(frame, &MockHandler::ok("")).unwrap())
                    .unwrap();
            assert_eq!(v["error"]["code"], ERR_INVALID_REQUEST, "{frame:?}");
        }
    }

    #[test]
    fn initialize_handshake_shape_and_id_echo() {
        let mut s = McpServer::new();
        let v: Value = serde_json::from_str(&initialize(&mut s)).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(v["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(v["result"]["serverInfo"]["version"].is_string());
    }

    #[test]
    fn tools_methods_before_initialize_are_rejected() {
        let mut s = McpServer::new();
        for method in ["tools/list", "tools/call"] {
            let frame = format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":"{method}","params":{{"name":"list_hosts"}}}}"#
            );
            let v: Value = serde_json::from_str(
                &s.handle_frame(frame.as_bytes(), &MockHandler::ok(""))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(v["error"]["code"], ERR_INVALID_REQUEST, "{method}");
        }
    }

    #[test]
    fn tools_list_after_initialize_returns_three_tools() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let out = s
            .handle_frame(
                br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
                &MockHandler::ok(""),
            )
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let tools = v["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            vec![TOOL_LIST_HOSTS, TOOL_EXEC_COMMAND, TOOL_READ_FILE]
        );
        for t in tools {
            assert!(t["description"].is_string(), "每工具有描述");
            assert_eq!(t["inputSchema"]["type"], "object", "inputSchema 是对象");
        }
    }

    #[test]
    fn tools_call_dispatches_name_and_arguments_and_wraps_text() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let handler = MockHandler::ok("result-text");
        let out = s
            .handle_frame(
                br#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"exec_command","arguments":{"host_id":5,"command":"whoami"}}}"#,
                &handler,
            )
            .unwrap();
        assert_eq!(
            *handler.calls.lock().unwrap(),
            vec![(
                "exec_command".to_string(),
                json!({"host_id": 5, "command": "whoami"})
            )]
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["result"]["content"][0]["type"], "text");
        assert_eq!(v["result"]["content"][0]["text"], "result-text");
        assert!(v["result"].get("isError").is_none(), "成功面无 isError");
    }

    #[test]
    fn tools_call_arguments_default_to_empty_object() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let handler = MockHandler::ok("");
        let _ = s.handle_frame(
            br#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_hosts"}}"#,
            &handler,
        );
        assert_eq!(
            handler.calls.lock().unwrap()[0].1,
            json!({}),
            "无 arguments = 空对象（list_hosts 无参调用形态）"
        );
    }

    #[test]
    fn tools_call_invalid_params_are_32602() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        // 缺 name / name 非串 / arguments 非对象 → 协议级 -32602，handler 不触达。
        for frame in [
            br#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{}}"#.as_slice(),
            br#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":42}}"#,
            br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_hosts","arguments":[1]}}"#,
        ] {
            let handler = MockHandler::ok("x");
            let v: Value = serde_json::from_str(&s.handle_frame(frame, &handler).unwrap()).unwrap();
            assert_eq!(v["error"]["code"], ERR_INVALID_PARAMS, "{frame:?}");
            assert!(handler.calls.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn unknown_tool_is_32602_from_handler_mapping() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let handler = MockHandler::err(ToolError::UnknownTool("nope".into()));
        let v: Value = serde_json::from_str(
            &s.handle_frame(
                br#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"nope"}}"#,
                &handler,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["error"]["code"], ERR_INVALID_PARAMS);
        assert!(v["error"]["message"].as_str().unwrap().contains("nope"));
    }

    #[test]
    fn execution_failure_is_iserror_result_not_protocol_error() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let handler = MockHandler::err(ToolError::Execution("host not granted".into()));
        let v: Value = serde_json::from_str(
            &s.handle_frame(
                br#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"exec_command","arguments":{"host_id":1,"command":"x"}}}"#,
                &handler,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(v.get("error").is_none(), "执行失败不是协议错误");
        assert_eq!(v["result"]["isError"], true);
        assert_eq!(v["result"]["content"][0]["text"], "host not granted");
    }

    #[test]
    fn notifications_and_response_frames_yield_no_line() {
        let mut s = McpServer::new();
        let handler = MockHandler::ok("");
        // 规范状态机的 notifications/initialized；未知 notification 同样静默。
        assert!(s
            .handle_frame(
                br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &handler
            )
            .is_none());
        assert!(s
            .handle_frame(
                br#"{"jsonrpc":"2.0","method":"notifications/unknown"}"#,
                &handler
            )
            .is_none());
        // 无 method = client 对 server 请求的 response（本 server 不主动请求）→ 忽略。
        assert!(s
            .handle_frame(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#, &handler)
            .is_none());
    }

    #[test]
    fn unknown_method_is_32601_and_ping_is_empty_result() {
        let mut s = McpServer::new();
        let _ = initialize(&mut s);
        let v: Value = serde_json::from_str(
            &s.handle_frame(
                br#"{"jsonrpc":"2.0","id":10,"method":"resources/list"}"#,
                &MockHandler::ok(""),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["error"]["code"], ERR_METHOD_NOT_FOUND);
        let v: Value = serde_json::from_str(
            &s.handle_frame(
                br#"{"jsonrpc":"2.0","id":11,"method":"ping"}"#,
                &MockHandler::ok(""),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(v["result"], json!({}));
    }
}
