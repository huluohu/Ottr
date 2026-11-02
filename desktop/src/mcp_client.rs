//! MCP 客户端协议核（Ottr 作为 **MCP 客户端**——连接外部 MCP server）。
//!
//! 与 [`crate::mcp`]（Ottr 作为 MCP **server** 的协议核）严格对偶：
//! * [`crate::mcp`]：行分隔 JSON **入** → 一行 JSON 出（服务端消息核，纯协议层）；
//! * 本模块：行分隔 JSON **出**（请求）→ 行分隔 JSON 入（响应，按 id 配对）。
//!
//! 协议常量（[`PROTOCOL_VERSION`] / JSON-RPC 错误码 / 帧上限）**不复制一份**——
//! 一律从 `crate::mcp` 引用（两份常量必然漂移，漂移即两端握手失败）。
//!
//! 【传输面】仅 stdio（行分隔 JSON over 子进程 stdin/stdout）。HTTP/SSE
//! transport 不在本模块范围（见 docs/mcp.md 的已知限制）。子进程由用户配置的
//! `command` + `args` 拉起——**Ottr 不内置任何 MCP server**。
//!
//! 【并发安全】请求按 **id 配对**：一个 `Mutex<HashMap<u64, oneshot::Sender>>`
//! 登记在途请求，一个后台读循环把响应按 id 分发回各自的 oneshot——多个并发
//! 调用不会串台（响应乱序到达也各自归位）。
//!
//! 【纪律（各条都有单测钉死）】
//! * **超时**：每个请求 30s 上限（[`REQUEST_TIMEOUT`]），超时返回明确错误，
//!   **不无限等**（子进程半死不活时 UI 必须能拿到失败，而不是转圈）。
//! * **帧上限**：单行 JSON 超过 [`MAX_FRAME_BYTES`]（1 MiB，与 server 侧同量级）
//!   → 报错并断开；读侧**有界缓冲**（绝不 `read_to_end` 一把梭）。
//! * **子进程退出** → 立即把死因（退出状态 + stderr 尾巴）回给所有在途请求，
//!   后续请求立刻失败（不静默挂起）。
//! * **stderr 不是协议**：协议只在 stdout；stderr 内容截断后并进错误消息，
//!   帮助用户排查（子进程的日志常是「为什么连不上」的唯一线索）。
//! * **最小环境**：子进程只继承白名单环境项（PATH/HOME/…）+ 用户显式配置的
//!   env——**不把 Ottr 进程的全部环境**（含任何机密）泄漏给外部子进程。
//!
//! 【生命周期】每次工具面操作（列工具 / 调工具）都是「起进程 → initialize →
//! 干活 → 收进程」的一次性会话（[`McpClient::spawn`] + [`McpClient::shutdown`]）——
//! 不常驻连接外部 server（常驻 = 外部进程生命周期不受 Ottr 控制，且 env 密钥
//! 长期驻留内存）。

use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::{Mutex, oneshot};
use tokio::time::{sleep, timeout};

use crate::mcp::{ERR_INTERNAL, MAX_FRAME_BYTES, PROTOCOL_VERSION};

/// 单个请求的等待上限（秒）。超时报错而非无限等（子进程半死时 UI 要拿到失败）。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// clientInfo.name（对端 server 看到的客户端名）。
pub const CLIENT_NAME: &str = "ottr";

/// stderr 尾巴保留上限（字节）：只留最近的一截（老日志对排障无用）。
const STDERR_TAIL_MAX: usize = 8 * 1024;
/// 并入错误消息的 stderr 尾巴上限（字符）：错误消息要短，截断到几百字节。
const STDERR_NOTE_MAX: usize = 300;
/// stderr 单行上限（字节）：超限即丢弃该行（stderr 是噪声面，不因一行超长
/// 而杀死连接——但**必须持续排空**，否则子进程写满 stderr 管道会挂住）。
const STDERR_LINE_MAX: usize = 64 * 1024;
/// 子进程退出轮询间隔（毫秒）。
const REAP_INTERVAL: Duration = Duration::from_millis(50);
/// stdout 关闭后等待退出码的宽限（毫秒）：给 reaper 记录退出状态的时间
/// （错误消息里带退出码比不带有用得多）。
const EXIT_STATUS_GRACE: Duration = Duration::from_millis(500);

/// 子进程环境白名单（**最小继承**）：只有这些系统项透传给外部 MCP server。
/// Ottr 进程的环境里可能有用户在其他工具里放的 API key/令牌——**一律不外泄**。
const ENV_ALLOWLIST: &[&str] = &[
    // unix 常规
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    // windows 常规
    "TEMP",
    "TMP",
    "SystemRoot",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "ProgramData",
    "ProgramFiles",
];

