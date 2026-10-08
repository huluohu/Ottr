//! MCP 命令域（Phase 4 Task 3，C1）：MCP stdio server 引擎 + 授权/审批命令面 +
//! UDS listener 装配。协议核在 crate::mcp（纯消息层），本模块是引擎宿主。
//!
//! # 形态裁定（简报两条路的选型论证，详见 task-3-report §2）
//!
//! **App 内引擎 + 薄 relay 子进程**：MCP 客户端（Claude Desktop）spawn
//! `ottr-mcp` relay（src/bin/ottr-mcp.rs，纯 std 字节管道）→ Unix domain
//! socket（app_data_dir/mcp.sock）→ 本引擎（协议分发 + 工具执行）。
//! 否决「独立进程直读 vault」：① 连接机制必须整 replicat（attach_host_session
//! 的凭据/TOFU 面与 UI 耦合，batch R-1/cron missed 同款「后台 attach 不做」
//! 裁定）；② 第二个二进制访问钥匙链 Master Key 会踩 macOS 27 + ad-hoc 签名
//! 的 securityd 交互路径（task-16x5 实录）；③ 逐次审批门在无 UI 的子进程里
//! 无从谈起——审批必然要回 App，独立进程形态自坍缩为本形态加一跳。
//!
//! # 工具面（三件；密钥面永不出 vault——硬约束）
//!
//! * `list_hosts`：**只**回 can_list 授权主机的元数据（id/名称/地址/端口/
//!   标签/分组/生产标记）——username/credential_id/notes 显式不进输出；
//! * `exec_command`：grant.can_exec + 锁定拒绝 + 在册会话（cron
//!   session_for_host 同款裁定：无会话不自动连）+ 可选逐次审批门 →
//!   exec 通道（batch 同款非 PTY 通道）；
//! * `read_file`：read_paths 目录白名单 → SFTP realpath 归一后前缀判定
//!   （符号链接/`..` 逃逸在远端 canonical 面收口）→ 大小护栏 → 读文本。
//!
//! # 默认拒（安全裁定 #2）
//!
//! 无 mcp_grants 行 = 该主机三件工具全不可达；mcp.enabled 关 = 引擎不监听，
//! relay 连接失败即退出。授权矩阵增删改走 cj_* 同款 `ensure_unlocked` 门卫
//! （配置面）；引擎执行期读授权走存储层（锁定时另有执行期拒绝门——主密码
//! 模式落锁 = MCP exec/read 一并停摆，授权面元数据 list 仍可读）。
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ottr_vault::{McpGrant, McpGrantInput, McpGrants, Settings, Vault};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::vault::{CmdResult, VaultState, ensure_unlocked};

/// UDS 文件名（app_data_dir 下；生产 listener 与设置页接入说明共用）。
pub const MCP_SOCKET_NAME: &str = "mcp.sock";
/// MCP 总开关（settings 明文面键；缺省关——安全侧）。
pub const SETTING_MCP_ENABLED: &str = "mcp.enabled";
mod approvals;
mod engine;
mod listener;

pub use approvals::{ApprovalGate, McpApprovals, UiApprovalGate};
pub use engine::{APPROVAL_TIMEOUT, EXEC_TIMEOUT, HostSessionResolver, McpEngine};
pub use listener::{ListenerHandle, spawn_listener};

// ---------------------------------------------------------------------------
// Tauri 装配面（Manager / 命令 / vault-ready 挂点）
// ---------------------------------------------------------------------------

/// MCP 引擎生命周期 owner（Builder 即 manage，同 VaultInit 形态——status
/// 命令在 vault 初始化窗口期也可安全调用）。
#[derive(Default)]
pub struct McpManager {
    approvals: Arc<McpApprovals>,
    listener: Mutex<Option<ListenerHandle>>,
}

impl McpManager {
    fn start(&self, engine: Arc<McpEngine>, socket_path: PathBuf) -> CmdResult<()> {
        self.stop();
        #[cfg(unix)]
        {
            let handle = spawn_listener(socket_path, engine)
                .map_err(|e| format!("mcp listener bind failed: {e}"))?;
            *self.listener.lock().unwrap() = Some(handle);
        }
        #[cfg(not(unix))]
        {
            let _ = (engine, socket_path);
            return Err(
                "MCP stdio relay requires a Unix domain socket; not supported on this platform yet"
                    .into(),
            );
        }
        Ok(())
    }

