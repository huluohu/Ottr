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
// 批量执行命令域（Phase 3 Task 4，B6）：并发池（Semaphore 上限 + 单主机
// tokio timeout + 双检查取消）+ batch_exec/batch_cancel + ottr://batch-result
// 逐主机结果事件。执行模型与测试面论证见模块文档。
pub mod batch;
// cron 定时任务命令域（Phase 4 Task 1，缺口① + 终审风险#2 清偿）：调度器
// spawn 点（vault 就绪后，hostkey_audit 同款挂点）+ cj_* 命令 +
// ottr://cron-run 事件。宿主裁定论证见模块文档与 ottr-monitor::cron。
pub mod cron;
// 监控采集命令域（Phase 3 Task 1，B4 上半）：MonitorManager（per-session
// 采样任务 owner，ForwardManager 同款模式）+ monitor_start/stop +
// ottr://monitor 事件推前端。
pub mod monitor;
// MCP 命令域（Phase 4 Task 3，C1）：MCP stdio server 引擎（UDS listener +
// 授权矩阵执行 + 逐次审批门）+ mcp_* 命令面。协议核在 crate::mcp，
// relay 子进程在 bin/ottr-mcp.rs；形态裁定论证见模块文档。
pub mod mcp;
// 会话录制命令域（Phase 3 Task 5，B3）：RecordingHandle（tee 写盘线程 owner）
// + recording_start/stop/read/list/search/delete/export + 会话退出自动收尾。
pub mod recording;
// SMTP 通知命令域（Phase 3 Task 3，B5 渠道全矩阵）：smtp_send 单命令
// （lettre tokio1 + native-tls；选型与安全面论证见模块文档）。其余 11 渠道
// 适配器在前端 fetch（frontend/notify/channels/*），不经 Rust。
pub mod notify;
// 远端文件本地编辑域（Phase 2 Task 3，B10 上半）：编辑会话表 + 轮询防抖 +
// 冲突检测回传 + 清理（显式关闭/会话消失/App 退出/24h 惰性清扫）。
pub mod remote_edit;
// FTP/FTPS 会话域（Phase 2 Task 5，B10 下半第二后端）：ftp_attach_host_session
// + 会话表分派支撑（面板命令面在 transfer.rs 按 id 路由，命令名不变）。
pub mod ftp;
// 同步通道宿主桥（Phase 5 Task 4）：git 通道白名单 exec 桥（argv 形态钉死，
// 清偿 task-2-report 披露的「webview 生产 exec 桥未落」）+ 信封口令钥匙链
// （task-2 裁定「存钥匙链归 Task 4」）。模块文档见本文件。
pub mod session;
pub mod sync_git;
// 同步 WebDAV 通道 HTTP 代理（product-ready T4，BL-524 清偿）：webview 原生
// fetch 生产被 CORS 拦死，改经 invoke 走 Rust reqwest（同源钉死 + method
// 白名单 + Basic 头 Rust 侧拼接）。模块文档见本文件。
pub mod sync_http;
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
