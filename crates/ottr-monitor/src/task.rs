//! 通用采样循环（[`run_sampling`]）：相位错开 → 基线采样 → 差分轮转，
//! 取消/生命周期 owner 化（[`MonitorGuard`] Drop 即停）。
//!
//! 与传输面解耦：采集与消费都是闭包（crate 内测试用计数器/罐头样本驱动，
//! 无需 SSH；src-tauri `commands/monitor.rs` 注入真 `collect` + 事件 emit）。
//!
//! 生命周期契约（简报：per-session 采样任务挂会话生命周期——断开/关闭即停）：
//! * [`MonitorGuard`] 持取消令牌，**Drop 即 cancel**——会话表项移除
//!   （`session_down`）或显式 `monitor_stop` 时摘除即停；
//! * 循环自保底：exec 失败按「连续失败」计数，超过 [`LoopConfig::max_consecutive_failures`]
//!   自行终止（会话死了不空转）；
//! * [`MonitorError::Unsupported`] 短路终止（非 Linux 重试无义）。

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::collect::MonitorError;
use crate::metrics::{Metrics, RawSample};
use ottr_cron::sched::{JITTER_PERCENT, JitterRng, jittered, phase_delay};

/// 循环参数。`interval` 为基准值（实际每轮 ±jitter 抖动）。
#[derive(Debug, Clone)]
pub struct LoopConfig {
    pub interval: Duration,
    pub jitter_percent: u32,
    /// 单次采集限时（exec 挂死不拖垮轮转节拍）。
    pub exec_timeout: Duration,
    /// 连续失败上限（达到即终止——会话已死，不空转）。
    pub max_consecutive_failures: u32,
}

impl LoopConfig {
    /// 生产参数（exec 限时 10s = LANG 探测同款；连续失败 3 次）。
    pub fn production(interval: Duration) -> Self {
        LoopConfig {
            interval,
            jitter_percent: JITTER_PERCENT,
            exec_timeout: Duration::from_secs(10),
            max_consecutive_failures: 3,
        }
    }
}

/// 循环终态。`Cancelled` = 主动停（guard Drop / 令牌取消）——正常路径；
/// 其余两态由调用方落终态事件（前端侧栏可见）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SamplingEnd {
    Cancelled,
    Unsupported(String),
    ExcessiveFailures,
}

/// 采样生命周期 owner：持取消令牌，**Drop 即 cancel**（ForwardRun 令牌树
/// 同款语义）。循环任务发现令牌取消即就地退出。
pub struct MonitorGuard(pub CancellationToken);