    fn stop(&self) {
        if let Some(h) = self.listener.lock().unwrap().take() {
            h.cancel.cancel();
            let _ = std::fs::remove_file(&h.socket_path);
            eprintln!("[mcp] listener stopped (socket removed)");
        }
    }

    fn socket(&self) -> Option<PathBuf> {
        self.listener
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| h.socket_path.clone())
    }
}

/// socket 绝对路径（app_data_dir/mcp.sock；设置页接入说明与 listener 共用）。
pub fn socket_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join(MCP_SOCKET_NAME))
}

/// `mcp.enabled` settings 现读（缺省关——安全侧；坏值收敛关）。
pub fn enabled_from(raw: Option<&serde_json::Value>) -> bool {
    raw.and_then(|v| v.as_bool()).unwrap_or(false)
}

fn setting_enabled(vault: &Vault) -> bool {
    enabled_from(
        Settings::get(vault, SETTING_MCP_ENABLED)
            .unwrap_or(None)
            .as_ref(),
    )
}

/// 构造生产引擎（vault + 会话表解析 + UI 审批门 + tauri async runtime 桥）。
fn production_engine(app: &AppHandle, vault: &VaultState) -> Arc<McpEngine> {
    let approvals = Arc::clone(&app.state::<McpManager>().approvals);
    let resolver_app = app.clone();
    let sessions: HostSessionResolver =
        Arc::new(move |host_id| super::cron::session_for_host(&resolver_app, host_id));
    Arc::new(McpEngine {
        vault: Arc::clone(&vault.0),
        sessions,
        gate: Arc::new(UiApprovalGate {
            app: app.clone(),
            approvals,
            timeout: APPROVAL_TIMEOUT,
        }),
        rt: tauri::async_runtime::handle().inner().clone(),
        exec_timeout: EXEC_TIMEOUT,
    })
}

/// vault 就绪挂点（lib.rs，cron 调度器同款位置）：开关开着则起 listener。
pub fn on_vault_ready(app: &AppHandle) {
    let Some(vault) = app.try_state::<VaultState>() else {
        return;
    };
    if !setting_enabled(&vault.0) {
        return;
    }
    if let Err(e) = start_listener(app, &vault) {
        eprintln!("[mcp] auto-start on vault-ready failed: {e}");
    }
}

fn start_listener(app: &AppHandle, vault: &VaultState) -> CmdResult<()> {
    let path = socket_path(app)?;
    let engine = production_engine(app, vault);
    app.state::<McpManager>().start(engine, path)
}

/// MCP 状态快照（设置页首屏：开关/socket/在途审批/授权数）。
#[derive(Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub listening: bool,
    pub socket_path: Option<String>,
    pub approvals_pending: usize,
    pub grants_count: usize,
}

#[tauri::command]
pub(crate) fn mcp_status(app: AppHandle, state: State<'_, VaultState>) -> CmdResult<McpStatus> {
    let manager = app.state::<McpManager>();
    let socket = manager.socket();
    Ok(McpStatus {
        enabled: setting_enabled(&state.0),
        listening: socket.is_some(),
        socket_path: socket.map(|p| p.to_string_lossy().into_owned()),
        approvals_pending: manager.approvals.pending_count(),
        grants_count: McpGrants::list(&state.0).unwrap_or_default().len(),
    })
}

/// 总开关：持久化 settings + 起/停 listener（改设即生效，无需重启）。
#[tauri::command]
pub(crate) fn mcp_set_enabled(
    app: AppHandle,
    state: State<'_, VaultState>,
    enabled: bool,
) -> CmdResult<McpStatus> {
    crate::security::validate_setting(SETTING_MCP_ENABLED, &serde_json::json!(enabled))?;
    Settings::set(&state.0, SETTING_MCP_ENABLED, &serde_json::json!(enabled))
        .map_err(|e| e.to_string())?;
    {
        let manager = app.state::<McpManager>();
        if enabled {
            start_listener(&app, &state)?;
        } else {
            manager.stop();
        }
    }
    mcp_status(app, state)
}

// --- 授权矩阵命令面（配置面，过锁定门卫——cj_* 同款） ------------------------

