//! MCP 工具引擎（ToolHandler 实现）：授权矩阵裁定 + exec 审批门 + read 白名单
//! 以及 list 元数据面。纯搬家拆分（原 commands/mcp.rs 单文件）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ottr_ssh::SshSession;
use ottr_vault::{Hosts, McpGrant, McpGrants, Vault};

use serde::Serialize;

use crate::mcp::{TOOL_EXEC_COMMAND, TOOL_LIST_HOSTS, TOOL_READ_FILE, ToolError, ToolHandler};

use super::approvals::ApprovalGate;

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/// host_id → 在册会话解析（cron `session_for_host` 的注入化——生产闭包查
/// AppState 会话表，夹具测试查预建映射；batch ExecResolver 同款反转）。
pub type HostSessionResolver = Arc<dyn Fn(i64) -> Option<Arc<SshSession>> + Send + Sync>;

/// MCP 工具引擎：授权矩阵执行 + 三件工具实现。实现协议核的
/// [`ToolHandler`]——同步入口（连接线程上跑），内部经注入的 tokio Handle
/// 桥接 SSH/SFTP 异步面（conn 线程专属，block_on 不占 async worker）。
pub struct McpEngine {
    pub vault: Arc<Vault>,
    pub sessions: HostSessionResolver,
    pub gate: Arc<dyn ApprovalGate>,
    pub rt: tokio::runtime::Handle,
    pub exec_timeout: Duration,
}

impl ToolHandler for McpEngine {
    fn call_tool(&self, name: &str, arguments: &serde_json::Value) -> Result<String, ToolError> {
        match name {
            TOOL_LIST_HOSTS => self.tool_list_hosts(),
            TOOL_EXEC_COMMAND => {
                let (host_id, command) = parse_exec_args(arguments)?;
                let plan = self.prepare_exec(host_id)?;
                let fut = self.exec_via_session(plan, host_id, command);
                self.rt.block_on(fut)
            }
            TOOL_READ_FILE => {
                let (host_id, path) = parse_read_args(arguments)?;
                let grant = self.check_read_local(host_id, &path)?;
                let fut = self.read_via_sftp(grant, host_id, path);
                self.rt.block_on(fut)
            }
            other => Err(ToolError::UnknownTool(other.to_string())),
        }
    }
}

/// exec 执行计划（prepare_exec 产物；needs_approval = 授权行的审批档）。
struct ExecPlan {
    session: Arc<SshSession>,
    host_name: String,
    needs_approval: bool,
}

/// `list_hosts` 结果行（显式白名单字段——serde serialize Host 全量会把
/// username/credential_id/notes 带出去，这里手工挑列杜绝密钥面外泄）。
#[derive(Serialize)]
struct McpHostMeta {
    id: i64,
    name: String,
    address: String,
    port: i64,
    tags: Vec<String>,
    group: Option<String>,
    is_production: bool,
}

impl McpEngine {
    /// list_hosts：can_list 授权主机 × 元数据白名单列。锁定态可读（元数据是
    /// 明文面；凭据面本就不在输出里）。授权矩阵读失败 → 执行错误（不静默空表
    /// ——空表会被 AI 误读为「没有主机」而非「没有授权」）。
    fn tool_list_hosts(&self) -> Result<String, ToolError> {
        let grants: HashMap<i64, McpGrant> = McpGrants::list(&self.vault)
            .map_err(|e| ToolError::Execution(format!("read grants failed: {e}")))?
            .into_iter()
            .map(|g| (g.host_id, g))
            .collect();
        let groups: HashMap<i64, String> = ottr_vault::HostGroups::list(&self.vault)
            .map_err(|e| ToolError::Execution(format!("read groups failed: {e}")))?
            .into_iter()
            .map(|g| (g.id, g.name))
            .collect();
        let mut out = Vec::new();
        for h in Hosts::list(&self.vault)
            .map_err(|e| ToolError::Execution(format!("read hosts failed: {e}")))?
        {
            let Some(g) = grants.get(&h.id) else {
                continue; // 无授权行 = 不可见（默认拒）
            };
            if !g.can_list {
                continue;
            }
            out.push(McpHostMeta {
                id: h.id,
                name: h.name.clone(),
                address: h.address.clone(),
                port: h.port,
                tags: h.tags.clone(),
                group: h.group_id.and_then(|id| groups.get(&id).cloned()),
                is_production: h.is_production,
            });
        }
        serde_json::to_string_pretty(&out).map_err(|e| ToolError::Execution(e.to_string()))
    }