/// MCP 工具描述（tools/list 的一项）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpTool {
    /// 工具名（tools/call 的 name）。
    pub name: String,
    /// 工具描述（可能为空串）。
    pub description: String,
    /// inputSchema 的**原始 JSON 文本**（前端自行 pretty-print 或原样展示）。
    pub input_schema: String,
}

/// 工具调用结果（tools/call 的 result 归一）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpToolResult {
    /// 所有 text 内容块按顺序拼接（块间以换行分隔）；非 text 块以 `[<type>]`
    /// 占位（图片/资源等二进制内容在文本面里不可表达，占位比静默丢弃诚实）。
    pub text: String,
    /// 结果自带的 isError 标记（工具执行期失败 = 规范里的正常 result，不是协议错）。
    pub is_error: bool,
}

/// 客户端错误（统一为可读字符串——命令面直接回给 UI）。
pub type McpClientResult<T> = Result<T, String>;

/// 客户端连接状态（pending 表 / 死因 / stderr 尾巴）。后台任务与请求面共享。
struct State {
    /// 在途请求：id → 应答通道。
    pending: StdMutex<HashMap<u64, oneshot::Sender<McpClientResult<Value>>>>,
    /// 请求 id 分配器（单调递增；配对靠它，不靠到达顺序）。
    next_id: AtomicU64,
    /// 死因（None = 活着）：子进程退出 / 写失败 / 帧违规。
    dead: StdMutex<Option<String>>,
    /// 子进程退出状态（reaper 写入；错误消息引用它）。
    exit_status: StdMutex<Option<String>>,
    /// stderr 尾巴（字节；只留最近一截）。
    stderr_tail: StdMutex<Vec<u8>>,
}

impl State {
    fn new() -> Self {
        Self {
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            dead: StdMutex::new(None),
            exit_status: StdMutex::new(None),
            stderr_tail: StdMutex::new(Vec::new()),
        }
    }

    /// 当前死因（None = 活着）。
    fn dead_reason(&self) -> Option<String> {
        self.dead.lock().unwrap().clone()
    }

    /// 标记死亡并唤醒所有在途请求（首个死因为准——后续原因不覆盖首因）。
    fn mark_dead(&self, reason: String) {
        let reason = {
            let mut g = self.dead.lock().unwrap();
            if g.is_some() {
                return;
            }
            *g = Some(reason.clone());
            reason
        };
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(reason.clone()));
        }
    }

    /// 记录子进程退出状态（reaper 写入；stdout 侧据此给出更准的死因）。
    fn set_exit_status(&self, status: String) {
        let mut g = self.exit_status.lock().unwrap();
        if g.is_none() {
            *g = Some(status);
        }
    }

    /// 等退出码落地（宽限期内轮询；拿不到返回 None）。
    async fn wait_exit_status(&self, grace: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + grace;
        loop {
            if let Some(s) = self.exit_status.lock().unwrap().clone() {
                return Some(s);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            sleep(Duration::from_millis(10)).await;
        }
    }

    /// 追加 stderr 一行（保留最近 [`STDERR_TAIL_MAX`] 字节）。
    fn push_stderr(&self, line: &[u8]) {
        let mut g = self.stderr_tail.lock().unwrap();
        g.extend_from_slice(line);
        g.push(b'\n');
        if g.len() > STDERR_TAIL_MAX {
            let cut = g.len() - STDERR_TAIL_MAX;
            g.drain(..cut);
        }
    }

    /// stderr 尾巴（截断到 [`STDERR_NOTE_MAX`] 字符；空 = 无内容）。
    fn stderr_note(&self) -> String {
        let raw = self.stderr_tail.lock().unwrap().clone();
        let text = String::from_utf8_lossy(&raw);
        let text = text.trim();
        if text.is_empty() {
            return String::new();
        }
        let tail: String = text.chars().rev().take(STDERR_NOTE_MAX).collect();
        let tail: String = tail.chars().rev().collect();
        format!(" — stderr: {tail}")
    }
}

/// MCP 客户端（一次会话 = 一个子进程）。
pub struct McpClient {
    state: Arc<State>,
    /// 请求写入端（stdin）。Mutex 序列化写入——并发调用不得交叉写坏行。
    writer: Mutex<Option<Box<dyn AsyncWrite + Send + Unpin>>>,
    /// 停机旗标（reaper 轮询到即 kill 子进程）。
    kill: Arc<AtomicBool>,
    /// 单请求超时。
    timeout: Duration,
}

