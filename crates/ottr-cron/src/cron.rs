//! cron 定时任务核心（Phase 4 Task 1，Phase 3 缺口①）：五段式解析 + next-fire
//! + 调度循环——**引擎宿主裁定的落地体**（终审风险#2）。
//!
//! # 宿主裁定（简报裁定 #2）
//!
//! 调度与 exec 评估在 **Rust 侧 tokio 运行时**（本模块 + src-tauri
//! `commands/cron.rs` 的 spawn 点），与 webview 生命周期解耦：
//! * 关窗到托盘（`menu::on_close_requested` 隐藏主窗）= webview 隐藏但 Rust
//!   运行时照常在跑 → **cron 照常触发**；通知触发经 `ottr://cron-run` 事件
//!   交 TS 管线（隐藏 webview 仍存活，管线照走：落库/系统通知/渠道分发）；
//! * **真退出**（quit_app / 菜单退出 / 进程死亡）= 调度随进程停止——「App
//!   退出即停」语义在文档明示；cron 不是系统级守护（不写 crontab、无独立
//!   进程），进程不在就没有调度器，这是产品语义而非缺陷；
//! * 停摆补跑：App 未运行的时段**不补跑**（错过即错过，如实记 missed/不记，
//!   与「App 退出即停」同一语义面）；运行中错过的心跳也只跑最近一次
//!   （[`run_cron_scheduler`] 的追赶口径，见其文档）。
//!
//! # cron 解析选型（简报裁定 #1：手写最小解析器）
//!
//! **手写五段式子集**（分/时/日/月/周），不引 `cron` crate：依赖从简
//! （croner 0.5 全家桶对一个五段式子集纯属浪费）；子集面：
//! * 每段支持 `*`、`*/N`、`A`、`A-B`、`A-B/N`、`A/N`（N=步长 ≥1）、列表 `,`；
//! * 数字字面量 only（不认 `MON`/`JAN` 名字——错误显式报，不静默）；
//! * 周 0-6（0=周日）+ `7` 归一化为周日（Vixie 惯例）；
//! * 日(dom)/周(dow) 都受限时取**并集**（Vixie 经典语义）；只受限其一时取交集；
//! * 范围倒挂（`10-5`）显式报错（不做环绕——子集从简，错误可见）。
//!
//! next-fire = 经典 cron 的**逐字段推进**（月不配 → 跳到下月 1 日 00:00；
//! 时不配 → 跳到下一整点；分不配 → +1 分钟），最坏几次推进即命中（分钟粒度
//! 域内 ≤60 步），比逐分钟扫描快几个数量级；本地时区换算走 chrono `Local`
//! （依赖树内已有）。DST：缺口期（不存在的本地时刻）解析为 None → 跳过该分
//! 前进；重叠期取最早一次（`earliest()`）——两个选择都偏保守（不重复触发）。
//!
//! # 调度循环（[`run_cron_scheduler`]，先例 = ottr-monitor `task::run_sampling` 同款
//! 注入式可测形态）
//!
//! 心跳 tick（生产 20s + 相位错峰 [`crate::sched::phase_delay`]）→ 拉任务表
//! → 逐任务对账：到点即 spawn 单轮执行（互斥 in-flight：上一轮未完本轮跳过
//! ——不叠跑，语义同系统 cron 的常见 `flock` 口径）→ 结果 [`CronRunRecord`]
//! 交 sink（src-tauri 落 cron_runs + 发事件）。时钟/任务表/exec/sink 全部
//! 注入（测试假件直驱，零真连接——ottr-monitor `task` 同款纪律）。
//!
//! 【追赶口径】到点时若 next-fire 已逾期多个周期（长 GC/挂起），只跑**最近
//! 错过的一次**并把 next-fire 前推到未来——不逐轮补放（补放 N 条通知是风暴
//! 面；「没跑就如实少跑」是可审计语义）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{Datelike, NaiveDate, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::sched::phase_delay;

// ---------------------------------------------------------------------------
// 五段式解析器（TDD golden 面）
// ---------------------------------------------------------------------------

/// 解析错误（消息面向 UI 直接展示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(pub String);

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid cron schedule: {}", self.0)
    }
}

/// 五段式表达式（分 时 日 月 周），字段展开为位掩码。
/// `dom_star`/`dow_star` = 该段是否为字面 `*`（Vixie 日/周并集语义的判定面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    dows: u64,
    dom_star: bool,
    dow_star: bool,
}

#[inline]
fn has_bit(mask: u64, v: u32) -> bool {
    (mask >> v) & 1 == 1
}

