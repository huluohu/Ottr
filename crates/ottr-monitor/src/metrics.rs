//! 采样值模型：[`RawSample`]（一次 exec 的瞬时读数）与 [`Metrics`]
//! （两次差分后的可展示/可序列化指标，事件载荷直出面）。
//!
//! 差分口径（Phase 3 Task 1 简报）：
//! * CPU%：/proc/stat 两次采样差分（`1 − Δidle/Δtotal`，夹取 0-100；
//!   首采样无基线 → 跳过首轮，`diff` 返回 `None`）；
//! * 内存：MemTotal − MemAvailable（瞬时值，无需差分）；
//! * 网络：rx/tx 字节差分 ÷ 间隔秒（计数器回绕/清零——`now < prev`——按 0 计）。

use std::time::Duration;

use serde::Serialize;

use crate::parse::{DiskEntry, LoadAvg, MemInfo, NetCounters, StatCounters};

/// 一次采集的原始读数（瞬时计数，不含任何差分状态）。
#[derive(Debug, Clone)]
pub struct RawSample {
    pub stat: StatCounters,
    pub mem: MemInfo,
    pub load: LoadAvg,
    pub net: NetCounters,
    pub disk: Vec<DiskEntry>,
}

/// 差分后的指标（`ottr://monitor` 事件载荷，serde snake_case 直出前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Metrics {
    /// CPU 使用率（0.0-100.0）。
    pub cpu_percent: f64,
    pub mem_used_percent: f64,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub load_one: f64,
    pub load_five: f64,
    pub load_fifteen: f64,
    /// 网络速率（字节/秒，非 lo 接口合计）。
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub disk: Vec<DiskEntry>,
}

impl Metrics {
    /// 两次采样差分。`prev` 缺席（首轮）或间隔为 0 → `None`（跳过该轮）。
    pub fn from_diff(prev: &RawSample, now: &RawSample, dt: Duration) -> Option<Metrics> {
        let dt_secs = dt.as_secs_f64();
        if dt_secs <= 0.0 {
            return None;
        }
        // CPU%：总跳动为 0（采样过密/时钟停滞）按 0% 处理，不除零
        let d_total = now.stat.total.saturating_sub(prev.stat.total);
        let d_idle = now.stat.idle.saturating_sub(prev.stat.idle);
        let cpu_percent = clamp01_100(if d_total == 0 {
            0.0
        } else {
            (1.0 - d_idle as f64 / d_total as f64) * 100.0
        });
        // 网络：差分速率；计数器回绕/接口重建（now < prev）按 0 计
        let net_rx_bps = rate(prev.net.rx_bytes, now.net.rx_bytes, dt_secs);
        let net_tx_bps = rate(prev.net.tx_bytes, now.net.tx_bytes, dt_secs);

        let mem_used_kb = now.mem.used_kb();
        Some(Metrics {
            cpu_percent,
            mem_used_percent: clamp01_100(if now.mem.total_kb == 0 {
                0.0
            } else {
                mem_used_kb as f64 * 100.0 / now.mem.total_kb as f64
            }),
            mem_total_kb: now.mem.total_kb,
            mem_used_kb,
            load_one: now.load.one,
            load_five: now.load.five,
            load_fifteen: now.load.fifteen,
            net_rx_bps,
            net_tx_bps,
            disk: now.disk.clone(),
        })
    }
}

/// (now − prev)/dt，回绕（now < prev）按 0。
fn rate(prev: u64, now: u64, dt_secs: f64) -> f64 {
    if now <= prev {
        return 0.0;
    }
    (now - prev) as f64 / dt_secs
}

/// 夹取到 [0, 100] 且排除 NaN（差分扰动不外泄）。
fn clamp01_100(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    v.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::DiskEntry;

    fn sample(total: u64, idle: u64, rx: u64, tx: u64) -> RawSample {
        RawSample {
            stat: StatCounters { total, idle },
            mem: MemInfo {
                total_kb: 1000,
                available_kb: 250,
            },
            load: LoadAvg {
                one: 0.5,
                five: 0.4,
                fifteen: 0.3,
            },
            net: NetCounters {
                rx_bytes: rx,
                tx_bytes: tx,
            },
            disk: vec![DiskEntry {
                filesystem: "overlay".into(),
                total_kb: 100,
                used_kb: 20,
                avail_kb: 80,
                used_percent: 20.0,
                mount: "/".into(),
            }],
        }
    }

    #[test]
    fn diff_computes_cpu_percent_and_net_rates() {
        let prev = sample(1000, 800, 1_000, 2_000);
        let now = sample(2000, 1700, 3_000, 2_500);
        let m = Metrics::from_diff(&prev, &now, Duration::from_secs(10)).expect("diff");
        // Δtotal=1000、Δidle=900 → CPU = (1−0.9)×100 = 10%
        assert!((m.cpu_percent - 10.0).abs() < 1e-9);
        // Δrx=2000/10s = 200 B/s；Δtx=500/10s = 50 B/s
        assert!((m.net_rx_bps - 200.0).abs() < 1e-9);
        assert!((m.net_tx_bps - 50.0).abs() < 1e-9);
        // 瞬时面直通：mem 75%、负载 0.5/0.4/0.3、磁盘条目随 now
        assert!((m.mem_used_percent - 75.0).abs() < 1e-9);
        assert_eq!(m.mem_used_kb, 750);
        assert_eq!(m.load_one, 0.5);
        assert_eq!(m.disk.len(), 1);
    }

    #[test]
    fn diff_identical_samples_is_idle_zero_cpu() {
        // 「首轮跳过」由调度循环的 prev: Option 承担（task.rs）；这里锁同采样
        // 差分语义：Δtotal=0 → CPU 0%，速率 0。
        let s = sample(1000, 800, 500, 500);
        let m = Metrics::from_diff(&s, &s, Duration::from_secs(5)).expect("diff");
        assert_eq!(m.cpu_percent, 0.0);
        assert_eq!(m.net_rx_bps, 0.0);
        assert_eq!(m.net_tx_bps, 0.0);
    }

    #[test]
    fn diff_zero_interval_and_counter_wrap_guarded() {
        let s = sample(1000, 800, 100, 100);
        // 零间隔 → None（除零防护）
        assert!(Metrics::from_diff(&s, &s, Duration::ZERO).is_none());
        // 计数器回绕（接口重建/溢出）：速率按 0
        let m = Metrics::from_diff(&sample(2000, 800, 5_000, 5_000), &s, Duration::from_secs(1))
            .expect("diff");
        assert_eq!(m.net_rx_bps, 0.0);
        assert_eq!(m.net_tx_bps, 0.0);
        // CPU 负差分（saturating）→ 0%
        assert_eq!(m.cpu_percent, 0.0);
    }

    #[test]
    fn cpu_percent_clamped_to_unit_range() {
        // idle 增量超过 total（理论上不可能，防御性夹取）
        let prev = sample(1000, 800, 0, 0);
        let now = sample(1100, 1300, 0, 0);
        let m = Metrics::from_diff(&prev, &now, Duration::from_secs(1)).expect("diff");
        assert_eq!(m.cpu_percent, 0.0);
        // 全忙（idle 无增长）→ 100%
        let now = sample(2000, 800, 0, 0);
        let m = Metrics::from_diff(&prev, &now, Duration::from_secs(1)).expect("diff");
        assert!((m.cpu_percent - 100.0).abs() < 1e-9);
    }
}
