//! MCP 客户端命令面（Ottr 作为 **MCP 客户端**——连接外部 MCP server）。
//!
//! 与 [`crate::commands::mcp`]（MCP **server** 侧命令面）严格对偶：
//! * server 侧：把 Ottr 的主机以工具面暴露给外部 AI 客户端（授权矩阵 + 审批门）；
//! * client 侧（本模块）：把**外部** MCP server 的工具面拉进 Ottr（列工具 / 调工具）。
//!
//! 【命令面】（前端契约——字段名逐字对齐 `frontend/vault/api.ts` 的 TS 侧类型）
//! * `mcp_servers_list` → `Vec<McpServerInfo>`：已配置的 server 清单
//!   （id/name/command/args/enabled/envNames；env 只回**变量名**，值不出库）；
//! * `mcp_server_upsert` → `McpServerInfo`：新建/编辑（id 空 = 新建）；
//! * `mcp_server_remove` → `()`：删除（连带清该 server 的 env 密文）；
//! * `mcp_server_tools` → `Vec<McpToolInfo>`：连上 server 列工具（起进程 →
//!   initialize → tools/list → 收进程，一次性会话）；
//! * `mcp_server_call` → `McpToolResult`：调一个工具（起进程 → initialize →
//!   tools/call → 收进程）；
//! * `mcp_server_env_delete` → `()`：删一个环境变量（清密文 + 摘名字）——
//!   编辑面「删除某个变量」的唯一入口（upsert 的 env 语义是「只写不删」：
//!   缺失/null = 保留旧值，避免编辑表单误删既有密文）。
//!
//! 【安全面】
//! * 全部命令过 `ensure_unlocked` 门卫（与既有 vault 命令同口径）——env 的值
//!   在 secrets 密文面，锁定即拒；
//! * 子进程**最小环境**（白名单 + 用户显式配置的 env）——Ottr 进程的环境
//!   （可能含别的工具的令牌）**不外泄**给外部 server（见 `crate::mcp_client`）；
//! * 命令/参数**不经 shell 拼接**（直接 argv 拉起，无注入面）；
//! * 每次操作都是一次性会话（用完即收进程）：不常驻外部进程，env 密钥不长期
//!   驻留内存。

use std::collections::BTreeMap;

use ottr_vault::{McpServer as VaultMcpServer, McpServerInput as VaultMcpServerInput, McpServers};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::mcp_client::{McpClient, McpTool, McpToolResult as ClientToolResult};
use crate::vault::{CmdResult, VaultState, ensure_unlocked};

/// 外部 MCP server 配置（前端消费面；camelCase 序列化）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    /// 已配置环境变量的**名**列表（值在 vault 密文面，永不出库）。
    pub env_names: Vec<String>,
}

/// 新建/编辑输入（前端消费面；camelCase 反序列化）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    /// 空 = 新建（id 由存储层生成）。
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    /// 环境变量 → 值。`null`/缺失 = **保留旧值不动**（编辑表单只带用户真正
    /// 改过的项——误删既有密文不可能发生）。
    pub env: BTreeMap<String, Option<String>>,
}

/// 工具描述（前端消费面；inputSchema 是原始 JSON 文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    /// inputSchema 原始 JSON 文本（前端自行 pretty-print 或原样展示）。
    pub input_schema: String,
}

/// 工具调用结果（前端消费面）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    /// 所有 text 内容块按顺序拼接；非 text 块以 `[<type>]` 占位。
    pub text: String,
    /// 结果自带的 isError 标记。
    pub is_error: bool,
}

fn to_info(row: &VaultMcpServer) -> McpServerInfo {
    McpServerInfo {
        id: row.id.clone(),
        name: row.name.clone(),
        command: row.command.clone(),
        args: row.args.clone(),
        enabled: row.enabled,
        env_names: row.env_names.clone(),
    }
}

fn to_tool_info(tool: &McpTool) -> McpToolInfo {
    McpToolInfo {
        name: tool.name.clone(),
        description: tool.description.clone(),
        input_schema: tool.input_schema.clone(),
    }
}

/// 已配置的外部 MCP server 清单。
#[tauri::command]
pub(crate) fn mcp_servers_list(state: State<'_, VaultState>) -> CmdResult<Vec<McpServerInfo>> {
    ensure_unlocked(&state.0)?;
    let rows = McpServers::list(&state.0).map_err(|e| e.to_string())?;
    Ok(rows.iter().map(to_info).collect())
}

/// 新建/编辑一个外部 MCP server。
///
/// env 语义：`Some(value)` = 写入该变量；`null`/缺失 = **保留旧值不动**。
#[tauri::command]
pub(crate) fn mcp_server_upsert(
    state: State<'_, VaultState>,
    input: McpServerInput,
) -> CmdResult<McpServerInfo> {
    ensure_unlocked(&state.0)?;
    let vault_input = VaultMcpServerInput {
        id: input.id,
        name: input.name,
        command: input.command,
        args: input.args,
        enabled: input.enabled,
        env: input.env,
    };
    let row = McpServers::upsert(&state.0, &vault_input).map_err(|e| e.to_string())?;
    Ok(to_info(&row))
}