    /// exec 的同步前置检查（形状 → 授权 → 主机存在 → 锁定 → 会话）——拒绝
    /// 路径全不触达异步桥（单测无需 runtime），且形状/授权先于连接面检查
    /// （参数错不消耗授权读）。
    fn prepare_exec(&self, host_id: i64) -> Result<ExecPlan, ToolError> {
        let grant = self.grant_for(host_id).map_err(ToolError::Execution)?;
        if !grant.can_exec {
            return Err(ToolError::Execution(format!(
                "host {host_id} is not granted for exec_command in Ottr MCP settings"
            )));
        }
        let needs_approval = grant.exec_approval;
        drop(grant);
        let host = Hosts::get(&self.vault, host_id)
            .map_err(|e| ToolError::Execution(format!("read host failed: {e}")))?
            .ok_or_else(|| ToolError::Execution(format!("host {host_id} not found")))?;
        if self.vault.is_locked() {
            return Err(ToolError::Execution(
                "vault is locked — unlock Ottr to use MCP exec_command".into(),
            ));
        }
        let session = (self.sessions)(host_id).ok_or_else(|| {
            ToolError::Execution(format!(
                "no live session for host '{}' (open a tab in Ottr first)",
                host.name
            ))
        })?;
        Ok(ExecPlan {
            session,
            host_name: host.name,
            needs_approval,
        })
    }

    /// 审批门（独立段，可单测注入门——SshSession 是具体类型无法 mock，
    /// 门与执行拆开后门逻辑无需真会话）。
    pub(super) fn pass_gate(
        &self,
        host_id: i64,
        host_name: &str,
        command: &str,
    ) -> Result<(), ToolError> {
        // 门是阻塞 recv——conn 专属线程上直接阻塞即可（不占 async worker）。
        let granted = self
            .gate
            .request_exec_approval(host_id, host_name, command)
            .map_err(ToolError::Execution)?;
        if granted {
            Ok(())
        } else {
            Err(ToolError::Execution(format!(
                "exec_command on '{host_name}' denied by user in the approval prompt"
            )))
        }
    }

    /// 审批档判定 + 限时 exec + 输出整形（异步段；conn 线程 block_on 宿主）。
    async fn exec_via_session(
        &self,
        plan: ExecPlan,
        host_id: i64,
        command: String,
    ) -> Result<String, ToolError> {
        let ExecPlan {
            session,
            host_name,
            needs_approval,
        } = plan;
        // 审批门只在授权行显式开启审批档时触发（免审批档 = 授权即放行）。
        if needs_approval {
            self.pass_gate(host_id, &host_name, &command)?;
        }
        let exec = async {
            session
                .exec(&command)
                .await
                .map_err(|e| ToolError::Execution(format!("exec failed: {e}")))
        };
        let out = match tokio::time::timeout(self.exec_timeout, exec).await {
            Err(_) => {
                return Err(ToolError::Execution(format!(
                    "exec timed out after {}s",
                    self.exec_timeout.as_secs()
                )));
            }
            Ok(r) => r?,
        };
        let (stdout, t1) = cap_output(&out.stdout);
        let (stderr, t2) = cap_output(&out.stderr);
        let payload = serde_json::json!({
            "host": host_name,
            "command": command,
            "exit_code": out.exit_status.map(i64::from),
            "stdout": stdout,
            "stderr": stderr,
            "truncated": t1 || t2,
        });
        serde_json::to_string_pretty(&payload).map_err(|e| ToolError::Execution(e.to_string()))
    }

    /// read_file 本地预检（参数形状 + 授权 + 白名单非空 + 锁定 + 会话存在）。
    /// 路径形状：绝对 + 无 `..` 段 + 无 NUL（canonical 终判在远端，见
    /// read_via_sftp——本地字符串预筛只为把明显逃逸在连接前拒掉）。
    fn check_read_local(&self, host_id: i64, path: &str) -> Result<McpGrant, ToolError> {
        if path.is_empty() || path == "/" || !path.starts_with('/') {
            return Err(ToolError::InvalidParams(
                "path must be an absolute remote path".into(),
            ));
        }
        if path.as_bytes().contains(&0) || path.split('/').any(|seg| seg == "..") {
            return Err(ToolError::InvalidParams(
                "path must not contain '..' segments".into(),
            ));
        }
        let grant = self.grant_for(host_id).map_err(ToolError::Execution)?;
        if grant.read_paths.is_empty() {
            return Err(ToolError::Execution(format!(
                "host {host_id} has no read_file directory whitelist in Ottr MCP settings"
            )));
        }
        if self.vault.is_locked() {
            return Err(ToolError::Execution(
                "vault is locked — unlock Ottr to use MCP read_file".into(),
            ));
        }
        if (self.sessions)(host_id).is_none() {
            return Err(ToolError::Execution(
                "no live session for host (open a tab in Ottr first)".into(),
            ));
        }
        Ok(grant)
    }