impl McpClient {
    /// 拉起子进程并建立协议通道（**一次性会话**：用完 [`Self::shutdown`] 收进程）。
    ///
    /// * `command` / `args`：用户配置的启动命令与参数（不经 shell——不拼串，
    ///   无 shell 注入面）。
    /// * `env`：用户为该 server 配置的环境变量（值来自 vault 密文面）——叠加在
    ///   最小继承环境之上（同名项以用户配置为准）。
    pub fn spawn(
        command: &str,
        args: &[String],
        env: &[(String, String)],
    ) -> McpClientResult<Self> {
        Self::spawn_with_timeout(command, args, env, REQUEST_TIMEOUT)
    }

    /// 同 [`Self::spawn`]，但可指定单请求超时（测试用短超时）。
    pub fn spawn_with_timeout(
        command: &str,
        args: &[String],
        env: &[(String, String)],
        timeout: Duration,
    ) -> McpClientResult<Self> {
        if command.trim().is_empty() {
            return Err("MCP server command must not be empty".into());
        }
        let mut cmd = build_command(command, args, env);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start MCP server '{command}': {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP server stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "MCP server stderr unavailable".to_string())?;

        let state = Arc::new(State::new());
        let kill = Arc::new(AtomicBool::new(false));
        let client = Self {
            state: Arc::clone(&state),
            writer: Mutex::new(Some(Box::new(stdin))),
            kill: Arc::clone(&kill),
            timeout,
        };
        spawn_task(read_loop(Box::new(stdout), Arc::clone(&state)));
        spawn_task(stderr_loop(Box::new(stderr), Arc::clone(&state)));
        spawn_task(reaper_loop(child, kill, Arc::clone(&state)));
        Ok(client)
    }

    /// 传输无关构造（测试夹具用：进程内内存管道当「子进程」）。
    /// 生产路径走 [`Self::spawn`]（真子进程 + 最小环境）。
    pub fn from_streams(
        writer: Box<dyn AsyncWrite + Send + Unpin>,
        reader: Box<dyn AsyncRead + Send + Unpin>,
        timeout: Duration,
    ) -> McpClientResult<Self> {
        let state = Arc::new(State::new());
        spawn_task(read_loop(reader, Arc::clone(&state)));
        Ok(Self {
            state,
            writer: Mutex::new(Some(writer)),
            kill: Arc::new(AtomicBool::new(false)),
            timeout,
        })
    }

    /// 初始化握手：`initialize` + `notifications/initialized`。
    /// 规范状态机要求 client 先 initialize 再调 tools/*——本方法未跑过时
    /// tools/list / tools/call 会被对端按 -32600 拒（与 server 侧同纪律）。
    pub async fn initialize(&self) -> McpClientResult<Value> {
        let result = self
            .request(
                "initialize",
                Some(json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
                })),
            )
            .await?;
        self.notify("notifications/initialized", None).await?;
        Ok(result)
    }

    /// 列工具（tools/list）。
    pub async fn list_tools(&self) -> McpClientResult<Vec<McpTool>> {
        let result = self.request("tools/list", None).await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| "tools/list result has no 'tools' array".to_string())?;
        Ok(tools
            .iter()
            .map(|t| McpTool {
                name: t
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                description: t
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input_schema: t
                    .get("inputSchema")
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            })
            .collect())
    }

    /// 调工具（tools/call）。`arguments` 必须是 JSON 对象（空对象 = 无参）。
    pub async fn call_tool(&self, name: &str, arguments: Value) -> McpClientResult<McpToolResult> {
        if !arguments.is_object() {
            return Err("tools/call arguments must be a JSON object".into());
        }
        let result = self
            .request(
                "tools/call",
                Some(json!({ "name": name, "arguments": arguments })),
            )
            .await?;
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut text = String::new();
        if let Some(content) = result.get("content").and_then(Value::as_array) {
            for block in content {
                let kind = block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                if !text.is_empty() {
                    text.push('\n');
                }
                if kind == "text" {
                    text.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""));
                } else {
                    // 非文本块（image/resource/audio…）在文本面不可表达——占位
                    // 标记类型，别静默丢弃（用户至少知道「这里有张图」）。
                    text.push_str(&format!("[{kind}]"));
                }
            }
        }
        Ok(McpToolResult { text, is_error })
    }

    /// 停机：结束子进程（幂等）。命令面每次操作后显式调用。
    pub fn shutdown(&self) {
        self.kill.store(true, Ordering::Relaxed);
    }

    /// 当前死因（None = 活着；诊断面用）。
    pub fn dead_reason(&self) -> Option<String> {
        self.state.dead_reason()
    }

    /// 发一个请求并等响应（按 id 配对）。
    async fn request(&self, method: &str, params: Option<Value>) -> McpClientResult<Value> {
        if let Some(reason) = self.state.dead_reason() {
            return Err(reason);
        }
        let id = self.state.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.state.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(p) = params {
            msg["params"] = p;
        }
        let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        line.push('\n');
        if let Err(e) = self.write_line(line.as_bytes()).await {
            self.state.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match timeout(self.timeout, rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => {
                self.state.pending.lock().unwrap().remove(&id);
                Err("MCP connection closed before the response arrived".into())
            }
            Err(_) => {
                self.state.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "MCP request '{method}' timed out after {:.1}s",
                    self.timeout.as_secs_f32()
                ))
            }
        }
    }

    /// 发一个 notification（无 id、不等响应）。
    async fn notify(&self, method: &str, params: Option<Value>) -> McpClientResult<()> {
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(p) = params {
            msg["params"] = p;
        }
        let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        line.push('\n');
        self.write_line(line.as_bytes()).await
    }

    /// 写一行到对端（失败即标记死亡——写失败意味着管道已断）。
    async fn write_line(&self, bytes: &[u8]) -> McpClientResult<()> {
        let mut guard = self.writer.lock().await;
        let Some(w) = guard.as_mut() else {
            return Err("MCP client is closed".into());
        };
        if let Err(e) = w.write_all(bytes).await {
            let reason = format!(
                "failed to write to the MCP server: {e}{}",
                self.state.stderr_note()
            );
            self.state.mark_dead(reason.clone());
            return Err(reason);
        }
        if let Err(e) = w.flush().await {
            let reason = format!(
                "failed to flush to the MCP server: {e}{}",
                self.state.stderr_note()
            );
            self.state.mark_dead(reason.clone());
            return Err(reason);
        }
        Ok(())
    }
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("timeout", &self.timeout)
            .field("dead", &self.state.dead_reason())
            .finish()
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // 客户端被丢弃 → 子进程随之收场（reaper 轮询到旗标即 kill）。
        self.kill.store(true, Ordering::Relaxed);
    }
}

