//! ottr-cron：定时任务引擎 + 调度原语（自 ottr-monitor 迁出——cron 引擎与
//! 「监控采集」分属不同职责，crate 命名与内容对齐；迁移纯代码搬移，零逻辑改动）。
//!
//! * [`cron`]：五段式解析 + next-fire + 调度循环（**引擎宿主裁定落地**：调度
//!   在 Rust 运行时，与 webview 生命周期解耦；消费面在 src-tauri
//!   `commands/cron.rs`，装配点由 cron_fixture 覆盖）；
//! * [`sched`]：调度原语——默认间隔 / 随机抖动（防周期对齐）/ 全局相位错开
//!   （防惊群）。监控采样循环（ottr-monitor task）与 cron 心跳共用同一原语。
//!
//! 本 crate 不含 Tauri/SSH/前端类型（cron exec 经 [`cron::CronExecResolver`]
//! 闭包注入，采样原语纯 std），依赖树只有 chrono/serde/tokio。

pub mod cron;
pub mod sched;

pub use cron::{
    BoxedCronExec, CronClock, CronError, CronExecOutput, CronExecResolver, CronExpr, CronJobView,
    CronJobsProvider, CronLoopConfig, CronLoopEnd, CronRunRecord, CronRunSink, CronRunStatus,
    run_cron_scheduler,
};
pub use sched::{DEFAULT_INTERVAL, JITTER_PERCENT, JitterRng, fnv1a, jittered, phase_delay};
