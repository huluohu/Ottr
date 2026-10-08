// 会话管理（Phase 1 Task 7）：在 Phase 0 数据面（合批转发 + 二进制通道）之上
// 补全连接生命周期——
//   * `attach_host_session(host_id, …)`：vault 取主机/凭据（明文只在 Rust 侧解密，
//     前端永不接触），TOFU host key 策略（首连 pending 入库 + 事件问询前端确认，
//     changed 默认拒绝 + 显式接受才放行），传输层 keepalive 60s；
//   * `host_key_decision`：前端确认框的裁定回传（挂起的 connect 就地放行/拒绝）；
//   * `ottr://session-closed` 事件：连接自行断开（对端关闭/keepalive 超时）时
//     通知前端触发重连状态机（关标签的主动 drop 不需要前端反应）。
// `attach_session`（host/port/username/password 直传、指纹 pin）保留为 scripts/
// 驱动脚本的命令面（台账裁定）；UI 侧 ?spike= 页面随多标签重构删除。
//
// Task 7 字节账目：Rust 侧转发计数（forwarded_bytes/frames/input_bytes/writes/pty_read_bytes）
// + send 失败显式计数（send_failed_bytes/send_failed_frames/failed —— M-2 失败策略，
// flush_batch 文档）经 `session_stats` 可读；`OTTR_BATCH_DEBUG=1` 时逐批打 debug 日志。
mod commands;
pub mod hostkey_audit;
pub mod importers;
pub mod keys;
pub mod menu;
mod vibrancy;
// MCP 协议核（Phase 4 Task 3，C1）：纯 JSON-RPC/MCP 消息层（无 tauri/IO 依赖），
// 引擎装配与命令面在 commands/mcp.rs，stdio relay 子进程在 bin/ottr-mcp.rs。
pub mod mcp;
pub mod security;
pub mod ssh_config;
pub mod vault;

use std::sync::Arc;

use tauri::{Emitter, Manager};