/// 构造子进程命令（**最小环境**在此收口）。
///
/// 关键动作是 `env_clear()`：先把 Ottr 进程的环境**整个清空**，再按
/// 白名单（PATH/HOME/…）+ 用户显式配置的 env 重建——外部 MCP server 拿不到
/// Ottr 进程里的任何其他环境项（含别的工具留下的令牌）。
fn build_command(
    command: &str,
    args: &[String],
    env: &[(String, String)],
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 客户端被丢弃时子进程随之收场（不留守在用户机器上的孤儿进程）。
        .kill_on_drop(true)
        .env_clear();
    for (k, v) in minimal_env() {
        cmd.env(k, v);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

/// 后台任务派发：优先当前 tokio 上下文（测试/嵌入调用），否则借 Tauri 的
/// 异步运行时（Tauri 命令面即走此路——命令 future 由 Tauri 的 tokio 运行时
/// 驱动，句柄始终在场；兜底分支保证「无当前上下文」时也不至于 panic）。
fn spawn_task<F>(f: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(f);
        }
        Err(_) => {
            tauri::async_runtime::spawn(f);
        }
    }
}

/// 子进程最小继承环境（白名单项 + 现值）。
fn minimal_env() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ENV_ALLOWLIST {
        if let Ok(v) = std::env::var(key)
            && !v.is_empty()
        {
            out.push(((*key).to_string(), v));
        }
    }
    out
}

/// 读循环：按行读 stdout → 解析 JSON-RPC 响应 → 按 id 分发。
async fn read_loop(mut reader: Box<dyn AsyncRead + Send + Unpin>, state: Arc<State>) {
    loop {
        match read_line_capped(&mut reader, MAX_FRAME_BYTES).await {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<Value>(&line) {
                    Ok(v) => dispatch_response(&state, v),
                    Err(e) => {
                        // 非 JSON 行 = 协议噪声（对端把 banner 打到 stdout 是常见
                        // 事故）。**不杀死连接**：跳过该行继续读（协议只认 JSON 行）。
                        let note = format!("ignored non-JSON line from MCP server: {e}");
                        state.push_stderr(note.as_bytes());
                    }
                }
            }
            Ok(None) => {
                // stdout EOF：子进程多半已退出——等一小会儿拿退出码再定性。
                let status = state.wait_exit_status(EXIT_STATUS_GRACE).await;
                let reason = match status {
                    Some(s) => format!("MCP server exited ({s})"),
                    None => "MCP server closed its output stream".to_string(),
                };
                state.mark_dead(format!("{reason}{}", state.stderr_note()));
                return;
            }
            Err(e) => {
                state.mark_dead(format!("MCP protocol error: {e}{}", state.stderr_note()));
                return;
            }
        }
    }
}