/// 单段解析：`spec` 展开进 `[min, max]` 位掩码。`literal_star` 置位当且仅当
/// 整段就是 `*`（步进星 `*/2` **不**算 literal——Vixie 的受限口径）。
fn parse_field(spec: &str, min: u32, max: u32, literal_star: &mut bool) -> Result<u64, CronError> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err(CronError("empty field".into()));
    }
    *literal_star = spec == "*";
    let mut mask = 0u64;
    for part in spec.split(',') {
        let part = part.trim();
        let (range_part, step, has_step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s
                    .parse()
                    .map_err(|_| CronError(format!("bad step in {part:?}")))?;
                if step == 0 {
                    return Err(CronError("step must be >= 1".into()));
                }
                (r, step, true)
            }
            None => (part, 1, false),
        };
        let (lo, hi) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let lo: u32 = a
                .trim()
                .parse()
                .map_err(|_| CronError(format!("bad number {a:?}")))?;
            let hi: u32 = b
                .trim()
                .parse()
                .map_err(|_| CronError(format!("bad number {b:?}")))?;
            (lo, hi)
        } else {
            // 单点：无步长 = 精确值；带步长（`5/15`）= 5 起步长 15 到段顶
            // （Vixie 语义）
            let v: u32 = range_part.trim().parse().map_err(|_| {
                CronError(format!("bad number {range_part:?} (names not supported)"))
            })?;
            if has_step { (v, max) } else { (v, v) }
        };
        if lo < min || hi > max || lo > hi {
            return Err(CronError(format!(
                "range {lo}-{hi} out of [{min},{max}] or inverted"
            )));
        }
        for v in lo..=hi {
            if (v - lo) % step == 0 {
                mask |= 1u64 << v;
            }
        }
    }
    if mask == 0 {
        return Err(CronError("field selects no value".into()));
    }
    Ok(mask)
}

impl CronExpr {
    /// 解析五段式（恰好 5 段，空白分隔；周 `7` 归一化为周日）。
    pub fn parse(schedule: &str) -> Result<CronExpr, CronError> {
        let fields: Vec<&str> = schedule.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(CronError(format!(
                "expected 5 fields (min hour dom mon dow), got {}",
                fields.len()
            )));
        }
        let mut no_star = false;
        let mut dom_star = false;
        let mut dow_star = false;
        let minutes = parse_field(fields[0], 0, 59, &mut no_star)?;
        let hours = parse_field(fields[1], 0, 23, &mut no_star)?;
        let days = parse_field(fields[2], 1, 31, &mut dom_star)?;
        let months = parse_field(fields[3], 1, 12, &mut no_star)?;
        let dw = parse_field(fields[4], 0, 7, &mut dow_star)?;
        // 7 = 周日别名（Vixie）：位 7 清掉、位 0 置上
        let dows = (dw & !(1u64 << 7)) | (u64::from(dw & (1u64 << 7) != 0));
        Ok(CronExpr {
            minutes,
            hours,
            days,
            months,
            dows,
            dom_star,
            dow_star,
        })
    }

    /// `after_secs`（unix 秒）之后**严格晚于**它的下一个触发时刻（unix 秒，
    /// 本地时区）。找不到（>4 年视界）→ None。
    pub fn next_after(&self, after_secs: i64) -> Option<i64> {
        let tz = chrono::Local;
        let after = tz.timestamp_opt(after_secs, 0).earliest()?;
        // 起点：after 截到整分再 +1 分钟（严格晚于）
        let mut t = after.naive_local();
        t -= chrono::Duration::seconds(t.second() as i64);
        t += chrono::Duration::minutes(1);
        let limit_year = t.year() + 4;
        // 推进上限（防御：任何实现 bug 都以 None 收场，不挂死调度心跳）
        for _ in 0..200_000 {
            if t.year() > limit_year {
                return None;
            }
            if !has_bit(self.months, t.month()) {
                let (y, m) = if t.month() == 12 {
                    (t.year() + 1, 1)
                } else {
                    (t.year(), t.month() + 1)
                };
                t = NaiveDate::from_ymd_opt(y, m, 1)?.and_hms_opt(0, 0, 0)?;
                continue;
            }
            let dow = t.weekday().num_days_from_sunday();
            let day_ok = if !self.dom_star && !self.dow_star {
                has_bit(self.days, t.day()) || has_bit(self.dows, dow)
            } else {
                has_bit(self.days, t.day()) && has_bit(self.dows, dow)
            };
            if !day_ok {
                t = (t.date() + chrono::Duration::days(1)).and_hms_opt(0, 0, 0)?;
                continue;
            }
            if !has_bit(self.hours, t.hour()) {
                t = t.date().and_hms_opt(0, 0, 0)?
                    + chrono::Duration::hours(i64::from(t.hour()) + 1);
                continue;
            }
            if !has_bit(self.minutes, t.minute()) {
                t += chrono::Duration::minutes(1);
                continue;
            }
            // 命中：本地时刻 → unix（DST 缺口期该时刻不存在 → 跳过分前进）
            return match tz.from_local_datetime(&t).earliest() {
                Some(dt) => Some(dt.timestamp()),
                None => {
                    t += chrono::Duration::minutes(1);
                    continue;
                }
            };
        }
        None
    }
}

// ---------------------------------------------------------------------------
// 调度循环（注入面：clock / jobs / exec / sink）
// ---------------------------------------------------------------------------

