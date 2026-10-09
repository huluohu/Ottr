//! ottr-monitor：免 agent 主机监控采集（Phase 3 Task 1，B4 上半）。
//!
//! 分层（与 ottr-transfer 同向依赖 ottr-ssh）：
//! * [`collect`]：SSH exec **一条复合只读命令**（`cat /proc/{stat,meminfo,
//!   loadavg,net/dev}` + `df -k`，marker 分段——[`COMPOSITE_CMD`] 是只读
//!   白名单唯一构造点）→ [`RawSample`]；Linux 专用声明，macOS/BSD 远端
//!   无 /proc → [`MonitorError::Unsupported`] 优雅降级「不支持」；
//! * [`parse`]：/proc 文本解析器（严格 TDD，golden = `fixtures/monitor/`
//!   真实 /proc 快照）；
//! * [`proc`]：进程浏览器数据面（Phase 3 Task 2）——`ps -eo` 采集解析
//!   （只读白名单的 ps 追加点 [`PS_CMD`]）+ `kill` 命令构造（`u32` 入参
//!   结构性防注入）与执行；
//! * [`log`]：日志关键字采样面（Phase 4 Task 2）——定期 `tail -c +K` 轮询
//!   （stat + tail 一条复合只读命令；字节级游标归 TS 引擎持有）+ path
//!   字符白名单结构性防注入；
//! * [`metrics`]：两次采样差分 → [`Metrics`]（CPU% 差分/内存水位/
//!   网络速率；首采样无基线跳过首轮）；
//! * [`task`]：通用采样循环 [`run_sampling`] + 生命周期 owner
//!   [`MonitorGuard`]（Drop 即停）——per-session 采样任务挂会话生命周期
//!   （会话断开/关闭 → 会话表摘除 → guard Drop → 循环就地退出）；
//!   采样调度原语（间隔/抖动/相位错开）与 cron 定时任务引擎已迁至
//!   ottr-cron（crate 命名与内容对齐；[`task`] 经 ottr_cron::sched 消费）
//!
//! 消费面：desktop `commands/monitor.rs`（MonitorManager + `ottr://monitor`
//! 事件推前端）。本 crate 不含 Tauri/前端类型，循环以闭包注入可离线测试。
//!
//! ```no_run
//! # async fn demo(session: &ottr_ssh::SshSession) -> Result<(), ottr_monitor::MonitorError> {
//! let sample = ottr_monitor::collect(session).await?;
//! println!("mem total {} kB, {} mounts", sample.mem.total_kb, sample.disk.len());
//! # Ok(())
//! # }
//! ```

pub mod collect;
pub mod log;
pub mod metrics;
pub mod parse;
pub mod proc;
pub mod task;

pub use collect::{COMPOSITE_CMD, MonitorError, collect};
pub use log::{LogTailSample, collect_log_tail, log_path_is_safe, log_stat_cmd, log_tail_cmd};
pub use metrics::{Metrics, RawSample};
pub use parse::{DiskEntry, LoadAvg, MemInfo, NetCounters, StatCounters};
pub use proc::{PS_CMD, ProcEntry, collect_ps, kill_cmd, kill_process, parse_ps_eo};
pub use task::{LoopConfig, MonitorGuard, SamplingEnd, run_sampling};