/// stderr 排空循环：**必须持续读**（否则子进程写满 stderr 管道会挂住——
/// 这是 stdio 传输最经典的死锁面）。stderr 不是协议，只留尾巴供排障。
async fn stderr_loop(mut reader: Box<dyn AsyncRead + Send + Unpin>, state: Arc<State>) {
    loop {
        match read_line_capped(&mut reader, STDERR_LINE_MAX).await {
            Ok(Some(line)) => state.push_stderr(&line),
            Ok(None) => return,
            Err(_) => {
                // 超长行已被丢弃且流已复位到行边界——**继续排空**（不能因一行
                // 超长就停止读 stderr：那就回到了「写满管道挂住子进程」的坑）。
                continue;
            }
        }
    }
}

/// 子进程看护循环：轮询退出状态（写进 State，供错误消息引用）+ 执行停机 kill。
async fn reaper_loop(mut child: Child, kill: Arc<AtomicBool>, state: Arc<State>) {
    loop {
        if kill.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            state.mark_dead("MCP server stopped".into());
            return;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                state.set_exit_status(status.to_string());
                state.mark_dead(format!(
                    "MCP server exited ({status}){}",
                    state.stderr_note()
                ));
                return;
            }
            Ok(None) => {}
            Err(e) => {
                state.mark_dead(format!("MCP server wait failed: {e}"));
                return;
            }
        }
        sleep(REAP_INTERVAL).await;
    }
}

/// JSON-RPC 响应按 id 分发到在途请求（无 id = 对端的请求/通知——本客户端
/// 不支持 server→client 请求，忽略即可）。
fn dispatch_response(state: &State, v: Value) {
    let Some(id) = v.get("id").and_then(Value::as_u64) else {
        return;
    };
    let outcome: McpClientResult<Value> = if let Some(err) = v.get("error") {
        let code = err
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or(ERR_INTERNAL);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        Err(format!("MCP error {code}: {message}"))
    } else if let Some(result) = v.get("result") {
        Ok(result.clone())
    } else {
        Err(format!(
            "malformed MCP response (neither result nor error), code {ERR_INTERNAL}"
        ))
    };
    let sender = state.pending.lock().unwrap().remove(&id);
    if let Some(tx) = sender {
        let _ = tx.send(outcome);
    }
}

/// 读一行（不含换行）。**有界缓冲**：超过 `max` 字节即丢弃该行剩余部分并
/// 返回错误——绝不无界累积（防御对端失控的超长行）。
///
/// 返回：`Ok(Some(line))` = 一行；`Ok(None)` = EOF；`Err` = 行超限/IO 错误。
async fn read_line_capped<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            // EOF：残留字节视为最后一行（无换行结尾）。
            return if buf.is_empty() {
                Ok(None)
            } else {
                Ok(Some(buf))
            };
        }
        if let Some(pos) = chunk[..n].iter().position(|&b| b == b'\n') {
            let piece = &chunk[..pos];
            if buf.len() + piece.len() > max {
                return Err(frame_too_large());
            }
            buf.extend_from_slice(piece);
            // 去掉行尾 \r（CRLF 容错）。
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(buf));
        }
        if buf.len() + n > max {
            // 超限：把本行剩余部分排空（流复位到行边界），再报错。
            discard_rest_of_line(reader).await?;
            return Err(frame_too_large());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// 丢弃当前行的剩余字节（直到换行或 EOF）——超限行的流复位。
async fn discard_rest_of_line<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<()> {
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        if chunk[..n].contains(&b'\n') {
            return Ok(());
        }
    }
}