/// 单轮执行状态（cron_runs.status / 事件 / TS 通知 severity 的共同判定面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CronRunStatus {
    /// 退出码 0。
    Ok,
    /// 非零退出 / exec 通道错误。
    Failed,
    /// 超过单轮限时（远端命令仍在跑，无中断原语——如实记录）。
    Timeout,
    /// 主机无在册会话（**不自动连接**——简报裁定 #3）。
    Missed,
}

/// 一轮执行的结果（core 产出，src-tauri sink 消费：落库 + sidecar + 事件）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CronRunRecord {
    pub cron_id: i64,
    pub status: CronRunStatus,
    /// 远端退出码；None = missed/timeout/exec 错误/未回 ExitStatus。
    pub exit_code: Option<i64>,
    /// 输出文本（stdout + stderr 标注段；已在 core 侧截断到
    /// [`CronLoopConfig::output_cap`]）。
    pub output: String,
    pub truncated: bool,
    pub duration_ms: u64,
    /// 触发时刻（unix 秒，来自注入时钟）。
    pub ts: i64,
    /// missed/failed 的错误原文（事件载荷面，不入库列）。
    pub error: Option<String>,
}

/// 任务表行（src-tauri 从 vault cron_jobs 投影；core 只消费 id/schedule/
/// enabled，host_id 随行透传给 resolver/事件面——exec 会话解析按主机）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CronJobView {
    pub id: i64,
    pub host_id: i64,
    pub schedule: String,
    pub enabled: bool,
}

/// exec 结果（与 ottr-ssh ExecOutput 解耦的最小投影；mock 直造）。
#[derive(Debug, Clone)]
pub struct CronExecOutput {
    pub exit_code: Option<i64>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// exec future（batch.rs BoxExecFuture 同款手写别名——不引 futures 依赖）。
pub type BoxedCronExec =
    std::pin::Pin<Box<dyn Future<Output = Result<CronExecOutput, String>> + Send>>;

/// 会话解析器：job → exec future；同步 `Err` = 无在册会话 → missed。
pub type CronExecResolver =
    Arc<dyn Fn(&CronJobView) -> Result<BoxedCronExec, String> + Send + Sync>;

/// 注入时钟（unix 秒；测试 = 虚拟钟，生产 = SystemTime）。
pub type CronClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// 任务表快照（每 tick 拉一次；生产 = vault 读，短阻塞可接受）。
pub type CronJobsProvider = Arc<dyn Fn() -> Vec<CronJobView> + Send + Sync>;

/// 结果 sink（生产 = 落 cron_runs + sidecar + emit；测试 = 收集器）。
pub type CronRunSink = Arc<dyn Fn(CronRunRecord) + Send + Sync>;

/// 循环参数。生产值见 [`CronLoopConfig::production`]。
#[derive(Debug, Clone)]
pub struct CronLoopConfig {
    /// 心跳间隔（对账节拍；cron 粒度是分钟，心跳只影响触发延迟上界）。
    pub heartbeat: Duration,
    /// 单轮 exec 限时（挂死脚本不占死 in-flight 槽）。
    pub exec_timeout: Duration,
    /// 输出截断上限（字节；对齐 batch 的 64KB 防护面）。
    pub output_cap: usize,
    /// 相位错峰种子（[`crate::sched::phase_delay`]）。
    pub phase_seed: String,
}

impl CronLoopConfig {
    /// 生产参数：心跳 20s（分钟粒度下的触发延迟上界 ≤ tick+错峰）、单轮
    /// 限时 120s（批量默认 30s 是交互场景；定时脚本允许更长的合法运行面）。
    pub fn production() -> Self {
        CronLoopConfig {
            heartbeat: Duration::from_secs(20),
            exec_timeout: Duration::from_secs(120),
            output_cap: 64 * 1024,
            phase_seed: "cron".into(),
        }
    }
}

/// 循环终态（现只有取消一路；错误不终结循环——单任务失败不拖垮调度器）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CronLoopEnd {
    Cancelled,
}

/// 输出组合 + 截断：stdout 为主体，stderr 非空则追加标注段；合计超 cap 按
/// 字节截（UTF-8 lossy 兜底——exec 输出编码不保证）。digest/落盘面在 sink。
fn combine_output(stdout: &[u8], stderr: &[u8], cap: usize) -> (String, bool) {
    let mut bytes = stdout.to_vec();
    if !stderr.is_empty() {
        if !bytes.is_empty() {
            bytes.extend_from_slice(b"\n[stderr]\n");
        }
        bytes.extend_from_slice(stderr);
    }
    let truncated = bytes.len() > cap;
    if truncated {
        bytes.truncate(cap);
    }
    (String::from_utf8_lossy(&bytes).into_owned(), truncated)
}