/// 删除一个外部 MCP server（连带清掉它的 env 密文）。
#[tauri::command]
pub(crate) fn mcp_server_remove(state: State<'_, VaultState>, id: String) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    McpServers::delete(&state.0, &id).map_err(|e| e.to_string())
}

/// 删一个环境变量（清密文 + 摘名字）——编辑面「删除某个变量」的唯一入口。
#[tauri::command]
pub(crate) fn mcp_server_env_delete(
    state: State<'_, VaultState>,
    id: String,
    name: String,
) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    McpServers::delete_env(&state.0, &id, &name).map_err(|e| e.to_string())
}

/// 连上外部 MCP server 并列其工具（一次性会话：起进程 → initialize →
/// tools/list → 收进程）。
#[tauri::command]
pub(crate) async fn mcp_server_tools(
    state: State<'_, VaultState>,
    id: String,
) -> CmdResult<Vec<McpToolInfo>> {
    ensure_unlocked(&state.0)?;
    let client = connect(&state, &id)?;
    let result = async {
        client.initialize().await?;
        client.list_tools().await
    }
    .await;
    client.shutdown();
    Ok(result?.iter().map(to_tool_info).collect())
}

/// 调外部 MCP server 的一个工具（一次性会话）。
///
/// `argsJson` 是参数的 JSON 文本（必须是对象；空串 = 空对象）。
#[tauri::command]
pub(crate) async fn mcp_server_call(
    state: State<'_, VaultState>,
    id: String,
    tool: String,
    args_json: String,
) -> CmdResult<McpToolResult> {
    ensure_unlocked(&state.0)?;
    let args: serde_json::Value = if args_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&args_json).map_err(|e| format!("invalid tool arguments: {e}"))?
    };
    if !args.is_object() {
        return Err("tool arguments must be a JSON object".into());
    }
    let client = connect(&state, &id)?;
    let result = async {
        client.initialize().await?;
        client.call_tool(&tool, args).await
    }
    .await;
    client.shutdown();
    let ClientToolResult { text, is_error } = result?;
    Ok(McpToolResult { text, is_error })
}

/// 起一个外部 MCP server 客户端（配置 + env 值 → 子进程）。
fn connect(state: &State<'_, VaultState>, id: &str) -> CmdResult<McpClient> {
    let row = McpServers::get(&state.0, id).map_err(|e| e.to_string())?;
    if !row.enabled {
        return Err(format!("MCP server '{}' is disabled", row.name));
    }
    let env = McpServers::env_values(&state.0, id).map_err(|e| e.to_string())?;
    McpClient::spawn(&row.command, &row.args, &env)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前后端契约（字段名逐字对齐前端 TS 类型）：序列化面是 camelCase。
    #[test]
    fn info_serializes_camel_case_fields() {
        let info = McpServerInfo {
            id: "srv-1".into(),
            name: "files".into(),
            command: "npx".into(),
            args: vec!["-y".into()],
            enabled: true,
            env_names: vec!["API_TOKEN".into()],
        };
        let v = serde_json::to_value(&info).expect("serialize");
        assert!(v.get("envNames").is_some(), "envNames: {v}");
        assert!(v.get("env_names").is_none(), "不得出现 snake_case: {v}");

        let tool = McpToolInfo {
            name: "read_file".into(),
            description: "d".into(),
            input_schema: "{}".into(),
        };
        let v = serde_json::to_value(&tool).expect("serialize");
        assert!(v.get("inputSchema").is_some(), "inputSchema: {v}");

        let result = McpToolResult {
            text: "t".into(),
            is_error: true,
        };
        let v = serde_json::to_value(&result).expect("serialize");
        assert_eq!(v["isError"], true, "isError: {v}");
    }

    /// 输入面：前端发的 JSON（`id: null` + `env: {名: 值|null}`）能解出，
    /// 且 `null` 值 = 保留旧值（None）、缺键同理。
    #[test]
    fn input_deserializes_frontend_shape() {
        let input: McpServerInput = serde_json::from_value(serde_json::json!({
            "id": null,
            "name": "files",
            "command": "npx",
            "args": ["-y"],
            "enabled": true,
            "env": { "API_TOKEN": "v", "OTHER": null }
        }))
        .expect("deserialize");
        assert!(input.id.is_none(), "id=null = 新建");
        assert_eq!(input.args, vec!["-y".to_string()]);
        assert_eq!(input.env.get("API_TOKEN"), Some(&Some("v".to_string())));
        assert_eq!(input.env.get("OTHER"), Some(&None), "null 值 = 保留旧值");
    }
}