impl Drop for MonitorGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// 采样循环。`collect` 每轮执行一次（超时受
/// [`LoopConfig::exec_timeout`] 约束）；`emit` 只收**差分成功**的指标
/// （首轮无基线跳过——简报口径）。
pub async fn run_sampling<Col, FutC, Emit, FutE>(
    seed: &str,
    config: LoopConfig,
    cancel: CancellationToken,
    mut collect: Col,
    mut emit: Emit,
) -> SamplingEnd
where
    Col: FnMut() -> FutC,
    FutC: Future<Output = Result<RawSample, MonitorError>>,
    Emit: FnMut(Metrics) -> FutE,
    FutE: Future<Output = ()>,
{
    // 全局相位错开：首采样前按会话 id 决定相位（防多实例同刻惊群）
    tokio::select! {
        _ = tokio::time::sleep(phase_delay(seed, config.interval)) => {}
        _ = cancel.cancelled() => return SamplingEnd::Cancelled,
    }

    let mut rng = JitterRng::from_seed(ottr_cron::sched::fnv1a(seed));
    // 差分基线：None = 首轮（只记基线不 emit）
    let mut prev: Option<(RawSample, std::time::Instant)> = None;
    let mut consecutive_failures: u32 = 0;

    loop {
        let sample = tokio::select! {
            got = tokio::time::timeout(config.exec_timeout, collect()) => match got {
                Ok(Ok(s)) => Some(s),
                Ok(Err(e @ MonitorError::Unsupported { .. })) => {
                    return SamplingEnd::Unsupported(e.to_string());
                }
                Ok(Err(_)) | Err(_) => {
                    consecutive_failures += 1;
                    if consecutive_failures >= config.max_consecutive_failures {
                        return SamplingEnd::ExcessiveFailures;
                    }
                    None
                }
            },
            _ = cancel.cancelled() => return SamplingEnd::Cancelled,
        };
        if let Some(sample) = sample {
            // 打点即「拿到样本的时刻」，差分间隔以此为准
            let now_at = std::time::Instant::now();
            consecutive_failures = 0;
            if let Some((prev, prev_at)) = prev.take() {
                let dt = now_at.saturating_duration_since(prev_at);
                if let Some(m) = Metrics::from_diff(&prev, &sample, dt) {
                    emit(m).await;
                }
            }
            prev = Some((sample, now_at));
        }
        // 抖动轮转（±jitter_percent，防长跑周期对齐）
        let pause = jittered(config.interval, config.jitter_percent, rng.next_u64());
        tokio::select! {
            _ = tokio::time::sleep(pause) => {}
            _ = cancel.cancelled() => return SamplingEnd::Cancelled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{DiskEntry, LoadAvg, MemInfo, NetCounters, StatCounters};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    fn sample(total: u64, idle: u64) -> RawSample {
        RawSample {
            stat: StatCounters { total, idle },
            mem: MemInfo {
                total_kb: 100,
                available_kb: 50,
            },
            load: LoadAvg {
                one: 1.0,
                five: 1.0,
                fifteen: 1.0,
            },
            net: NetCounters {
                rx_bytes: total * 10,
                tx_bytes: 0,
            },
            disk: vec![DiskEntry {
                filesystem: "overlay".into(),
                total_kb: 1,
                used_kb: 0,
                avail_kb: 1,
                used_percent: 0.0,
                mount: "/".into(),
            }],
        }
    }

    /// 罐头采样序列（每调一次弹一个；弹尽后重复最后一个）。
    fn canned_sampler(
        seq: Vec<Result<RawSample, MonitorError>>,
    ) -> impl FnMut() -> std::future::Ready<Result<RawSample, MonitorError>> {
        let idx = AtomicU64::new(0);
        let seq = Mutex::new(seq);
        move || {
            let q = seq.lock().unwrap();
            let i = idx.fetch_add(1, Ordering::SeqCst) as usize;
            let item = if i < q.len() {
                q[i].clone()
            } else {
                q.last().unwrap().clone()
            };
            std::future::ready(item)
        }
    }

    fn tiny_config() -> LoopConfig {
        LoopConfig {
            interval: Duration::from_millis(20),
            jitter_percent: 10,
            exec_timeout: Duration::from_secs(1),
            max_consecutive_failures: 3,
        }
    }

    #[tokio::test]
    async fn samples_diff_and_emit_after_baseline() {
        // 首轮只作基线（无 emit），第二轮起差分 emit——简报「跳过首轮」口径。
        // 罐头耗尽后重复末样本 = 循环无自然终点：外层限时兜底（硬超时纪律），
        // 到点即断言已发生的 emit。
        let emits = Arc::new(Mutex::new(Vec::<Metrics>::new()));
        let sink = Arc::clone(&emits);
        let worked = tokio::time::timeout(
            Duration::from_secs(2),
            run_sampling(
                "t1",
                tiny_config(),
                CancellationToken::new(),
                canned_sampler(vec![Ok(sample(1000, 800)), Ok(sample(2000, 1500))]),
                move |m| {
                    let sink = Arc::clone(&sink);
                    async move { sink.lock().unwrap().push(m) }
                },
            ),
        )
        .await;
        assert!(worked.is_err(), "无限循环面必须由限时兜住（不验证终态）");
        let got = emits.lock().unwrap();
        assert!(!got.is_empty(), "首轮后必须有差分 emit");
        // 首个差分：Δtotal=1000、Δidle=700 → CPU = (1−0.7)×100 = 30%
        assert!((got[0].cpu_percent - 30.0).abs() < 1e-9);
        // 网络速率随样本 total×10：Δrx=10000 / 间隔（≥20ms 抖动）> 0
        assert!(got[0].net_rx_bps > 0.0);
    }

    #[tokio::test]
    async fn unsupported_short_circuits_without_emit() {
        let emits = Arc::new(Mutex::new(Vec::<Metrics>::new()));
        let sink = Arc::clone(&emits);
        let end = run_sampling(
            "t2",
            tiny_config(),
            CancellationToken::new(),
            canned_sampler(vec![Err(MonitorError::Unsupported {
                detail: "no /proc".into(),
            })]),
            move |m| {
                let sink = Arc::clone(&sink);
                async move { sink.lock().unwrap().push(m) }
            },
        )
        .await;
        assert!(
            matches!(end, SamplingEnd::Unsupported(ref d) if d.contains("no /proc")),
            "Unsupported 必须短路: {end:?}"
        );
        assert!(emits.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn consecutive_failures_terminate_loop() {
        // 恒失败：第 3 次（max_consecutive_failures）终止，不空转
        let end = run_sampling(
            "t3",
            tiny_config(),
            CancellationToken::new(),
            canned_sampler(vec![Err(MonitorError::Exec("dead".into()))]),
            |_| async {},
        )
        .await;
        assert_eq!(end, SamplingEnd::ExcessiveFailures);
    }

    #[tokio::test]
    async fn cancel_stops_between_and_within_rounds() {
        // 取消贯穿：等待相位/轮转 sleep 时取消即退
        let cancel = CancellationToken::new();
        cancel.cancel();
        let end = run_sampling(
            "t4",
            tiny_config(),
            cancel,
            canned_sampler(vec![]),
            |_| async {},
        )
        .await;
        assert_eq!(end, SamplingEnd::Cancelled);
    }

    /// 生命周期（drop 即停）：guard Drop → 令牌取消 → 循环退出、采样停增。
    #[tokio::test]
    async fn dropping_guard_stops_sampling() {
        let count = Arc::new(AtomicU64::new(0));
        let c = Arc::clone(&count);
        let guard = MonitorGuard(CancellationToken::new());
        let token = guard.0.clone();
        let config = LoopConfig {
            interval: Duration::from_millis(5),
            jitter_percent: 0,
            exec_timeout: Duration::from_secs(1),
            max_consecutive_failures: 3,
        };
        tokio::spawn(run_sampling(
            "t5",
            config,
            token,
            move || {
                let c = Arc::clone(&c);
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok(sample(1, 1))
                }
            },
            |_| async {},
        ));
        // 等到采样确已发生
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while count.load(Ordering::SeqCst) < 3 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(count.load(Ordering::SeqCst) >= 3, "循环未起跑");
        // drop 即停：摘 guard → 循环退出 → 计数停增
        drop(guard);
        tokio::time::sleep(Duration::from_millis(150)).await;
        let frozen = count.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            count.load(Ordering::SeqCst),
            frozen,
            "guard drop 后采样仍在继续（生命周期泄漏）"
        );
    }
}
