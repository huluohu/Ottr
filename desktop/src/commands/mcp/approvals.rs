//! 审批门（tofu host key 问询同款形态：登记回传端 → 事件问前端 → 阻塞等裁定）。
//! 纯搬家拆分（原 commands/mcp.rs 单文件）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// 审批门（tofu host key 问询同款形态：登记回传端 → 事件问前端 → 阻塞等裁定）
// ---------------------------------------------------------------------------

/// 在途审批登记表：request_id → 裁定回传端。`mcp_approval_decision` 命令
/// 是唯一裁定入口；超时的等待方由门负责摘除（陈旧条目不滞留）。
#[derive(Default)]
pub struct McpApprovals {
    seq: AtomicI64,
    pending: Mutex<HashMap<i64, std::sync::mpsc::Sender<bool>>>,
}

impl McpApprovals {
    /// 登记一次审批等待（id 全局单调；跨 connection 唯一，前端以此回传）。
    pub fn register(&self) -> (i64, std::sync::mpsc::Receiver<bool>) {
        let id = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    /// 裁定回传（前端确认框按钮）：返回是否确有在途等待（过期/重复裁定幂等 false）。
    pub fn resolve(&self, id: i64, allow: bool) -> bool {
        let tx = self.pending.lock().unwrap().remove(&id);
        match tx {
            Some(tx) => tx.send(allow).is_ok(),
            None => false,
        }
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

/// `ottr://mcp-approval` 事件载荷（serde snake_case，前端 `McpApprovalAsk` 同构）。
#[derive(Clone, Serialize)]
pub struct McpApprovalAsk {
    pub request_id: i64,
    pub host_id: i64,
    pub host_name: String,
    pub command: String,
}

/// 审批门注入面（引擎不依赖 AppHandle——夹具/单测用脚本化门）。
pub trait ApprovalGate: Send + Sync {
    /// Ok(true/false) = 用户裁定；Err = 门不可用（超时/事件失败）→ 拒绝。
    fn request_exec_approval(
        &self,
        host_id: i64,
        host_name: &str,
        command: &str,
    ) -> Result<bool, String>;
}

/// 生产审批门：登记 → `ottr://mcp-approval` → 阻塞等 `mcp_approval_decision`
/// /超时。运行在 MCP 连接专属 std 线程上（阻塞只挂起本连接的请求处理，
/// 与 TOFU 问询「连接专属任务内等待」同一隔离思路）。
pub struct UiApprovalGate {
    pub app: AppHandle,
    pub approvals: Arc<McpApprovals>,
    pub timeout: Duration,
}

impl ApprovalGate for UiApprovalGate {
    fn request_exec_approval(
        &self,
        host_id: i64,
        host_name: &str,
        command: &str,
    ) -> Result<bool, String> {
        let (id, rx) = self.approvals.register();
        let ask = McpApprovalAsk {
            request_id: id,
            host_id,
            host_name: host_name.to_string(),
            command: command.to_string(),
        };
        if let Err(e) = self.app.emit("ottr://mcp-approval", &ask) {
            self.approvals.resolve(id, false);
            return Err(format!("approval prompt unavailable: {e}"));
        }
        wait_decision(&self.approvals, id, rx, self.timeout)
    }
}

/// 等待前端裁定（纯逻辑段，无 AppHandle 可测）：超时/通道断 = 拒绝 + 摘除
/// 陈旧条目。运行在 MCP 连接专属 std 线程上（阻塞只挂起本连接的请求处理）。
pub(super) fn wait_decision(
    approvals: &McpApprovals,
    id: i64,
    rx: std::sync::mpsc::Receiver<bool>,
    timeout: Duration,
) -> Result<bool, String> {
    match rx.recv_timeout(timeout) {
        Ok(v) => Ok(v),
        Err(_) => {
            approvals.resolve(id, false); // 摘除陈旧条目
            Err(format!(
                "approval timed out after {}s (denied)",
                timeout.as_secs()
            ))
        }
    }
}
