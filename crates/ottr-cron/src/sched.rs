//! 采样调度参数：默认间隔 / 随机抖动（防周期对齐）/ 全局相位错开（防惊群）。
//!
//! * **抖动 ±10%**：每轮间隔在基准值 ±[`JITTER_PERCENT`]% 内伪随机漂移，
//!   长跑下多实例的采样时刻不会长期对齐（单一固定周期只会把相位差推到
//!   永久同刻）。
//! * **全局相位错开**：同刻新建的多个会话若都「立即首采、同周期轮转」，
//!   每一轮都挤在同一瞬间（惊群：N 条 exec 通道同时开）。首采样前按
//!   `fnv1a(session_id) mod interval` 决定相位延迟——确定性（同一会话重连
//!   相位稳定）、零共享状态（不需要全局锁/时钟）、天然均匀分散。
//!   伪随机源为 xorshift64，种子 = 会话 id FNV-1a——可复现（测试断言范围
//!   而非时序）。

use std::time::Duration;

/// 默认采样间隔（简报定值 5s；settings `monitor.interval_secs` 可配）。
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(5);
/// 抖动幅度（±10%，简报定值）。
pub const JITTER_PERCENT: u32 = 10;

/// FNV-1a 64 位（会话 id → 稳定种子/相位）。
pub fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// xorshift64 伪随机序列（种子非零；每实例独享，无跨线程共享状态）。
#[derive(Debug, Clone)]
pub struct JitterRng {
    state: u64,
}

impl JitterRng {
    pub fn from_seed(seed: u64) -> Self {
        JitterRng {
            state: seed | 1, // xorshift 种子不得为 0
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }
}

/// 首采样相位延迟：`fnv1a(seed) mod interval`（确定性全局错开）。
pub fn phase_delay(seed: &str, interval: Duration) -> Duration {
    let ms = u64::try_from(interval.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    Duration::from_millis(fnv1a(seed) % ms)
}

/// 基准间隔 ±`percent`% 内的抖动值（`rnd` 均匀映射到偏移带；下限 1ms）。
pub fn jittered(interval: Duration, percent: u32, rnd: u64) -> Duration {
    let base = interval.as_millis() as i128;
    let span = base * i128::from(percent) / 100;
    let offset = i128::from(rnd % u64::try_from(2 * span + 1).unwrap_or(u64::MAX)) - span;
    Duration::from_millis((base + offset).max(1) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jitter_stays_within_band() {
        // 1000 次抖动全部落在 [0.9×, 1.1×]（±10% 带）
        let interval = Duration::from_secs(5);
        let mut rng = JitterRng::from_seed(fnv1a("pty-1"));
        for _ in 0..1000 {
            let j = jittered(interval, JITTER_PERCENT, rng.next_u64());
            let ms = j.as_millis();
            assert!(
                (4500..=5500).contains(&ms),
                "jitter {ms}ms 越界（基准 5000 ± 500）"
            );
        }
        // 极端参数：0% 抖动 = 原值；1ms 基准不塌缩到 0
        assert_eq!(jittered(interval, 0, 42), interval);
        assert!(jittered(Duration::from_millis(1), 10, u64::MAX).as_millis() >= 1);
    }

    #[test]
    fn phase_delay_is_deterministic_and_spread() {
        // 确定性：同 id 同相位（重连/重启后相位稳定）
        assert_eq!(
            phase_delay("pty-7", DEFAULT_INTERVAL),
            phase_delay("pty-7", DEFAULT_INTERVAL)
        );
        let d = phase_delay("pty-7", DEFAULT_INTERVAL);
        assert!(d < DEFAULT_INTERVAL, "相位必须落在首个周期内");
        // 分散性：100 个会话 id 在 100 桶内至少铺开 50 桶
        // （均匀随机期望 ≈63，方差内 58+ 常见；「惊群」行为则只有 1-2 桶）
        let mut buckets = std::collections::HashSet::new();
        for i in 0..100 {
            let d = phase_delay(&format!("pty-{i}"), Duration::from_millis(100));
            buckets.insert(d.as_millis());
        }
        assert!(
            buckets.len() >= 50,
            "相位只铺开 {} 桶/100，防惊群失效",
            buckets.len()
        );
    }

    #[test]
    fn fnv1a_matches_known_vectors() {
        // FNV-1a 64 公开测试向量（"" 与 "a"）
        assert_eq!(fnv1a(""), 0xcbf29ce484222325);
        assert_eq!(fnv1a("a"), 0xaf63dc4c8601ec8c);
    }
}