/// 把 exec 结果映射成 [`CronRunRecord`]（状态判定单点：0=ok / 非零=failed /
/// 无退出码=failed / 超时=timeout / 无会话=missed）。
fn settle(
    cron_id: i64,
    ts: i64,
    started: &Instant,
    outcome: Result<Result<CronExecOutput, String>, tokio::time::error::Elapsed>,
    cap: usize,
) -> CronRunRecord {
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match outcome {
        Err(_) => CronRunRecord {
            cron_id,
            status: CronRunStatus::Timeout,
            exit_code: None,
            output: String::new(),
            truncated: false,
            duration_ms,
            ts,
            error: None,
        },
        Ok(Err(e)) => CronRunRecord {
            cron_id,
            status: CronRunStatus::Failed,
            exit_code: None,
            output: String::new(),
            truncated: false,
            duration_ms,
            ts,
            error: Some(e),
        },
        Ok(Ok(out)) => {
            let (output, truncated) = combine_output(&out.stdout, &out.stderr, cap);
            let (status, error) = match out.exit_code {
                Some(0) => (CronRunStatus::Ok, None),
                Some(n) => (CronRunStatus::Failed, Some(format!("exit code {n}"))),
                None => (
                    CronRunStatus::Failed,
                    Some("remote closed without exit status".into()),
                ),
            };
            CronRunRecord {
                cron_id,
                status,
                exit_code: out.exit_code,
                output,
                truncated,
                duration_ms,
                ts,
                error,
            }
        }
    }
}

/// 调度循环（先例 = [`crate::task::run_sampling`] 的注入式可测形态）：
/// * 错峰首拍 → 心跳对账：到点任务 spawn 单轮（in-flight 互斥：上一轮未完
///   本轮跳过——不叠跑）；错过的心跳只跑最近一次并前推（追赶口径见模块文档）；
/// * 解析失败的任务打日志跳过（不终结循环、不反复刷屏——schedule 未变不重报）；
/// * 任务表快照外的缓存项随删（删任务不残留）；
/// * 取消即就地退出（宿主=进程生命周期，运行面无逐任务 guard 的必要——
///   单轮 exec 有自己的 timeout 兜底）。
pub async fn run_cron_scheduler(
    cancel: CancellationToken,
    config: CronLoopConfig,
    clock: CronClock,
    jobs: CronJobsProvider,
    exec: CronExecResolver,
    on_run: CronRunSink,
) -> CronLoopEnd {
    // 相位错峰（防多实例同刻对账；同进程单调度器无惊群面，沿先例保留）
    tokio::select! {
        _ = tokio::time::sleep(phase_delay(&config.phase_seed, config.heartbeat)) => {}
        _ = cancel.cancelled() => return CronLoopEnd::Cancelled,
    }

    // id → (schedule, expr, next_fire)；next_fire None = 尚未初始化
    let mut cache: HashMap<i64, (String, CronExpr, Option<i64>)> = HashMap::new();
    let in_flight: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut bad_logged: HashSet<i64> = HashSet::new();

    loop {
        tokio::select! {
            _ = tokio::time::sleep(config.heartbeat) => {}
            _ = cancel.cancelled() => return CronLoopEnd::Cancelled,
        }
        let now = clock();
        let list = jobs();
        let live: HashSet<i64> = list.iter().map(|j| j.id).collect();
        cache.retain(|id, _| live.contains(id));
        bad_logged.retain(|id| live.contains(id));

        for job in &list {
            if !job.enabled {
                continue;
            }
            // 取/建解析缓存（schedule 变更即重解析）
            let expr = match cache.get(&job.id) {
                Some((s, e, _)) if *s == job.schedule => e.clone(),
                _ => match CronExpr::parse(&job.schedule) {
                    Ok(e) => {
                        cache.insert(job.id, (job.schedule.clone(), e.clone(), None));
                        e
                    }
                    Err(err) => {
                        if bad_logged.insert(job.id) {
                            eprintln!("[cron:{}] {err}", job.id);
                        }
                        continue;
                    }
                },
            };
            // 到点对账
            let nf = match cache.get(&job.id).and_then(|(_, _, nf)| *nf) {
                None => expr.next_after(now), // 首见：从 now 起算（停摆不补跑）
                Some(nf) => Some(nf),
            };
            let Some(nf) = nf else { continue };
            if now < nf {
                if let Some(entry) = cache.get_mut(&job.id) {
                    entry.2 = Some(nf);
                }
                continue;
            }
            // 已到点：前推 next-fire（逾期多轮只跑最近一次）
            let mut next = expr.next_after(nf).unwrap_or(i64::MAX);
            if next <= now {
                next = expr.next_after(now).unwrap_or(i64::MAX);
            }
            if let Some(entry) = cache.get_mut(&job.id) {
                entry.2 = Some(next);
            }
            // in-flight 互斥：上一轮未完 → 本轮让位（不叠跑，不补）
            if !in_flight
                .lock()
                .expect("cron in-flight poisoned")
                .insert(job.id)
            {
                continue;
            }
            let exec = Arc::clone(&exec);
            let on_run = Arc::clone(&on_run);
            let in_flight = Arc::clone(&in_flight);
            let clock = Arc::clone(&clock);
            let job_id = job.id;
            let host_id = job.host_id;
            let timeout = config.exec_timeout;
            let cap = config.output_cap;
            tokio::spawn(async move {
                let ts = clock();
                let started = Instant::now();
                let outcome = match exec(&CronJobView {
                    id: job_id,
                    host_id,
                    // schedule 原文只在 resolver 表现需要；重投影防 schedule 漂移
                    schedule: String::new(),
                    enabled: true,
                }) {
                    Ok(f) => tokio::time::timeout(timeout, f).await,
                    Err(e) => {
                        // 无在册会话：missed 如实入库（不自动连接——简报裁定 #3）
                        on_run(CronRunRecord {
                            cron_id: job_id,
                            status: CronRunStatus::Missed,
                            exit_code: None,
                            output: String::new(),
                            truncated: false,
                            duration_ms: u64::try_from(started.elapsed().as_millis())
                                .unwrap_or(u64::MAX),
                            ts,
                            error: Some(e),
                        });
                        in_flight
                            .lock()
                            .expect("cron in-flight poisoned")
                            .remove(&job_id);
                        return;
                    }
                };
                let record = settle(job_id, ts, &started, outcome, cap);
                on_run(record);
                in_flight
                    .lock()
                    .expect("cron in-flight poisoned")
                    .remove(&job_id);
            });
        }
    }
}

