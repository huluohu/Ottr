//! ottr-monitor：免 agent 主机监控采集（Phase 3 Task 1，B4 上半）。
//!
//! 分层（与 ottr-transfer 同向依赖 ottr-ssh）：
//! * [`collect`]：SSH exec **一条复合只读命令**（`cat /proc/{stat,meminfo,
//!   loadavg,net/dev}` + `df -k`，marker 分段——[`COMPOSITE_CMD`] 是只读
//!   白名单唯一构造点）→ [`RawSample`]；Linux 专用声明，macOS/BSD 远端
//!   无 /proc → [`MonitorError::Unsupported`] 优雅降级「不支持」；
//! * [`parse`]：/proc 文本解析器（严格 TDD，golden = `fixtures/monitor/`
//!   真实 /proc 快照）；
//! * [`metrics`]：两次采样差分 → [`Metrics`]（CPU% 差分/内存水位/
//!   网络速率；首采样无基线跳过首轮）；
//! * [`sched`]：采样调度——默认 5s（settings `monitor.interval_secs`
//!   可配，消费面在 src-tauri）+ 每轮随机抖动 ±10% + 会话 id 决定的
//!   全局相位错开（多实例防惊群，确定性零共享状态）；
//! * [`task`]：通用采样循环 [`run_sampling`] + 生命周期 owner
//!   [`MonitorGuard`]（Drop 即停）——per-session 采样任务挂会话生命周期
//!   （会话断开/关闭 → 会话表摘除 → guard Drop → 循环就地退出）。
//!
//! 消费面：src-tauri `commands/monitor.rs`（MonitorManager + `ottr://monitor`
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
pub mod metrics;
pub mod parse;
pub mod sched;
pub mod task;

pub use collect::{COMPOSITE_CMD, MonitorError, collect};
pub use metrics::{Metrics, RawSample};
pub use parse::{DiskEntry, LoadAvg, MemInfo, NetCounters, StatCounters};
pub use sched::{DEFAULT_INTERVAL, JITTER_PERCENT, JitterRng, fnv1a, jittered, phase_delay};
pub use task::{LoopConfig, MonitorGuard, SamplingEnd, run_sampling};