#[tauri::command]
pub(crate) fn mcp_grants_list(state: State<'_, VaultState>) -> CmdResult<Vec<McpGrant>> {
    ensure_unlocked(&state.0)?;
    McpGrants::list(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn mcp_grants_upsert(
    state: State<'_, VaultState>,
    input: McpGrantInput,
) -> CmdResult<McpGrant> {
    ensure_unlocked(&state.0)?;
    McpGrants::upsert(&state.0, &input).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn mcp_grants_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    McpGrants::delete(&state.0, id).map_err(|e| e.to_string())
}

/// 审批裁定回传（前端确认框按钮）：返回是否确有在途等待。
#[tauri::command]
pub(crate) fn mcp_approval_decision(
    app: AppHandle,
    request_id: i64,
    allow: bool,
) -> CmdResult<bool> {
    Ok(app
        .state::<McpManager>()
        .approvals
        .resolve(request_id, allow))
}

#[cfg(test)]
mod tests {
    use super::approvals::wait_decision;
    use super::engine::{COMMAND_MAX_BYTES, OUTPUT_MAX_BYTES, cap_output, path_within};
    use super::*;
    use crate::mcp::{TOOL_EXEC_COMMAND, TOOL_LIST_HOSTS, TOOL_READ_FILE, ToolError, ToolHandler};
    use ottr_vault::master_key::InMemoryStorage;
    use ottr_vault::{HostInput, Hosts};
    use std::collections::VecDeque;
    use std::io::{BufRead, Write};
    use std::time::Duration;
    // McpApprovalAsk 序列化面测试若在，super::* 已覆盖；此处不再单列。

    // --- 测试具柄 -----------------------------------------------------------

    fn open_vault(dir: &std::path::Path) -> Vault {
        Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
    }

    fn host(vault: &Vault, name: &str, address: &str) -> i64 {
        Hosts::create(
            vault,
            HostInput {
                protocol: Default::default(),
                name: name.into(),
                group_id: None,
                tags: vec!["tag-a".into()],
                address: address.into(),
                port: 2222,
                username: Some("secret-user".into()),
                credential_id: None,
                jump_chain_id: None,
                encoding_override: None,
                theme_override: None,
                monitor_enabled: false,
                is_production: name == "prod",
                notes: Some("internal note".into()),
            },
        )
        .expect("create host")
        .id
    }

    fn grant(vault: &Vault, host_id: i64, can_list: bool, can_exec: bool) {
        McpGrants::upsert(
            vault,
            &McpGrantInput {
                host_id,
                can_list,
                can_exec,
                exec_approval: false,
                read_paths: vec!["/tmp".into()],
            },
        )
        .unwrap();
    }

    /// 脚本化审批门（记录请求 + 依序回放裁定）。
    struct ScriptGate {
        script: Mutex<VecDeque<Result<bool, String>>>,
        requests: Mutex<Vec<(i64, String, String)>>,
    }

    impl ScriptGate {
        fn allow() -> Arc<Self> {
            Self::of(Ok(true))
        }
        fn of(outcome: Result<bool, String>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(VecDeque::from(vec![outcome])),
                requests: Mutex::new(Vec::new()),
            })
        }
    }

    impl ApprovalGate for ScriptGate {
        fn request_exec_approval(
            &self,
            host_id: i64,
            host_name: &str,
            command: &str,
        ) -> Result<bool, String> {
            self.requests.lock().unwrap().push((
                host_id,
                host_name.to_string(),
                command.to_string(),
            ));
            self.script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err("gate exhausted".into()))
        }
    }

    fn engine_with(vault: Arc<Vault>, gate: Arc<dyn ApprovalGate>) -> McpEngine {
        McpEngine {
            vault,
            sessions: Arc::new(|_id| None), // 默认无会话（拒绝路径覆盖用）
            gate,
            rt: test_handle(),
            exec_timeout: EXEC_TIMEOUT,
        }
    }

    /// 测试共享 tokio Handle（拒绝路径不触达 block_on，但 Handle::current()
    /// 本身要求运行时在场——进程级懒建一个）。
    fn test_handle() -> tokio::runtime::Handle {
        static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
        RT.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("test runtime")
        })
        .handle()
        .clone()
    }

    fn call(e: &McpEngine, name: &str, args: serde_json::Value) -> Result<String, ToolError> {
        e.call_tool(name, &args)
    }

    // --- 权限矩阵（默认拒 / 授权通的前提面 / 审批门） -----------------------

    #[test]
    fn list_hosts_returns_only_granted_metadata_and_never_secret_face() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let visible = host(&vault, "web", "10.0.0.1");
        let exec_only = host(&vault, "exec-only", "10.0.0.2");
        let invisible = host(&vault, "hidden", "10.0.0.3");
        grant(&vault, visible, true, true);
        grant(&vault, exec_only, false, true); // 只授 exec：list 不可见
        let _ = invisible; // 无授权行：全不可见
        let e = engine_with(Arc::clone(&vault), ScriptGate::allow());
        let out = call(&e, TOOL_LIST_HOSTS, serde_json::json!({})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let rows = v.as_array().unwrap();
        assert_eq!(rows.len(), 1, "can_list 才可见: {out}");
        let row = &rows[0];
        assert_eq!(row["id"], visible);
        assert_eq!(row["name"], "web");
        assert_eq!(row["address"], "10.0.0.1");
        assert_eq!(row["port"], 2222);
        assert!(row.get("username").is_none(), "username 不出工具面: {out}");
        assert!(
            row.get("credential_id").is_none() && row.get("notes").is_none(),
            "凭据/备注面不出工具面: {out}"
        );
    }

    #[test]
    fn exec_denied_without_grant_or_exec_bit() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let ungranted = host(&vault, "a", "10.0.0.1");
        let list_only = host(&vault, "b", "10.0.0.2");
        grant(&vault, list_only, true, false);
        let gate = ScriptGate::allow();
        let e = engine_with(
            Arc::clone(&vault),
            Arc::clone(&gate) as Arc<dyn ApprovalGate>,
        );
        for (host_id, why) in [
            (ungranted, "无授权行"),
            (list_only, "只授 list"),
            (9999, "主机不存在"),
        ] {
            let err = call(
                &e,
                TOOL_EXEC_COMMAND,
                serde_json::json!({"host_id": host_id, "command": "whoami"}),
            )
            .unwrap_err();
            assert!(matches!(err, ToolError::Execution(_)), "{why}: {err:?}");
            assert!(
                matches!(&err, ToolError::Execution(m) if m.contains("not exposed") || m.contains("not granted") || m.contains("not found")),
                "{why} 的拒绝措辞应可读: {err:?}"
            );
        }
        // 审批门全程未被触达（拒绝发生在门之前）——真实记账断言（fix 1/5 M-4：
        // 恒真占位断言删除）。
        assert!(
            gate.requests.lock().unwrap().is_empty(),
            "授权/存在性拒绝不得消耗审批门: {:?}",
            gate.requests.lock().unwrap()
        );
    }

    #[test]
    fn exec_denied_when_no_live_session_or_vault_locked() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let host_id = host(&vault, "a", "10.0.0.1");
        grant(&vault, host_id, true, true);
        let e = engine_with(Arc::clone(&vault), ScriptGate::allow());
        let err = call(
            &e,
            TOOL_EXEC_COMMAND,
            serde_json::json!({"host_id": host_id, "command": "whoami"}),
        )
        .unwrap_err();
        assert!(
            matches!(&err, ToolError::Execution(m) if m.contains("no live session")),
            "无在册会话拒绝（不自动连接）: {err:?}"
        );

        // 主密码模式锁定态：同授权同会话面 → 锁定拒绝（落锁 = MCP exec 停摆）。
        let dir2 = tempfile::tempdir().unwrap();
        let locked = Vault::open_password_only(dir2.path()).unwrap();
        assert!(locked.is_locked());
        let hid = host(&locked, "a", "10.0.0.1");
        grant(&locked, hid, true, true);
        let e2 = engine_with(Arc::new(locked), ScriptGate::allow());
        let err = call(
            &e2,
            TOOL_EXEC_COMMAND,
            serde_json::json!({"host_id": hid, "command": "whoami"}),
        )
        .unwrap_err();
        assert!(
            matches!(&err, ToolError::Execution(m) if m.contains("locked")),
            "锁定拒绝: {err:?}"
        );
    }

    #[test]
    fn exec_approval_gate_denies_and_records_request() {
        // 门是独立段（pass_gate）：SshSession 具体类型无法 mock，门与执行
        // 拆开后门逻辑无需真会话（真执行链在夹具 E2E 覆盖）。
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let _host_id = host(&vault, "prod", "10.0.0.9");
        let gate = ScriptGate::of(Ok(false)); // 用户在 UI 点了拒绝
        let e = engine_with(
            Arc::clone(&vault),
            Arc::clone(&gate) as Arc<dyn ApprovalGate>,
        );
        let err = e.pass_gate(7, "prod", "reboot").unwrap_err();
        assert!(
            matches!(&err, ToolError::Execution(m) if m.contains("denied by user")),
            "审批拒绝: {err:?}"
        );
        // 门收到的请求带主机名 + 命令原文（UI 确认框的展示面）。
        assert_eq!(
            *gate.requests.lock().unwrap(),
            vec![(7, "prod".to_string(), "reboot".to_string())]
        );

        // 门不可用（超时 Err）→ 一律拒绝；门放行 → Ok（不触达执行）。
        let gate_err = ScriptGate::of(Err("approval timed out".into()));
        let e2 = engine_with(Arc::clone(&vault), gate_err);
        let err = e2.pass_gate(7, "prod", "reboot").unwrap_err();
        assert!(matches!(&err, ToolError::Execution(m) if m.contains("timed out")));
        let gate_ok = ScriptGate::of(Ok(true));
        let e3 = engine_with(vault, gate_ok);
        assert!(e3.pass_gate(7, "prod", "reboot").is_ok());
    }

    #[test]
    fn exec_args_shape_validation() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let e = engine_with(vault, ScriptGate::allow());
        // 形状检查（parse 层）先于授权检查——host 1 无授权也回 InvalidParams。
        for args in [
            serde_json::json!({}),                            // 缺 host_id
            serde_json::json!({"host_id": "1"}),              // 类型错
            serde_json::json!({"host_id": 1}),                // 缺 command
            serde_json::json!({"host_id": 1, "command": ""}), // 空命令
            serde_json::json!({"host_id": 1, "command": "x".repeat(COMMAND_MAX_BYTES + 1)}), // 超限
        ] {
            let err = call(&e, TOOL_EXEC_COMMAND, args).unwrap_err();
            assert!(matches!(err, ToolError::InvalidParams(_)), "{err:?}");
        }
    }

    #[test]
    fn read_file_local_prefilter_and_whitelist_gate() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let host_id = host(&vault, "a", "10.0.0.1");
        grant(&vault, host_id, true, false); // read_paths = ["/tmp"]
        let e = engine_with(vault, ScriptGate::allow());
        // 形状拒绝（协议级 InvalidParams）。
        for path in ["", "relative/x", "/a/../etc/passwd", "/with\0nul"] {
            let err = call(
                &e,
                TOOL_READ_FILE,
                serde_json::json!({"host_id": host_id, "path": path}),
            )
            .unwrap_err();
            assert!(
                matches!(err, ToolError::InvalidParams(_)),
                "{path:?}: {err:?}"
            );
        }
        // 无会话 → 执行错误（本地预检在连接前）。
        let err = call(
            &e,
            TOOL_READ_FILE,
            serde_json::json!({"host_id": host_id, "path": "/tmp/x"}),
        )
        .unwrap_err();
        assert!(matches!(&err, ToolError::Execution(m) if m.contains("no live session")));
    }

    #[test]
    fn read_file_denied_when_whitelist_empty_or_vault_locked() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let host_id = host(&vault, "a", "10.0.0.1");
        McpGrants::upsert(
            &vault,
            &McpGrantInput {
                host_id,
                can_list: true,
                can_exec: false,
                exec_approval: false,
                read_paths: vec![], // 白名单空 = read 一律拒
            },
        )
        .unwrap();
        let e = engine_with(vault, ScriptGate::allow());
        let err = call(
            &e,
            TOOL_READ_FILE,
            serde_json::json!({"host_id": host_id, "path": "/tmp/x"}),
        )
        .unwrap_err();
        assert!(matches!(&err, ToolError::Execution(m) if m.contains("whitelist")));

        let dir2 = tempfile::tempdir().unwrap();
        let locked = Vault::open_password_only(dir2.path()).unwrap();
        let hid = host(&locked, "a", "10.0.0.1");
        McpGrants::upsert(
            &locked,
            &McpGrantInput {
                host_id: hid,
                can_list: true,
                can_exec: false,
                exec_approval: false,
                read_paths: vec!["/tmp".into()],
            },
        )
        .unwrap();
        let e2 = engine_with(Arc::new(locked), ScriptGate::allow());
        let err = call(
            &e2,
            TOOL_READ_FILE,
            serde_json::json!({"host_id": hid, "path": "/tmp/x"}),
        )
        .unwrap_err();
        assert!(matches!(&err, ToolError::Execution(m) if m.contains("locked")));
    }

    #[test]
    fn unknown_tool_maps_to_unknown_tool_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let e = engine_with(vault, ScriptGate::allow());
        let err = call(&e, "write_file", serde_json::json!({})).unwrap_err();
        assert!(matches!(err, ToolError::UnknownTool(_)));
    }

    // --- 纯函数面 -----------------------------------------------------------

    #[test]
    fn path_within_matches_directory_boundary_exactly() {
        assert!(path_within("/tmp/a.txt", "/tmp"));
        assert!(path_within("/tmp", "/tmp"));
        assert!(path_within("/tmp/deep/x", "/tmp"));
        assert!(!path_within("/tmp2/a", "/tmp"), "路径段边界精确匹配");
        assert!(!path_within("/tmpx", "/tmp"));
        assert!(path_within("/anything", "/"), "根白名单 = 全盘");
        assert!(!path_within("/etc/passwd", "/var/log"));
    }

    #[test]
    fn cap_output_marks_truncation_at_byte_cap() {
        let (s, t) = cap_output(b"hello");
        assert_eq!(s, "hello");
        assert!(!t);
        let big = vec![b'x'; OUTPUT_MAX_BYTES + 1];
        let (s, t) = cap_output(&big);
        assert!(t);
        assert_eq!(s.len(), OUTPUT_MAX_BYTES);
    }

    // --- 审批表 -------------------------------------------------------------

    #[test]
    fn approvals_register_resolve_and_stale_entry_cleanup() {
        let a = McpApprovals::default();
        let (id, rx) = a.register();
        assert_eq!(a.pending_count(), 1);
        assert!(!a.resolve(999, true), "未知 id 幂等 false");
        assert!(a.resolve(id, true));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)), Ok(true));
        assert_eq!(a.pending_count(), 0, "裁定后条目摘除");
        assert!(!a.resolve(id, false), "重复裁定幂等 false");
    }

    #[test]
    fn ui_gate_timeout_denies_and_cleans_pending() {
        // 无 AppHandle 的门超时面：登记后无人裁定 → wait_decision 超时拒绝
        // + 陈旧条目摘除（生产 UiApprovalGate 的 emit 后半段即此函数）。
        let approvals = McpApprovals::default();
        let (id, rx) = approvals.register();
        let r = wait_decision(&approvals, id, rx, Duration::from_millis(30));
        assert!(r.is_err(), "无人裁定 → 超时拒绝");
        assert!(r.unwrap_err().contains("timed out"));
        assert_eq!(approvals.pending_count(), 0, "超时摘除陈旧条目");

        // 正常路径对照：先裁定后等待 → Ok(true)。
        let approvals = McpApprovals::default();
        let (id2, rx2) = approvals.register();
        assert!(approvals.resolve(id2, true));
        assert_eq!(
            wait_decision(&approvals, id2, rx2, Duration::from_secs(1)),
            Ok(true)
        );
    }

    // --- listener 进程内环回（无夹具的最小 E2E：UDS + relay 式客户端）--------

    #[test]
    fn listener_serves_protocol_over_uds() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let host_id = host(&vault, "web", "10.0.0.1");
        grant(&vault, host_id, true, false);
        let engine = Arc::new(engine_with(Arc::clone(&vault), ScriptGate::allow()));
        let sock = dir.path().join("mcp.sock");
        let handle = spawn_listener(sock.clone(), Arc::clone(&engine)).expect("bind");
        // 客户端：连接 → initialize → tools/call list_hosts（relay 的线协议形态）。
        let mut stream = loop {
            match std::os::unix::net::UnixStream::connect(&sock) {
                Ok(s) => break s,
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        stream
            .write_all(br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .unwrap();
        stream.write_all(b"\n").unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], crate::mcp::SERVER_NAME);

        stream
            .write_all(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream
            .write_all(
                br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_hosts","arguments":{}}}"#,
            )
            .unwrap();
        stream.write_all(b"\n").unwrap();
        line.clear();
        reader.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        let rows = v["result"]["content"][0]["text"].as_str().unwrap();
        let rows: serde_json::Value = serde_json::from_str(rows).unwrap();
        assert_eq!(rows[0]["id"], host_id);

        handle.cancel.cancel();
    }

    /// fix 1/5 I-1：socket 文件权限必须显式 0600——bind 落盘权限继承进程
    /// umask（022 下 0755；launchd 配 umask 000/002 时更宽），本测试在默认
    /// umask 下 0755 ≠ 0600 即已证明「chmod 是显式动作不是继承巧合」。
    #[cfg(unix)]
    #[test]
    fn listener_socket_file_is_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(open_vault(dir.path()));
        let engine = Arc::new(engine_with(vault, ScriptGate::allow()));
        let sock = dir.path().join("perm.sock");
        let handle = spawn_listener(sock.clone(), engine).expect("bind");
        let mode = std::fs::metadata(&sock)
            .expect("socket file exists")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "socket 必须属主独占: {:o}",
            mode & 0o777
        );
        handle.cancel.cancel();
    }
}
