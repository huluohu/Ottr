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
pub mod importers;
pub mod keys;
pub mod menu;
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
    forward_pty_loop, inject_shell_integration, SessionCloseReason, ShellIntegrationOutcome,
};
pub(crate) use commands::state::AppState;
pub use commands::state::{SessionCounters, TextTail};
// Phase 2 Task 1（B7）：ForwardManager 公开给夹具集成测试（真容器断线恢复链）。
pub use commands::forward::ForwardManager;
// Phase 2 Task 3（B10 上半）：远端编辑生命周期核公开给夹具集成测试
// （tests/remote_edit_fixture.rs：下载→编辑→回传→冲突→覆盖→清理全链）。
pub use commands::remote_edit::{
    apply_save_bookkeeping, close_all_edits, edit_close, edit_close_session, edit_dismiss,
    edit_open, edit_poll, edit_save, local_stamp, poll_decision, sweep_stale_edits, temp_path_for,
    temp_root, EditEntry, EditMap, EditPollStatus, LocalDecision, LocalStamp,
};

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
                            autolock.on_focus_changed(&watcher.app_handle(), *focused);
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
            vault::settings_get,
            vault::settings_set,
            // Task 16.5（0×0 主窗 frame 修复）：vault 后台初始化就绪门取数面
            vault::vault_init_status,
            // Task 12（spec §7）：通知管线①应用内通知中心（明文面，锁定可读写）
            vault::notify_insert,
            vault::notify_list,
            vault::notify_mark_read,
            vault::notify_clear,
            vault::notify_unread_count,
            // Task 15（spec §5）：统一历史搜索 ⌘R（明文面，锁定可读写）
            vault::history_insert,
            vault::history_search,
            // Phase 2 Task 7（B1）：会话纪要——数据源命令序列（明文面）+
            // 摘要密文面（summary_insert/list 过锁定门卫，同 secrets）
            vault::history_list_session,
            vault::summary_insert,
            vault::summary_list,
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
            vault::import_ssh_config,
            vault::export_hosts_csv,
            // 迁移导入器（Phase 2 Task 10，B3；命令名契约见 src/vault/api.ts）
            vault::import_xshell_sessions,
            vault::import_tabby_config,
            // 密钥管理（Task 6，A4；命令名契约见 src/vault/api.ts keys 段）
            keys::key_generate,
            keys::key_inspect,
            keys::key_export,
            keys::key_deploy
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