// Task 0（BL-004）拆分装配：命令域在 commands/*（会话/传输/编码/spike），共享
// 状态核在 commands::state，lib.rs 回归薄装配（Global Constraint：lib.rs 只减
// 不增，Phase 2 新命令一律进 commands/ 对应域）。examples/驱动脚本与 menu.rs 的
// crate 根消费面（ottr_lib::{forward_pty_loop, SessionCounters, TextTail,
// SessionCloseReason, inject_shell_integration, ShellIntegrationOutcome} /
// crate::{AppState, disconnect_all_inner}）经一次 small re-export 保持原路径不变。
pub(crate) use commands::session::disconnect_all_inner;
pub use commands::session::{
    SessionCloseReason, ShellIntegrationOutcome, forward_pty_loop, inject_shell_integration,
};
pub(crate) use commands::state::AppState;
pub use commands::state::{SessionCounters, SessionResizeSlot, SessionStats, TextTail, snapshot};
// Phase 3 Task 6（B9）：指纹巡检面公开给夹具集成测试（tests/hostkey_fixture.rs：
// 真 ssh-keyscan 探测 → classify → mark_changed 全链）。
pub use hostkey_audit::{AuditOutcome, audit_once, keyscan_line_fingerprint, probe_endpoint};
// Phase 3 Task 5（B3）：录制面公开给夹具集成测试（tests/recording_fixture.rs
// 真容器全链：tee → auto-finalize → parse/FTS/export）与 example 直驱。
pub use commands::recording::{
    ExportEvent, RecorderSlot, RecordingHandle, auto_finalize_on_exit, export_recording,
    read_recording,
};
// Phase 2 Task 1（B7）：ForwardManager 公开给夹具集成测试（真容器断线恢复链）。
pub use commands::forward::ForwardManager;
// Phase 3 Task 4（B6）：批量执行池核公开给夹具集成测试（tests/batch_fixture.rs：
// 同容器双连 = 两主机，真 exec 通道跑并发池/超时）。
pub use commands::batch::{
    BatchResultEvent, BatchStatus, BatchTargetInput, ExecResolver, run_batch,
};
// Phase 2 Task 3（B10 上半）：远端编辑生命周期核公开给夹具集成测试
// （tests/remote_edit_fixture.rs：下载→编辑→回传→冲突→覆盖→清理全链）。
pub use commands::remote_edit::{
    EditEntry, EditMap, EditPollStatus, LocalDecision, LocalStamp, apply_save_bookkeeping,
    close_all_edits, edit_close, edit_close_session, edit_dismiss, edit_open, edit_poll, edit_save,
    local_stamp, poll_decision, sweep_stale_edits, temp_path_for, temp_root,
};
// Phase 4 Task 3（C1）：MCP 引擎核公开给夹具集成测试（tests/mcp_fixture.rs：
// relay 子进程 + UDS + 授权矩阵 + 真 exec/SFTP 全链）。spawn_listener 为
// cfg(unix) 面，随源门控（Windows 编译不含 UDS listener）。
#[cfg(unix)]
pub use commands::mcp::spawn_listener;
pub use commands::mcp::{ApprovalGate, HostSessionResolver, McpEngine};

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Task 11 / Spike #8：系统通知（macOS 首次调用触发系统授权）。
        .plugin(tauri_plugin_notification::init())
        // Phase 2 Task 4（B10 下半）：trzsz 传输文件/目录选择（原生对话框）。
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        // T11（A7）：自动锁定计时状态（失焦起 N 分钟计时，重聚焦作废；
        // Arc 共享给窗口事件闭包与 spawn 的计时任务）。
        .manage(Arc::new(security::AutoLockState::default()))
        // Phase 2 Task 4 Fix round 1（I-1）：trzsz 本地文件桥的会话级授权白名单
        // （授权只来自对话框/拖拽登记 trzsz_grant；七命令入口校验；scope=前端会话 id）。
        .manage(commands::trzsz_fs::TrzszGrants::default())
        // MCP server 生命周期 owner（Phase 4 Task 3，C1）：UDS listener 句柄 +
        // 审批登记表（Builder 即 manage——mcp_status 在 vault 初始化窗口可查）。
        .manage(commands::mcp::McpManager::default())
        // Task 16.5：vault 后台初始化状态（Builder 链上即 manage——无钥匙链
        // 访问零开销，`vault_init_status` 命令在初始化窗口期即可安全调用）。
        .manage(vault::VaultInit::default())
        .setup(|app| {
            // Task 5：vault 打开并托管（app_data_dir + 钥匙链 Master Key）。
            // T16 判别实验（task-16-report.md §3，Exp10/14 阳性）：setup 主线程
            // 的钥匙链 SecItem 访问在 macOS 27 + ad-hoc 每次重建签名（ACL 失配）
            // 场景触发 securityd 交互路径，把主窗 frame 归零（打包产物整体不可
            // 用）；Exp13 证明纯阻塞无害——元凶是钥匙链访问本身，不是「耗时」。
            // Task 16.5 修复：init 移到后台线程（完成后 manage VaultState → 置
            // Ready → 发 ottr://vault-ready；失败置 Failed 发
            // ottr://vault-init-failed）。前端就绪门（VaultInitGate）在 Ready 前
            // 不发首批 vault 命令；T11 锁定语义矩阵不变（Ready 后照旧
            // status 查询 → keyring 模式进主 UI / password 模式进 LockScreen）。
            // 竞态契约：线程内 manage 严格先于 Ready 置位与事件（见 vault.rs
            // VaultInit 文档），就绪后命令面与旧实现逐字等价。
            // 线程在本 setup 尾部（menu::setup 之后）才 spawn：vault-ready 会触发
            // 菜单/托盘文案重建（on_vault_ready），晚 spawn 消除「重建与初始构建
            // 并发」的窗口——init 的钥匙链访问本就不占 setup 主线程，先后无碍。

            // A10（Task 1）：系统主题监听。前端主通道是 matchMedia(prefers-color-scheme)
            // （src/theme/ThemeContext.tsx）；这里补 Rust 侧兜底推送 `ottr://system-theme`
            // （payload: "light"/"dark"）——Linux WebKitGTK 对系统明暗动态跟随不可靠，
            // 由窗口 ThemeChanged 事件兜底。初始值无需推送：前端挂载时读 matchMedia。
            // T11：同一挂点接 Focused → security::AutoLockState（失焦自动锁定计时）。
            if let Some(win) = app.get_webview_window("main") {
                // A12（Task 14）：Win/Linux 关原生装饰——前端自绘标题栏补壳
                // （src/titlebar/TitleBar.tsx：汉堡/拖拽区/min-max-close）。
                // macOS 保留原生装饰（红绿灯 + 系统菜单栏）。
                #[cfg(not(target_os = "macos"))]
                if let Err(e) = win.set_decorations(false) {
                    eprintln!("[setup] set_decorations(false) failed: {e}");
                }
                // theme-suite T3：主窗毛玻璃效果**常开**（macOS vibrancy /
                // Windows acrylic / Linux 跳过——平台分支见 vibrancy.rs）。
                // 非 Glass 主题画满不透明背景，效果不可见；Glass 主题的半透明
                // 面透出系统模糊。失败不阻断启动（增强面，alpha 兜底可读）。
                match vibrancy::apply_window_vibrancy(&win) {
                    Ok(effect) => eprintln!("[setup] window vibrancy: {} applied", effect.label()),
                    Err(e) => eprintln!("[setup] window vibrancy: {e}"),
                }
                let autolock: Arc<security::AutoLockState> =
                    app.state::<Arc<security::AutoLockState>>().inner().clone();
                let watcher = win.clone();
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::ThemeChanged(theme) => {
                            let _ = watcher.emit("ottr://system-theme", theme.to_string());
                        }
                        // T11 自动锁定：失焦起计时 / 重聚焦作废（generation 机制见
                        // security.rs）。keyring 模式 / 已锁定 / 配置关闭时 no-op。
                        tauri::WindowEvent::Focused(focused) => {
                            autolock.on_focus_changed(watcher.app_handle(), *focused);
                        }
                        // A12（Task 14）关窗到托盘：开关开（默认）→ 拦截关闭 +
                        // 隐藏主窗（会话保活）；托盘菜单/左键可恢复。
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            menu::on_close_requested(watcher.app_handle(), api);
                        }
                        _ => {}
                    }
                });
            }

            // A12（Task 14）：macOS 原生菜单 + 三端托盘 + 关窗到托盘设置面 +
            // 语言切换重建监听（menu.rs 模块文档）。失败即启动失败——菜单/托盘
            // 是 A12 的承诺面，静默缺失会让功能面漂移。
            menu::setup(app.handle())?;

            // vault 后台初始化（Task 16.5，见上注释）：setup 主线程不再触碰
            // 钥匙链——主窗创建/显示不被阻塞，frame 归零路径就此消除。
            {
                let handle = app.handle().clone();
                let tracker = app.state::<vault::VaultInit>().inner().clone();
                std::thread::Builder::new()
                    .name("vault-init".into())
                    .spawn(move || {
                        let t0 = std::time::Instant::now();
                        match vault::init(&handle) {
                            Ok(vault_state) => {
                                // 顺序即契约：先 manage（此后 State 可解析），
                                // 再置 Ready、再发事件（前端见 Ready 即 State 必在）。
                                handle.manage(vault_state);
                                tracker.set(vault::VaultInitStatus::Ready);
                                let _ = handle.emit("ottr://vault-ready", ());
                                eprintln!(
                                    "[vault] background init ok in {}ms",
                                    t0.elapsed().as_millis()
                                );
                                // B9 指纹巡检调度器（Phase 3 Task 6）：vault 就绪
                                // 后起 60s 心跳（开关默认关；内部自检
                                // try_state/锁定/间隔，见 hostkey_audit.rs）。
                                hostkey_audit::spawn_audit_scheduler(handle.clone());
                                // cron 定时任务调度器（Phase 4 Task 1，缺口①）：
                                // vault 就绪后起 20s 心跳对账循环——**引擎宿主裁定
                                // 落地点**：跑在 Rust 运行时、与 webview 生命周期
                                // 解耦（关窗到托盘照跑；真退出即停，语义见
                                // commands/cron.rs 模块文档）。
                                commands::cron::spawn_cron_scheduler(handle.clone());
                                // MCP stdio server（Phase 4 Task 3，C1）：开关开着
                                // 则起 UDS listener（引擎形态与授权模型见
                                // commands/mcp.rs 模块文档；默认关）。
                                commands::mcp::on_vault_ready(&handle);
                                // 初始菜单/托盘在 vault 就绪前以 En 兜底构建；
                                // 就绪后按 settings ui.language 真值重建纠偏。
                                menu::on_vault_ready(&handle);
                            }
                            Err(e) => {
                                tracker.set(vault::VaultInitStatus::Failed {
                                    error: e.to_string(),
                                });
                                let _ = handle.emit("ottr://vault-init-failed", e.to_string());
                                eprintln!("[vault] background init failed: {e}");
                            }
                        }
                    })
                    .expect("spawn vault-init thread");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::session::attach_session,
            commands::session::attach_host_session,
            // FTP/FTPS 文件会话（Phase 2 Task 5；命令域 commands/ftp.rs）
            commands::ftp::ftp_attach_host_session,
            commands::session::host_key_decision,
            commands::session::write_session,
            commands::encoding::set_session_encoding,
            commands::session::drop_session,
            commands::session::quit_app,
            menu::menu_set_theme,
            menu::menu_set_notify_count,
            commands::session::session_disconnect_all,
            commands::session::session_stats,
            commands::session::session_tail,
            // 端口转发中心（Phase 2 Task 1，B7 上半；命令域 commands/forward.rs）
            commands::forward::pf_list,
            commands::forward::pf_create,
            commands::forward::pf_update,
            commands::forward::pf_delete,
            commands::forward::pf_set_enabled,
            commands::forward::pf_start,
            commands::forward::pf_stop,
            // 跳板链（Phase 2 Task 2，B7 下半；命令域 commands/jump.rs）
            commands::jump::jc_list,
            commands::jump::jc_create,
            commands::jump::jc_update,
            commands::jump::jc_delete,
            commands::jump::jc_test,
            // 监控采集（Phase 3 Task 1，B4 上半；命令域 commands/monitor.rs）
            commands::monitor::monitor_start,
            commands::monitor::monitor_stop,
            // 进程浏览器（Phase 3 Task 2，B4 下半）：ps 只读采集 + kill（防注入）
            commands::monitor::monitor_ps,
            commands::monitor::monitor_kill,
            // 日志关键字采样（Phase 4 Task 2，缺口②）：stat+tail 只读复合命令
            commands::monitor::monitor_log_tail,
            // 批量执行（Phase 3 Task 4，B6；commands/batch.rs）：并发池 +
            // 单主机超时 + ottr://batch-result 逐主机结果事件
            commands::batch::batch_exec,
            commands::batch::batch_cancel,
            // 告警规则 + 通知渠道（Phase 3 Task 3，B5；vault 配置面，锁定即拒）
            vault::ar_list,
            vault::ar_create,
            vault::ar_update,
            vault::ar_delete,
            vault::ar_touch_fired,
            vault::nc_list,
            vault::nc_create,
            vault::nc_update,
            vault::nc_delete,
            vault::nc_reveal_config,
            // SMTP 渠道发送（Phase 3 Task 3，B5；commands/notify.rs，lettre）
            commands::notify::smtp_send,
            // cron 定时任务（Phase 4 Task 1，缺口①；commands/cron.rs）：
            // 配置面 CRUD 过锁定门卫，历史/输出读面明文豁免（notify 同款）
            commands::cron::cj_list,
            commands::cron::cj_create,
            commands::cron::cj_update,
            commands::cron::cj_delete,
            commands::cron::cj_runs,
            commands::cron::cj_trigger,
            commands::cron::cj_next_fire,
            commands::cron::cj_run_output,
            // MCP server（Phase 4 Task 3，C1；commands/mcp.rs）：状态/开关 +
            // 授权矩阵 CRUD（过锁定门卫）+ 逐次审批裁定回传
            commands::mcp::mcp_status,
            commands::mcp::mcp_set_enabled,
            commands::mcp::mcp_grants_list,
            commands::mcp::mcp_grants_upsert,
            commands::mcp::mcp_grants_delete,
            commands::mcp::mcp_approval_decision,
            // Task 13（AI BYOK）：secrets 密封 KV（provider api key）
            vault::secret_set,
            vault::secret_get,
            vault::secret_delete,
            vault::secret_contains,
            // Task 10（A5）：SFTP 文件面板 + 传输队列
            commands::transfer::sftp_list,
            commands::transfer::sftp_realpath,
            commands::transfer::sftp_mkdir,
            commands::transfer::sftp_rename,
            commands::transfer::sftp_remove,
            commands::transfer::sftp_chmod,
            commands::transfer::local_list,
            commands::transfer::local_home,
            commands::transfer::local_downloads_dir,
            commands::transfer::sftp_download,
            commands::transfer::sftp_upload,
            commands::transfer::transfer_cancel,
            // 远端文件本地编辑（Phase 2 Task 3，B10 上半；命令域 commands/remote_edit.rs）
            commands::remote_edit::remote_edit_open,
            commands::remote_edit::remote_edit_poll,
            commands::remote_edit::remote_edit_save,
            commands::remote_edit::remote_edit_dismiss,
            commands::remote_edit::remote_edit_close,
            // trzsz 本地文件桥（Phase 2 Task 4，B10 下半；命令域 commands/trzsz_fs.rs）
            // Fix round 1（I-1）：grant/revoke 是白名单生命周期（登记即整组替换 /
            // 传输收尾与会话关闭撤销）；七 fs 命令入口全部过白名单校验。
            commands::trzsz_fs::trzsz_grant,
            commands::trzsz_fs::trzsz_revoke,
            commands::trzsz_fs::trzsz_fs_stat,
            commands::trzsz_fs::trzsz_fs_read,
            commands::trzsz_fs::trzsz_fs_write,
            commands::trzsz_fs::trzsz_fs_list,
            commands::trzsz_fs::trzsz_fs_mkdir,
            commands::trzsz_fs::trzsz_fs_remove,
            commands::trzsz_fs::trzsz_fs_check,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_report_latency,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_probe_channel,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_log,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_keyring_set,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_keyring_get,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_keyring_del,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_notify,
            // spike 生产闸门（Task 0 Step 4，BL-002）：release 不注册不可达
            #[cfg(debug_assertions)]
            commands::spike::spike_report_file,
            // T11（A7）：安全底座——锁定状态机 / 主密码升级 / settings / 剪贴板
            vault::vault_security_status,
            vault::vault_unlock,
            vault::vault_lock,
            vault::vault_upgrade_to_master_password,
            // 降级到免密钥匙链模式（no-lock 任务：password → keyring 向导本体）
            vault::vault_downgrade_to_keychain,
            vault::settings_get,
            vault::settings_set,
            // Phase 5 Task 3（同步编排）：分类快照导出/导入（过锁定门卫，
            // ottr-vault sync_snapshot 模块；编排引擎在 src/sync/SyncStore.ts）
            vault::sync_export_categories,
            vault::sync_import_categories,
            // Phase 5 Task 4（同步 UI 宿主桥，commands/sync_git.rs）：git 通道
            // 白名单 exec 桥（argv 形态钉死 + scratch 命名空间）+ 信封口令钥匙链
            commands::sync_git::sync_git_exec,
            commands::sync_git::sync_git_scratch,
            commands::sync_git::sync_git_scratch_write,
            commands::sync_git::sync_git_scratch_cleanup,
            commands::sync_git::sync_passphrase_set,
            commands::sync_git::sync_passphrase_get,
            commands::sync_git::sync_passphrase_del,
            // product-ready T4（BL-524 清偿，commands/sync_http.rs）：WebDAV
            // 通道 HTTP 代理——webview fetch 生产被 CORS 拦死，改走 Rust
            // reqwest（同源钉死 + method 白名单，安全面见模块文档）
            commands::sync_http::sync_http_fetch,
            // Task 16.5（0×0 主窗 frame 修复）：vault 后台初始化就绪门取数面
            vault::vault_init_status,
            // product-ready T5（BL-537 清偿）：锁定屏「忘记密码？」重置应用——
            // confirm 门卫 + 清库/钥匙链 + 进程重启回首启（破坏性命令，语义见
            // vault.rs 模块内注释）
            vault::vault_reset,
            // Task 12（spec §7）：通知管线①应用内通知中心（明文面，锁定可读写）
            vault::notify_insert,
            vault::notify_list,
            vault::notify_mark_read,
            vault::notify_clear,
            vault::notify_unread_count,
            // BL-530：投递失败标记持久化——标记/翻正清账落库（明文面，同上组
            // 锁定语义；前端 src/notify/core.ts 写穿，重启 refresh 恢复标记）
            vault::notify_mark_delivery_failed,
            vault::notify_clear_delivery_failure,
            // Task 15（spec §5）：统一历史搜索 ⌘R（明文面，锁定可读写）
            vault::history_insert,
            vault::history_search,
            // Phase 2 Task 7（B1）：会话纪要——数据源命令序列（明文面）+
            // 摘要密文面（summary_insert/list 过锁定门卫，同 secrets）
            vault::history_list_session,
            vault::summary_insert,
            vault::summary_list,
            // Phase 3 Task 5（B3）：会话录制审计回放（明文面，同 history 锁定语义；
            // tee 挂接在 flush_batch，导出经前端 redact，commands/recording.rs）
            commands::recording::recording_start,
            commands::recording::recording_stop,
            commands::recording::recording_list,
            commands::recording::recording_search,
            commands::recording::recording_read,
            commands::recording::recording_delete,
            commands::recording::recording_export,
            security::vault_copy_credential_secret,
            // vault（Task 5 接线，命令名契约见 src/vault/api.ts 文件头）
            vault::hosts_list,
            vault::hosts_get,
            vault::hosts_create,
            vault::hosts_update,
            vault::hosts_delete,
            vault::hosts_list_by_group,
            vault::hosts_search,
            vault::credentials_list,
            vault::credentials_get,
            vault::credentials_create,
            vault::credentials_update,
            vault::credentials_delete,
            vault::credentials_reveal,
            vault::host_groups_list,
            vault::host_groups_create,
            vault::host_groups_update,
            vault::host_groups_delete,
            vault::snippets_list,
            vault::snippets_get,
            vault::snippets_search,
            vault::snippets_create,
            vault::snippets_update,
            vault::snippets_delete,
            vault::known_hosts_list,
            vault::known_hosts_upsert,
            vault::known_hosts_verify,
            vault::known_hosts_mark_changed,
            vault::known_hosts_delete,
            // 指纹巡检（Phase 3 Task 6，B9 收口；模块 hostkey_audit.rs）
            hostkey_audit::known_hosts_probe,
            hostkey_audit::known_hosts_audit_run,
            vault::import_ssh_config,
            vault::export_hosts_csv,
            // 迁移导入器（Phase 2 Task 10，B3；命令名契约见 src/vault/api.ts）
            vault::import_xshell_sessions,
            vault::import_tabby_config,
            // 密钥管理（Task 6，A4；命令名契约见 src/vault/api.ts keys 段）
            keys::key_generate,
            keys::key_inspect,
            keys::key_export,
            keys::key_deploy,
            commands::session::resize_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // App 退出清理（Phase 2 Task 3）：编辑临时目录随进程收尾。
            // RunEvent::Exit 对 quit_app / 菜单退出 / 正常退出路径统一触发；
            // 异常死亡的漏网残留由 24h 惰性清扫兜底（remote_edit 模块文档）。
            if let tauri::RunEvent::Exit = event {
                commands::remote_edit::close_all_edits(&app.state::<AppState>().edits);
            }
        });
}