fn frame_too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("frame exceeds the {MAX_FRAME_BYTES} byte limit"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::sync::mpsc;

    /// 测试用单向内存字节管道（写端 / 读端**分离**）。
    ///
    /// 为什么不直接用 `tokio::io::split(duplex)`：split 的读半边在 pending 读
    /// 期间**持着 BiLock**，会把写半边饿死——本客户端的读循环常年挂着读，
    /// 于是写请求永远发不出去（死锁）。这里用 mpsc 通道自建管道：读写互不
    /// 阻塞，且不碰 OS 端口（测试无网络副作用）。
    mod pipe {
        use super::*;

        /// 管道写端。
        pub struct PipeWriter {
            tx: mpsc::UnboundedSender<Vec<u8>>,
        }

        /// 管道读端（带残留缓冲）。
        pub struct PipeReader {
            rx: mpsc::UnboundedReceiver<Vec<u8>>,
            buf: Vec<u8>,
            pos: usize,
        }

        /// 造一条管道（写端, 读端）。
        pub fn pipe() -> (PipeWriter, PipeReader) {
            let (tx, rx) = mpsc::unbounded_channel();
            (
                PipeWriter { tx },
                PipeReader {
                    rx,
                    buf: Vec::new(),
                    pos: 0,
                },
            )
        }

        impl AsyncWrite for PipeWriter {
            fn poll_write(
                self: Pin<&mut Self>,
                _cx: &mut Context<'_>,
                buf: &[u8],
            ) -> Poll<io::Result<usize>> {
                let this = self.get_mut();
                if buf.is_empty() {
                    return Poll::Ready(Ok(0));
                }
                match this.tx.send(buf.to_vec()) {
                    Ok(()) => Poll::Ready(Ok(buf.len())),
                    Err(_) => Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "pipe closed",
                    ))),
                }
            }

            fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
                Poll::Ready(Ok(()))
            }

            fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
                Poll::Ready(Ok(()))
            }
        }

        impl AsyncRead for PipeReader {
            fn poll_read(
                self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                let this = self.get_mut();
                loop {
                    if this.pos < this.buf.len() {
                        let n = std::cmp::min(buf.remaining(), this.buf.len() - this.pos);
                        buf.put_slice(&this.buf[this.pos..this.pos + n]);
                        this.pos += n;
                        return Poll::Ready(Ok(()));
                    }
                    match this.rx.poll_recv(cx) {
                        Poll::Ready(Some(chunk)) => {
                            this.buf = chunk;
                            this.pos = 0;
                        }
                        Poll::Ready(None) => return Poll::Ready(Ok(())),
                        Poll::Pending => return Poll::Pending,
                    }
                }
            }
        }
    }

    /// 进程内 mock MCP server：读一行 → 应答一行（行分隔 JSON）。
    /// `handler` 收到请求 JSON，返回要写回的**完整响应行**（None = 不回）。
    async fn mock_server<R, W, F>(mut reader: R, mut writer: W, handler: F)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
        F: Fn(Value) -> Option<Value> + Send + 'static,
    {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = &line[..line.len() - 1];
                if line.is_empty() {
                    continue;
                }
                let req: Value = match serde_json::from_slice(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(resp) = handler(req) {
                    let mut out = serde_json::to_string(&resp).unwrap();
                    out.push('\n');
                    if writer.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                    let _ = writer.flush().await;
                }
            }
        }
    }

    /// 标准 mock：initialize / tools/list / tools/call 三方法齐活。
    fn standard_handler() -> impl Fn(Value) -> Option<Value> + Send + 'static {
        move |req: Value| {
            let id = req.get("id")?.clone(); // notification：无 id → 不回
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let result = match method {
                "initialize" => json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "mock", "version": "0" }
                }),
                "tools/list" => json!({
                    "tools": [
                        { "name": "echo", "description": "echo back",
                          "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } },
                        { "name": "boom", "description": "always fails" }
                    ]
                }),
                "tools/call" => {
                    let name = req["params"]["name"].as_str().unwrap_or("");
                    if name == "boom" {
                        json!({ "content": [ { "type": "text", "text": "kaboom" } ], "isError": true })
                    } else {
                        json!({ "content": [
                            { "type": "text", "text": req["params"]["arguments"]["text"].as_str().unwrap_or("") },
                            { "type": "image", "data": "..." }
                        ] })
                    }
                }
                _ => json!({}),
            };
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        }
    }

    /// 造一对内存管道（client 端 + mock 端）并接上 mock server 任务。
    fn client_with_mock<F>(handler: F, timeout: Duration) -> McpClient
    where
        F: Fn(Value) -> Option<Value> + Send + 'static,
    {
        let (client_writer, mock_reader) = pipe::pipe();
        let (mock_writer, client_reader) = pipe::pipe();
        tokio::spawn(mock_server(mock_reader, mock_writer, handler));
        McpClient::from_streams(Box::new(client_writer), Box::new(client_reader), timeout)
            .expect("client")
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    #[test]
    fn initialize_list_tools_and_call_tool_round_trip() {
        let rt = test_runtime();
        rt.block_on(async {
            let client = client_with_mock(standard_handler(), Duration::from_secs(5));
            let init = client.initialize().await.expect("initialize");
            assert_eq!(init["protocolVersion"], PROTOCOL_VERSION);
            assert_eq!(init["serverInfo"]["name"], "mock");

            let tools = client.list_tools().await.expect("tools/list");
            assert_eq!(tools.len(), 2);
            assert_eq!(tools[0].name, "echo");
            assert_eq!(tools[0].description, "echo back");
            assert!(
                tools[0].input_schema.contains("\"type\":\"object\""),
                "inputSchema 保留原始 JSON 文本: {}",
                tools[0].input_schema
            );

            let out = client
                .call_tool("echo", json!({ "text": "hi" }))
                .await
                .expect("tools/call");
            assert!(!out.is_error);
            assert_eq!(out.text, "hi\n[image]", "text 块拼接 + 非 text 块占位");
        });
    }

    #[test]
    fn tool_error_result_is_not_a_protocol_error() {
        let rt = test_runtime();
        rt.block_on(async {
            let client = client_with_mock(standard_handler(), Duration::from_secs(5));
            client.initialize().await.expect("initialize");
            let out = client
                .call_tool("boom", json!({}))
                .await
                .expect("tools/call");
            assert!(out.is_error, "isError 来自结果本身");
            assert_eq!(out.text, "kaboom");
        });
    }

    #[test]
    fn concurrent_requests_are_matched_by_id() {
        let rt = test_runtime();
        rt.block_on(async {
            // mock 对每个请求回一个带自身 id 的 result（并发在途时各自归位）。
            let handler = |req: Value| {
                let id = req.get("id")?.clone(); // notification：无 id → 不回
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                let result = if method == "tools/list" {
                    json!({ "tools": [] })
                } else {
                    json!({ "echo": id })
                };
                Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            };
            let client = Arc::new(client_with_mock(handler, Duration::from_secs(5)));
            let mut handles = Vec::new();
            for _ in 0..8 {
                let c = Arc::clone(&client);
                handles.push(tokio::spawn(async move { c.initialize().await }));
            }
            for h in handles {
                let v = h.await.expect("join").expect("initialize");
                assert!(v["echo"].is_number(), "响应按 id 归位: {v}");
            }
        });
    }

    #[test]
    fn timeout_is_reported_instead_of_hanging_forever() {
        let rt = test_runtime();
        rt.block_on(async {
            // mock 收到请求不回（半死不活的 server）。
            let client = client_with_mock(|_| None, Duration::from_millis(120));
            let err = client.initialize().await.expect_err("应超时");
            assert!(err.contains("timed out"), "{err}");
        });
    }

    #[test]
    fn oversized_frame_is_rejected_without_unbounded_buffering() {
        let rt = test_runtime();
        rt.block_on(async {
            let (client_writer, mock_reader) = pipe::pipe();
            let (mut mock_writer, client_reader) = pipe::pipe();
            // mock 写一个超长行（> 1 MiB）。
            tokio::spawn(async move {
                let big = vec![b'x'; MAX_FRAME_BYTES + 1024];
                let _ = mock_writer.write_all(&big).await;
                let _ = mock_writer.write_all(b"\n").await;
                let _ = mock_writer.flush().await;
                // 保持连接不立刻 EOF，让客户端先撞上行超限。
                tokio::time::sleep(Duration::from_secs(2)).await;
                drop(mock_reader);
            });
            let client = McpClient::from_streams(
                Box::new(client_writer),
                Box::new(client_reader),
                Duration::from_secs(5),
            )
            .expect("client");
            let err = client.initialize().await.expect_err("应报帧超限");
            assert!(err.contains("frame exceeds"), "{err}");
        });
    }

    #[test]
    fn non_json_noise_line_is_skipped_and_connection_survives() {
        let rt = test_runtime();
        rt.block_on(async {
            let (client_writer, mut mock_reader) = pipe::pipe();
            let (mut mock_writer, client_reader) = pipe::pipe();
            tokio::spawn(async move {
                // 先吐一行 banner 噪声，再正常应答。
                let _ = mock_writer.write_all(b"Starting mock server v1\n").await;
                let _ = mock_writer.flush().await;
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(n) = mock_reader.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=pos).collect();
                        let Ok(req) = serde_json::from_slice::<Value>(&line[..line.len() - 1])
                        else {
                            continue;
                        };
                        let Some(id) = req.get("id").cloned() else {
                            continue;
                        };
                        let mut out = serde_json::to_string(
                            &json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true } }),
                        )
                        .unwrap();
                        out.push('\n');
                        if mock_writer.write_all(out.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = mock_writer.flush().await;
                    }
                }
            });
            let client = McpClient::from_streams(
                Box::new(client_writer),
                Box::new(client_reader),
                Duration::from_secs(5),
            )
            .expect("client");
            let v = client.initialize().await.expect("噪声行后仍应握手成功");
            assert_eq!(v["ok"], true);
        });
    }

    #[test]
    fn protocol_error_response_is_surfaced_with_code() {
        let rt = test_runtime();
        rt.block_on(async {
            let handler = |req: Value| {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "method not found" }
                }))
            };
            let client = client_with_mock(handler, Duration::from_secs(5));
            let err = client.initialize().await.expect_err("应回协议错误");
            assert!(err.contains("-32601"), "{err}");
            assert!(err.contains("method not found"), "{err}");
        });
    }

    /// 子进程早退：后续请求立即失败并说明原因（不静默挂起）。
    #[cfg(unix)]
    #[test]
    fn dead_child_fails_fast_with_reason() {
        let rt = test_runtime();
        rt.block_on(async {
            let client = McpClient::spawn_with_timeout(
                "sh",
                &["-c".to_string(), "exit 3".to_string()],
                &[],
                Duration::from_secs(5),
            )
            .expect("spawn");
            let err = client.initialize().await.expect_err("子进程已退");
            assert!(
                err.contains("exited") || err.contains("closed its output"),
                "死因可读: {err}"
            );
            // 后续请求立即失败（不等超时）。
            let err2 = client.list_tools().await.expect_err("后续请求立即失败");
            assert!(!err2.contains("timed out"), "{err2}");
        });
    }

    /// 子进程启动失败（命令不存在）→ 明确错误，不 panic。
    #[cfg(unix)]
    #[test]
    fn spawn_failure_is_reported() {
        let rt = test_runtime();
        rt.block_on(async {
            let err = McpClient::spawn_with_timeout(
                "ottr-no-such-mcp-server-binary",
                &[],
                &[],
                Duration::from_secs(1),
            )
            .expect_err("命令不存在应报错");
            assert!(err.contains("failed to start MCP server"), "{err}");
        });
    }

    /// 真子进程 + 最小环境：白名单项（PATH）透传，用户显式配置的 env 也透传。
    ///
    /// mock 先**等一行请求**再应答（否则它的输出可能早于客户端登记在途请求
    /// ——响应被丢弃，请求只能等到超时：竞态，不是协议问题）。
    #[cfg(unix)]
    #[test]
    fn child_env_is_minimal_and_carries_configured_vars() {
        let rt = test_runtime();
        rt.block_on(async {
            let client = McpClient::spawn_with_timeout(
                "sh",
                &[
                    "-c".to_string(),
                    // 收到一行请求 → 回一行 JSON（只回布尔，避免把 env 原值塞进 JSON）。
                    "while IFS= read -r line; do [ -n \"$PATH\" ] && p=true || p=false; [ -n \"$MY_TOKEN\" ] && k=true || k=false; printf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"hasPath\":%s,\"hasToken\":%s}}\\n' \"$p\" \"$k\"; done"
                        .to_string(),
                ],
                &[("MY_TOKEN".to_string(), "s3cret".to_string())],
                Duration::from_secs(10),
            )
            .expect("spawn");
            let v = client.initialize().await.expect("握手");
            assert_eq!(v["hasPath"], true, "PATH 应透传（最小环境仍可执行命令）: {v}");
            assert_eq!(v["hasToken"], true, "用户配置的 env 应透传: {v}");
        });
    }

    /// 最小环境只含白名单项（防「顺手把整个 env 传过去」的回归）。
    #[test]
    fn minimal_env_contains_only_allowlisted_keys() {
        for (k, _) in minimal_env() {
            assert!(
                ENV_ALLOWLIST.contains(&k.as_str()),
                "非白名单环境项不得透传: {k}"
            );
        }
    }

    /// 子进程环境的**白名单收口**（确定性断言，不依赖父进程有什么变量）：
    /// 传给子进程的环境项 ⊆ 白名单 ∪ 用户显式配置的项——其余一律不外泄。
    #[test]
    fn child_command_env_is_allowlist_plus_user_env() {
        let cmd = build_command(
            "echo",
            &["hi".to_string()],
            &[("MY_TOKEN".to_string(), "v".to_string())],
        );
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|s| s.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for (k, _) in &envs {
            assert!(
                ENV_ALLOWLIST.contains(&k.as_str()) || k == "MY_TOKEN",
                "非白名单、非用户配置的环境项不得透传: {k}"
            );
        }
        assert!(
            envs.iter()
                .any(|(k, v)| k == "MY_TOKEN" && v.as_deref() == Some("v")),
            "用户配置的 env 应透传: {envs:?}"
        );
    }
}