    /// SFTP 读（canonical 白名单终判 → 大小护栏 → 读文本）。grant 由
    /// call_tool 的本地预检产出（形状/授权/锁定/会话面已在连接前收口）。
    async fn read_via_sftp(
        &self,
        grant: McpGrant,
        host_id: i64,
        path: String,
    ) -> Result<String, ToolError> {
        let session = (self.sessions)(host_id)
            .ok_or_else(|| ToolError::Execution("session vanished".into()))?;
        let host = Hosts::get(&self.vault, host_id)
            .map_err(|e| ToolError::Execution(format!("read host failed: {e}")))?
            .ok_or_else(|| ToolError::Execution(format!("host {host_id} not found")))?;
        let sftp = ottr_transfer::SftpClient::open(&session)
            .await
            .map_err(|e| ToolError::Execution(format!("sftp open failed: {e}")))?;
        // 终判：远端 canonical 路径（符号链接展开后）必须落在白名单目录的
        // canonical 形态内。白名单目录同样 realpath 归一（白名单本身指向
        // 符号链接时语义以远端为准）。
        let canonical = sftp
            .realpath(&path)
            .await
            .map_err(|e| ToolError::Execution(format!("resolve path failed: {e}")))?;
        let mut allowed = false;
        for dir in &grant.read_paths {
            let dir_canon = match sftp.realpath(dir).await {
                Ok(c) => c,
                Err(e) => {
                    return Err(ToolError::Execution(format!(
                        "resolve whitelist dir {dir} failed: {e}"
                    )));
                }
            };
            if path_within(&canonical, &dir_canon) {
                allowed = true;
                break;
            }
        }
        if !allowed {
            return Err(ToolError::Execution(format!(
                "path {} (canonical {}) is outside the read_file whitelist for host {}",
                path, canonical, host.name
            )));
        }
        let entry = sftp
            .stat(&canonical)
            .await
            .map_err(|e| ToolError::Execution(format!("stat failed: {e}")))?;
        if entry.size > READ_FILE_MAX_BYTES {
            return Err(ToolError::Execution(format!(
                "file exceeds the {} KiB read_file limit ({} bytes)",
                READ_FILE_MAX_BYTES / 1024,
                entry.size
            )));
        }
        let bytes = sftp
            .open_remote_text(&canonical)
            .await
            .map_err(|e| ToolError::Execution(format!("read failed: {e}")))?;
        let payload = serde_json::json!({
            "host": host.name,
            "path": canonical,
            "size": bytes.len(),
            "content": String::from_utf8_lossy(&bytes),
        });
        serde_json::to_string_pretty(&payload).map_err(|e| ToolError::Execution(e.to_string()))
    }

    /// 授权行（None → 默认拒的统一措辞）。
    fn grant_for(&self, host_id: i64) -> Result<McpGrant, String> {
        McpGrants::get_for_host(&self.vault, host_id)
            .map_err(|e| format!("read grant failed: {e}"))?
            .ok_or_else(|| {
                format!("host {host_id} is not exposed to MCP (no grant in Ottr settings)")
            })
    }
}

/// 参数整形：exec_command（host_id 整数 + command 非空字符串 ≤64KB）。
/// 形状检查是协议级 InvalidParams 面——先于授权检查（参数错不消耗授权读）。
fn parse_exec_args(args: &serde_json::Value) -> Result<(i64, String), ToolError> {
    let host_id = args
        .get("host_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ToolError::InvalidParams("host_id (integer) is required".into()))?;
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("command (string) is required".into()))?
        .to_string();
    if command.is_empty() {
        return Err(ToolError::InvalidParams("command must not be empty".into()));
    }
    if command.len() > COMMAND_MAX_BYTES {
        return Err(ToolError::InvalidParams(format!(
            "command exceeds {COMMAND_MAX_BYTES} bytes"
        )));
    }
    Ok((host_id, command))
}

/// 参数整形：read_file（host_id 整数 + path 字符串）。
fn parse_read_args(args: &serde_json::Value) -> Result<(i64, String), ToolError> {
    let host_id = args
        .get("host_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ToolError::InvalidParams("host_id (integer) is required".into()))?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidParams("path (string) is required".into()))?
        .to_string();
    Ok((host_id, path))
}

/// 白名单前缀判定（canonical 对 canonical；目录边界精确到路径段——
/// `/tmp2` 不匹配 `/tmp`；根目录 `/` 特判避免 `//` 前缀）。
pub(super) fn path_within(canonical_child: &str, canonical_dir: &str) -> bool {
    if canonical_dir == "/" {
        return canonical_child.starts_with('/');
    }
    canonical_child == canonical_dir || canonical_child.starts_with(&format!("{canonical_dir}/"))
}

/// exec 输出字节护栏（lossy + 截断标志；batch 输出面同口径的单字节上限版）。
pub(super) fn cap_output(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= OUTPUT_MAX_BYTES {
        (String::from_utf8_lossy(bytes).into_owned(), false)
    } else {
        (
            String::from_utf8_lossy(&bytes[..OUTPUT_MAX_BYTES]).into_owned(),
            true,
        )
    }
}

pub const EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// 逐次审批等待窗（TOFU host key 问询 HOST_KEY_ASK_TIMEOUT 同值；超时=拒绝）。
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);
/// 单命令字节上限（batch 同款护栏）。
pub const COMMAND_MAX_BYTES: usize = 64 * 1024;
/// stdout/stderr 各自字节上限（batch 输出面同口径，超限截断 + truncated 标志）。
pub const OUTPUT_MAX_BYTES: usize = 64 * 1024;
/// read_file 大小护栏（超出拒绝不截断——AI 侧拿半截配置文件是事故源）。
pub const READ_FILE_MAX_BYTES: u64 = 256 * 1024;
