//! Tauri 命令域子模块（Task 0 拆分，BL-004；终审风险提示②「先拆模块再加功能」）。
//!
//! * `state`：共享状态核（会话表/传输表/计数器/合批参数）——crate 内唯一定义点；
//! * `session`/`transfer`/`encoding`/`spike`：命令域，纯自 lib.rs 搬家（函数体
//!   零逻辑改动，`git diff -w` 逐段核对）；lib.rs 回归 use + generate_handler 薄装配；
//! * vault/keys/security/hosts/known_hosts 命令面已在既有 vault.rs / keys.rs /
//!   security.rs / ssh_config.rs 模块——不再二次搬家（见 task-0 报告选型论证）；
//! * Global Constraint「lib.rs 只减不增」：Phase 2 新命令一律进本目录对应域。
pub mod encoding;
// 端口转发命令域（Phase 2 Task 1，B7 上半）：ForwardManager + pf_* 命令 +
// 会话断线/重连挂钩（Phase 2 新域，Global Constraint：新命令进本目录对应域）。
pub mod forward;
// 跳板链命令域（Phase 2 Task 2，B7 下半）：jc_* 命令 + 链上逐跳规格解析。
pub mod jump;
// 监控采集命令域（Phase 3 Task 1，B4 上半）：MonitorManager（per-session
// 采样任务 owner，ForwardManager 同款模式）+ monitor_start/stop +
// ottr://monitor 事件推前端。
pub mod monitor;
// 远端文件本地编辑域（Phase 2 Task 3，B10 上半）：编辑会话表 + 轮询防抖 +
// 冲突检测回传 + 清理（显式关闭/会话消失/App 退出/24h 惰性清扫）。
pub mod remote_edit;
// FTP/FTPS 会话域（Phase 2 Task 5，B10 下半第二后端）：ftp_attach_host_session
// + 会话表分派支撑（面板命令面在 transfer.rs 按 id 路由，命令名不变）。
pub mod ftp;
pub mod session;
// spike 命令面生产闸门（Task 0 Step 4，终审C-2/BL-002）：Phase 0 测量/取数命令
// 不进 release 产物——`spike_report_file` 是 webview 可达的任意路径写原语（路径
// 白名单只是纵深防御）。debug 构建保留供 scripts/验收驱动面；release 构建整个
// 模块不存在 → 命令未注册、webview invoke 不可达（lib.rs 注册表同步 cfg 门）。
#[cfg(debug_assertions)]
pub mod spike;
pub mod state;
pub mod transfer;
// trzsz 本地文件桥（Phase 2 Task 4，B10 下半）：trzsz.js node 模式的 fs 垫片
// invoke 落点（stat/read/write/list/mkdir/remove/check），模块文档见本文件。
pub mod trzsz_fs;