// ---------------------------------------------------------------------------
// 测试（解析 golden ≥15 + 调度核 mock 面）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// 用 chrono 独立构造期望时刻（与被测面同机同 TZ——golden 断言两侧走
    /// 不同代码路径：期望值直接由 TimeZone API 构造，不经过解析器）。
    fn local_ts(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        chrono::Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("unambiguous local time")
            .timestamp()
    }

    fn next(schedule: &str, after: i64) -> i64 {
        CronExpr::parse(schedule)
            .unwrap_or_else(|e| panic!("parse {schedule:?}: {e}"))
            .next_after(after)
            .expect("next fire within horizon")
    }

    // --- 解析 golden（每条：日程 + 参照时刻 + 独立构造的期望值）-----------

    #[test]
    fn every_minute_is_next_minute_boundary() {
        let after = local_ts(2026, 9, 29, 10, 45) + 30; // 10:45:30
        assert_eq!(next("* * * * *", after), local_ts(2026, 9, 29, 10, 46));
        // 秒级参照严格晚于：恰在整分时也不重放当前分
        assert_eq!(
            next("* * * * *", local_ts(2026, 9, 29, 10, 46)),
            local_ts(2026, 9, 29, 10, 47)
        );
    }

    #[test]
    fn step5_lands_on_next_multiple() {
        let after = local_ts(2026, 9, 29, 10, 47);
        assert_eq!(next("*/5 * * * *", after), local_ts(2026, 9, 29, 10, 50));
        // 55 → 下一小时 0
        let after = local_ts(2026, 9, 29, 10, 56);
        assert_eq!(next("*/5 * * * *", after), local_ts(2026, 9, 29, 11, 0));
    }

    #[test]
    fn hourly_at_half_past() {
        let after = local_ts(2026, 9, 29, 10, 45);
        assert_eq!(next("30 * * * *", after), local_ts(2026, 9, 29, 11, 30));
    }

    #[test]
    fn daily_at_0430_crosses_day() {
        let after = local_ts(2026, 9, 29, 5, 0);
        assert_eq!(next("30 4 * * *", after), local_ts(2026, 9, 30, 4, 30));
    }

    #[test]
    fn monthly_on_first_at_midnight() {
        let after = local_ts(2026, 1, 15, 0, 0);
        assert_eq!(next("0 0 1 * *", after), local_ts(2026, 2, 1, 0, 0));
    }

    #[test]
    fn weekly_monday_noon() {
        // 2026-09-29 是周二 → 下一个周一是 10-05
        let after = local_ts(2026, 9, 29, 13, 0);
        assert_eq!(next("0 12 * * 1", after), local_ts(2026, 10, 5, 12, 0));
    }

    #[test]
    fn sunday_alias_7_equals_0() {
        // 2026-10-04 是周日；参照 10-03（周六）
        let after = local_ts(2026, 10, 3, 12, 0);
        assert_eq!(next("0 0 * * 0", after), local_ts(2026, 10, 4, 0, 0));
        assert_eq!(
            next("0 0 * * 7", after),
            local_ts(2026, 10, 4, 0, 0),
            "7=周日别名"
        );
    }

    #[test]
    fn range_minutes_wrap_to_next_hour() {
        let after = local_ts(2026, 9, 29, 10, 11);
        assert_eq!(next("5-10 * * * *", after), local_ts(2026, 9, 29, 11, 5));
    }

    #[test]
    fn list_minutes_next_member() {
        let after = local_ts(2026, 9, 29, 10, 16);
        assert_eq!(
            next("0,15,30,45 * * * *", after),
            local_ts(2026, 9, 29, 10, 30)
        );
    }

    #[test]
    fn range_with_step_starts_at_lo() {
        let after = local_ts(2026, 9, 29, 10, 11);
        // 10-30/10 = {10,20,30}（步长从 lo 起算，不从段底）
        assert_eq!(
            next("10-30/10 * * * *", after),
            local_ts(2026, 9, 29, 10, 20)
        );
    }

    #[test]
    fn dom_and_dow_both_restricted_is_union() {
        // 13 日或周五；2026-09-10 是周四 → 周五 09-11 先于 13 日（周日）
        let after = local_ts(2026, 9, 10, 12, 0);
        assert_eq!(next("0 0 13 * 5", after), local_ts(2026, 9, 11, 0, 0));
    }

    #[test]
    fn dom_restricted_dow_star_is_intersection() {
        let after = local_ts(2026, 9, 10, 12, 0);
        assert_eq!(next("0 0 13 * *", after), local_ts(2026, 9, 13, 0, 0));
    }

    #[test]
    fn feb29_jumps_leap_years() {
        let after = local_ts(2026, 6, 1, 0, 0);
        assert_eq!(next("0 0 29 2 *", after), local_ts(2028, 2, 29, 0, 0));
    }

    #[test]
    fn year_rollover_last_minute_of_year() {
        let after = local_ts(2026, 6, 1, 0, 0);
        assert_eq!(next("59 23 31 12 *", after), local_ts(2026, 12, 31, 23, 59));
        let after = local_ts(2027, 1, 1, 0, 0);
        assert_eq!(next("59 23 31 12 *", after), local_ts(2027, 12, 31, 23, 59));
    }

    #[test]
    fn combined_list_step_and_range_fields() {
        // 分=列表 步进；时=范围；跨日
        let after = local_ts(2026, 9, 29, 22, 5);
        assert_eq!(
            next("0,20,40 9-17 * * *", after),
            local_ts(2026, 9, 30, 9, 0)
        );
    }

    // --- 拒绝面（子集边界显式报错，不静默） ------------------------------

    fn parse_err(schedule: &str) -> String {
        match CronExpr::parse(schedule) {
            Ok(_) => panic!("{schedule:?} should not parse"),
            Err(e) => e.0,
        }
    }

    #[test]
    fn rejects_wrong_field_count() {
        assert!(parse_err("* * * *").contains("5 fields"));
        assert!(parse_err("* * * * * *").contains("5 fields"));
        assert!(parse_err("").contains("5 fields"));
    }

    #[test]
    fn rejects_out_of_range_values() {
        assert!(parse_err("60 * * * *").contains("out of"));
        assert!(parse_err("* 24 * * *").contains("out of"));
        assert!(parse_err("* * 32 * *").contains("out of"));
        assert!(parse_err("* * * 13 *").contains("out of"));
        assert!(parse_err("* * * * 8").contains("out of"));
    }

    #[test]
    fn rejects_zero_step_and_inverted_range() {
        assert!(parse_err("*/0 * * * *").contains("step"));
        assert!(parse_err("10-5 * * * *").contains("inverted"));
    }

    #[test]
    fn rejects_names_and_junk() {
        assert!(parse_err("*/5 * * * MON").contains("bad number"));
        assert!(parse_err("*/5 * * * JAN").contains("bad number"));
        assert!(parse_err("@daily").contains("5 fields"));
        assert!(parse_err("a * * * *").contains("bad number"));
    }

    #[test]
    fn next_fire_chain_is_strictly_increasing() {
        let expr = CronExpr::parse("*/15 * * * *").unwrap();
        let t0 = local_ts(2026, 9, 29, 0, 3);
        let t1 = expr.next_after(t0).unwrap();
        let t2 = expr.next_after(t1).unwrap();
        let t3 = expr.next_after(t2).unwrap();
        assert!(t0 < t1 && t1 < t2 && t2 < t3);
        // 步长对齐：全落在 15 的倍数分
        for t in [t1, t2, t3] {
            let naive: NaiveDateTime = chrono::Local
                .timestamp_opt(t, 0)
                .single()
                .unwrap()
                .naive_local();
            assert_eq!(naive.minute() % 15, 0, "minute of {naive}");
        }
    }

    // --- 调度核（虚拟时钟 + mock exec）-----------------------------------

    /// 起一个 10ms 心跳的循环；jobs/exec 由 mpsc 通道热替换（测试驱动面）。
    /// 返回（任务表写入端、exec 脚本写入端、记录收集器、取消令牌、循环句柄）：
    /// exec 脚本队列按 (job_id, 结果, 延迟 ms) 投递；不投 = resolver 同步 Err
    /// （= 无在册会话 → missed 路径）。
    #[allow(clippy::type_complexity)] // 测试驱动面五元组：任务表/exec 脚本写端 + 记录收集器 + 令牌 + 句柄
    fn start(
        clock: Arc<AtomicI64>,
        exec_timeout: Duration,
    ) -> (
        Arc<Mutex<Vec<CronJobView>>>, // 任务表快照槽：写入端整体替换（生产语义=每 tick 全量读）
        std::sync::mpsc::Sender<(i64, Result<CronExecOutput, String>, u64)>,
        Arc<Mutex<Vec<CronRunRecord>>>,
        CancellationToken,
        tokio::task::JoinHandle<CronLoopEnd>,
    ) {
        let jobs_snapshot: Arc<Mutex<Vec<CronJobView>>> = Arc::new(Mutex::new(Vec::new()));
        let (exec_tx, exec_rx) =
            std::sync::mpsc::channel::<(i64, Result<CronExecOutput, String>, u64)>();
        let runs: Arc<Mutex<Vec<CronRunRecord>>> = Arc::new(Mutex::new(Vec::new()));
        let cancel = CancellationToken::new();
        let config = CronLoopConfig {
            heartbeat: Duration::from_millis(10),
            exec_timeout,
            output_cap: 64 * 1024,
            phase_seed: "test".into(),
        };
        let clock_fn: CronClock = {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        };
        let jobs_provider: CronJobsProvider = {
            let snap = Arc::clone(&jobs_snapshot);
            Arc::new(move || snap.lock().unwrap().clone())
        };
        let runs_sink = Arc::clone(&runs);
        let run_sink: CronRunSink = Arc::new(move |r| runs_sink.lock().unwrap().push(r));
        let resolver: CronExecResolver = {
            let rx = Arc::new(Mutex::new(exec_rx));
            Arc::new(move |job: &CronJobView| {
                let (jid, outcome, delay_ms) = rx
                    .lock()
                    .unwrap()
                    .try_recv()
                    .map_err(|_| "no scripted exec (job not connected)".to_string())?;
                let _ = jid;
                let _ = job;
                Ok(Box::pin(async move {
                    if delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    outcome
                }) as BoxedCronExec)
            })
        };
        let handle = tokio::spawn(run_cron_scheduler(
            cancel.clone(),
            config,
            clock_fn,
            jobs_provider,
            resolver,
            run_sink,
        ));
        (jobs_snapshot, exec_tx, runs, cancel, handle)
    }

    fn job(id: i64, schedule: &str) -> CronJobView {
        CronJobView {
            id,
            host_id: 100 + id,
            schedule: schedule.into(),
            enabled: true,
        }
    }

    async fn wait_for(runs: &Arc<Mutex<Vec<CronRunRecord>>>, n: usize) -> Vec<CronRunRecord> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let got = runs.lock().unwrap().clone();
            if got.len() >= n {
                return got;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {n} runs, got {:?}",
                got.len()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// 分钟对齐虚拟钟：起点 = 当前分起点 +30s（分中）。
    /// 【驱动纪律】start() 后先让循环跑过首个对账拍（next-fire 自 t0 初始化
    /// 为下一分界），**再**拨钟——否则 nf 会从已拨快的钟初始化，永远追不上。
    async fn settle_first_tick() {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    fn virtual_clock() -> (Arc<AtomicI64>, i64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let boundary = now - now % 60; // 当前分起点
        let t0 = boundary + 30; // 分中
        (Arc::new(AtomicI64::new(t0)), t0)
    }

    #[tokio::test]
    async fn fires_when_due_and_advances() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: b"hi".to_vec(),
                    stderr: vec![],
                }),
                0,
            ))
            .unwrap();
        settle_first_tick().await;
        // 推进越过下一分界 → 到点触发
        clock.store(t0 + 40, Ordering::SeqCst); // 下一分界 +10s
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].cron_id, 1);
        assert_eq!(got[0].status, CronRunStatus::Ok);
        assert_eq!(got[0].exit_code, Some(0));
        assert_eq!(got[0].output, "hi");
        assert!(got[0].error.is_none());
        // 再推进一分 → 第二轮（不与首轮同刻叠跑）
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                0,
            ))
            .unwrap();
        clock.fetch_add(60, Ordering::SeqCst);
        let got = wait_for(&runs, 2).await;
        assert!(got[1].ts >= got[0].ts + 55, "两轮 ts 必须是不同分界");
        cancel.cancel();
        assert_eq!(handle.await.unwrap(), CronLoopEnd::Cancelled);
    }

    #[tokio::test]
    async fn no_session_becomes_missed() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(7, "* * * * *")];
        // 不投 exec 脚本 → resolver 同步 Err（无脚本=会话不在）
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].status, CronRunStatus::Missed);
        assert_eq!(got[0].exit_code, None);
        assert!(got[0].error.as_deref().unwrap().contains("not connected"));
        let _ = exec_tx; // 保持脚本写入端存活（resolver 侧无脚本可取 = 同步 Err）
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn nonzero_exit_is_failed_with_code() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(3),
                    stdout: b"boom".to_vec(),
                    stderr: b"err!".to_vec(),
                }),
                0,
            ))
            .unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].status, CronRunStatus::Failed);
        assert_eq!(got[0].exit_code, Some(3));
        assert_eq!(got[0].error.as_deref(), Some("exit code 3"));
        assert_eq!(got[0].output, "boom\n[stderr]\nerr!");
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn exec_error_is_failed_with_message() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        exec_tx.send((1, Err("channel closed".into()), 0)).unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].status, CronRunStatus::Failed);
        assert_eq!(got[0].error.as_deref(), Some("channel closed"));
        assert_eq!(got[0].exit_code, None);
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn slow_exec_times_out() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_millis(50));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                500,
            ))
            .unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].status, CronRunStatus::Timeout);
        assert_eq!(got[0].exit_code, None);
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn disabled_jobs_never_fire() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, _exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![CronJobView {
            id: 1,
            host_id: 101,
            schedule: "* * * * *".into(),
            enabled: false,
        }];
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(runs.lock().unwrap().is_empty(), "disabled 不得触发");
        clock.fetch_add(120, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(runs.lock().unwrap().is_empty());
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn bad_schedule_is_skipped_not_fatal() {
        let (clock, t0) = virtual_clock();
        // 丢掉 exec 脚本写入端：所有触发都走 resolver Err → missed——
        // missed 记录本身就是「循环活着」的证据。
        let (jobs_tx, _exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "garbage schedule here"), job(2, "* * * * *")];
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert!(
            got.iter().all(|r| r.cron_id != 1),
            "坏 schedule 的任务不得触发: {got:?}"
        );
        assert!(
            got.iter().any(|r| r.cron_id == 2),
            "健康任务照常（missed 也是循环活着的证据）"
        );
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn deleted_job_drops_from_cache() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                0,
            ))
            .unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        assert_eq!(got[0].cron_id, 1);
        // 任务被删（快照不再含 id=1）→ 之后不再触发
        jobs_tx.lock().unwrap().clear();
        clock.fetch_add(120, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(runs.lock().unwrap().len(), 1, "删除后不得再触发");
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn overlap_is_skipped_not_queued() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        // 第一轮：慢执行（300ms，timeout 5s 不截断）
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                300,
            ))
            .unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40, Ordering::SeqCst); // 第一轮到点
        tokio::time::sleep(Duration::from_millis(60)).await; // 等它进 exec（in-flight）
        // 第一轮还在跑时跨过两个分界：全部让位（不叠跑不补跑）
        clock.fetch_add(120, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(runs.lock().unwrap().len(), 0, "在途期间不得产生第二轮");
        // 第一轮完成
        let got = wait_for(&runs, 1).await;
        assert_eq!(got.len(), 1);
        // 再跨一个分界（此时已空闲）→ 正常触发下一轮
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                0,
            ))
            .unwrap();
        clock.fetch_add(60, Ordering::SeqCst);
        let got = wait_for(&runs, 2).await;
        assert_eq!(got.len(), 2, "空闲后恢复触发（跳过的不补）");
        cancel.cancel();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn long_stall_does_not_replay_missed_rounds() {
        let (clock, t0) = virtual_clock();
        let (jobs_tx, exec_tx, runs, cancel, handle) =
            start(Arc::clone(&clock), Duration::from_secs(5));
        *jobs_tx.lock().unwrap() = vec![job(1, "* * * * *")];
        // 首个 next-fire 初始化后，一次性跳过 5 个分界再让循环对账：
        // 只允许 1 条（最近一次），不得补放 5 条
        exec_tx
            .send((
                1,
                Ok(CronExecOutput {
                    exit_code: Some(0),
                    stdout: vec![],
                    stderr: vec![],
                }),
                0,
            ))
            .unwrap();
        settle_first_tick().await;
        clock.store(t0 + 40 + 5 * 60, Ordering::SeqCst);
        let got = wait_for(&runs, 1).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            got.len(),
            1,
            "停摆只补最近一次，不逐轮补放: {}",
            runs.lock().unwrap().len()
        );
        cancel.cancel();
        let _ = handle.await;
    }

    #[test]
    fn combine_output_marks_truncation() {
        let (text, truncated) = combine_output(b"out", b"err", 1024);
        assert_eq!(text, "out\n[stderr]\nerr");
        assert!(!truncated);
        let (text, truncated) = combine_output(&[b'x'; 100], &[], 50);
        assert!(truncated);
        assert_eq!(text.chars().count(), 50);
        let (text, truncated) = combine_output(&[], &[b'y'; 10], 4);
        assert_eq!(text, "yyyy");
        assert!(truncated);
    }

    #[test]
    fn settle_maps_exit_codes() {
        let started = Instant::now();
        let r = settle(
            1,
            100,
            &started,
            Ok(Ok(CronExecOutput {
                exit_code: Some(0),
                stdout: b"ok".to_vec(),
                stderr: vec![],
            })),
            1024,
        );
        assert_eq!(r.status, CronRunStatus::Ok);
        let r = settle(
            1,
            100,
            &started,
            Ok(Ok(CronExecOutput {
                exit_code: None,
                stdout: vec![],
                stderr: vec![],
            })),
            1024,
        );
        assert_eq!(r.status, CronRunStatus::Failed);
        assert!(r.error.as_deref().unwrap().contains("exit status"));
    }
}
