//! 只读采集命令输出的解析器（Phase 3 Task 1 Step 1，严格 TDD）。
//!
//! 全部函数吃 `&str`、吐值类型，零 I/O——golden 用真实 /proc 样本快照
//! （`fixtures/monitor/*.txt`，取自 ottr-sshd 夹具容器 Debian bookworm）。
//! 解析失败一律 `None`/空表，由 [`crate::collect`] 归类为
//! Unsupported（非 Linux 远端）或 Malformed（Linux 但输出异常）。
//!
//! 数值口径：
//! * `/proc/stat`：取聚合行 `cpu`（全核之和），total = 全字段和，
//!   idle = idle + iowait（iowait 计入空闲口径——两次差分后 CPU% =
//!   1 − Δidle/Δtotal，与 top/vmstat 同口径）；
//! * `/proc/meminfo`：MemTotal − MemAvailable（可回收口径；老内核无
//!   MemAvailable 时回退 MemFree + Buffers + Cached，见 `MEMAVAILABLE_FALLBACK`）；
//! * `/proc/net/dev`：逐非 `lo` 接口累加 rx_bytes（列 0）/ tx_bytes（列 8）
//!   ——lo 是本机回环，不该出现在远端主机对外流量的监控面；
//! * `df -k`：6 列常规行直读；超长设备名换行（1 列行 + 5 列行）按 GNU df
//!   的折行规则拼回（golden `df_k_wrapped.txt`）。头部行跳过。

/// `/proc/stat` 聚合计数（两次采样差分算 CPU%）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatCounters {
    /// `cpu` 行全字段之和（jiffies 口径）。
    pub total: u64,
    /// idle + iowait（空闲口径）。
    pub idle: u64,
}

/// `/proc/meminfo` 内存水位（kB，原表单位）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemInfo {
    pub total_kb: u64,
    pub available_kb: u64,
}

impl MemInfo {
    /// 已用字节水位（kB）：MemTotal − MemAvailable。
    pub fn used_kb(&self) -> u64 {
        self.total_kb.saturating_sub(self.available_kb)
    }
}

/// `/proc/loadavg` 三个运行队列均值。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadAvg {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

/// `/proc/net/dev` 累计计数（两次采样差分算速率）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NetCounters {
    /// 非 lo 接口 rx 字节和。
    pub rx_bytes: u64,
    /// 非 lo 接口 tx 字节和。
    pub tx_bytes: u64,
}

/// `df -k` 单文件系统条目。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiskEntry {
    pub filesystem: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    /// 使用率（0-100；优先 df 的 Use% 列，缺列时按 used/total 计算）。
    pub used_percent: f64,
    pub mount: String,
}

/// `/proc/stat` 解析：聚合行 `cpu` 缺失 = `None`（非 Linux /proc 的判定位）。
pub fn parse_proc_stat(text: &str) -> Option<StatCounters> {
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("cpu ") else {
            continue;
        };
        let fields: Vec<u64> = rest
            .split_whitespace()
            .map(|f| f.parse::<u64>())
            .collect::<Result<_, _>>()
            .ok()?;
        // 2.6+ 内核至少 user/nice/system/idle 四列；iowait（第 5 列）存在才计入。
        if fields.len() < 4 {
            return None;
        }
        let total: u64 = fields.iter().sum();
        let idle = fields[3] + fields.get(4).copied().unwrap_or(0);
        return Some(StatCounters { total, idle });
    }
    None
}

/// `/proc/meminfo` 解析：MemTotal 或（回退后）可用水位缺失 = `None`。
pub fn parse_proc_meminfo(text: &str) -> Option<MemInfo> {
    let field = |prefix: &str| -> Option<u64> {
        text.lines().find_map(|l| {
            l.strip_prefix(prefix)
                .and_then(|rest| rest.trim_start().split_whitespace().next())
                .and_then(|v| v.parse::<u64>().ok())
        })
    };
    let total_kb = field("MemTotal:")?;
    // 老内核（<3.14）无 MemAvailable：MemFree + Buffers + Cached 近似可回收。
    let available_kb = field("MemAvailable:").unwrap_or_else(|| {
        let free = field("MemFree:").unwrap_or(0);
        let buffers = field("Buffers:").unwrap_or(0);
        let cached = field("Cached:").unwrap_or(0);
        free + buffers + cached
    });
    Some(MemInfo {
        total_kb,
        available_kb,
    })
}

/// `/proc/loadavg` 解析：首三列 f64（4.x 尾段 `3/1001 518` 不参与）。
pub fn parse_proc_loadavg(text: &str) -> Option<LoadAvg> {
    let mut it = text.split_whitespace();
    let one = it.next()?.parse::<f64>().ok()?;
    let five = it.next()?.parse::<f64>().ok()?;
    let fifteen = it.next()?.parse::<f64>().ok()?;
    Some(LoadAvg { one, five, fifteen })
}

/// `/proc/net/dev` 解析：逐数据行 `iface: 16 列`，非 lo 累加。
/// rx_bytes = 列 0、tx_bytes = 列 8（recv: bytes packets errs drop fifo frame
/// compressed multicast | transmit: 同序 8 列）。
pub fn parse_proc_net_dev(text: &str) -> Option<NetCounters> {
    let mut out = NetCounters::default();
    let mut seen = 0usize;
    for line in text.lines() {
        let Some((iface, cols)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let nums: Vec<u64> = cols
            .split_whitespace()
            .map(|c| c.parse::<u64>().unwrap_or(0))
            .collect();
        if nums.len() < 9 {
            continue;
        }
        seen += 1;
        out.rx_bytes = out.rx_bytes.saturating_add(nums[0]);
        out.tx_bytes = out.tx_bytes.saturating_add(nums[8]);
    }
    (seen > 0).then_some(out)
}

/// `df -k` 解析：跳头部；6 列常规行直读；GNU df 长设备名折行
/// （1 列行随后跟 5 列行）拼回。`mount`/`filesystem` 恒非空才入表。
pub fn parse_df_k(text: &str) -> Vec<DiskEntry> {
    let mut out = Vec::new();
    let mut pending_fs: Option<String> = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match fields.len() {
            // GNU df 折行的第一段：裸设备名一行
            1 => pending_fs = Some(fields[0].to_string()),
            5 => {
                // 折行的数据段：设备名在 pending（丢了的条目跳过——malformed）
                let Some(fs) = pending_fs.take() else {
                    continue;
                };
                if let Some(e) = df_entry(fs, &fields) {
                    out.push(e);
                }
            }
            6 => {
                if fields[0] == "Filesystem" {
                    continue; // 头部
                }
                pending_fs = None;
                if let Some(e) = df_entry(fields[0].to_string(), &fields[1..]) {
                    out.push(e);
                }
            }
            _ => {}
        }
    }
    out
}

/// 数据段 → 条目。`cols` = [1K-blocks, Used, Avail, Use%, Mount]。
/// 任一数值列坏 = 丢弃该条目（监控面宁缺毋错）。
fn df_entry(filesystem: String, cols: &[&str]) -> Option<DiskEntry> {
    if cols.len() != 5 {
        return None;
    }
    let total_kb = cols[0].parse::<u64>().ok()?;
    let used_kb = cols[1].parse::<u64>().ok()?;
    let avail_kb = cols[2].parse::<u64>().ok()?;
    let mount = cols[4].to_string();
    if mount.is_empty() {
        return None;
    }
    // Use% 列带 '%' 后缀；解析失败按 used/total 现算（含除零防护）。
    let used_percent = cols[3]
        .trim_end_matches('%')
        .parse::<f64>()
        .ok()
        .unwrap_or_else(|| {
            if total_kb == 0 {
                0.0
            } else {
                used_kb as f64 * 100.0 / total_kb as f64
            }
        });
    Some(DiskEntry {
        filesystem,
        total_kb,
        used_kb,
        avail_kb,
        used_percent,
        mount,
    })
}

// ---------------------------------------------------------------------------
// 测试：golden（真实 /proc 快照 fixtures）+ 折行/老内核/计数器回绕等边界
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// fixtures/monitor 下的真实快照（ottr-sshd 容器，Debian bookworm）。
    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!(
            "{}/../../fixtures/monitor/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap_or_else(|e| panic!("read fixture {name}: {e}"))
    }

    #[test]
    fn proc_stat_golden_real_snapshot() {
        let s = parse_proc_stat(&fixture("proc_stat.txt")).expect("aggregate cpu line");
        // 快照（与 fixtures/monitor/proc_stat.txt 首行逐列对账；快照为冻结文件，
        // 期望值不随后续抓样漂移）：
        // cpu  3112201 0 1220646 26462406 50876 0 1422782 0 0 0
        let user = 3_112_201u64;
        let system = 1_220_646;
        let idle0 = 26_462_406;
        let iowait = 50_876;
        let softirq = 1_422_782;
        assert_eq!(
            s.total,
            user + system + idle0 + iowait + softirq,
            "total = 全字段和"
        );
        assert_eq!(s.idle, idle0 + iowait, "idle = idle + iowait");
        assert!(s.idle <= s.total);
    }

    #[test]
    fn proc_stat_takes_aggregate_line_not_per_core() {
        // 聚合行 + 双核明细行：只取聚合（值 ≠ 任一明细行）
        let text = "cpu  100 0 100 600 0 0 0 0 0 0\ncpu0 90 0 60 350 0 0 0 0 0 0\ncpu1 10 0 40 250 0 0 0 0 0 0\n";
        let s = parse_proc_stat(text).expect("aggregate");
        assert_eq!(s.total, 800);
        assert_eq!(s.idle, 600);
    }

    #[test]
    fn proc_stat_missing_aggregate_line_is_none() {
        // 无 `cpu ` 聚合行 = collect 层的 Unsupported 判定位
        assert_eq!(parse_proc_stat("cpu0 1 2 3 4\nintr 5\n"), None);
        assert_eq!(parse_proc_stat(""), None);
        // 列数不足（老格式残缺）同样拒绝
        assert_eq!(parse_proc_stat("cpu 1 2 3\n"), None);
    }

    #[test]
    fn proc_meminfo_golden_real_snapshot() {
        let m = parse_proc_meminfo(&fixture("proc_meminfo.txt")).expect("MemTotal present");
        // 快照：MemTotal 6137524 kB / MemAvailable 1572236 kB（冻结文件口径）
        assert_eq!(m.total_kb, 6_137_524);
        assert_eq!(m.available_kb, 1_572_236);
        assert_eq!(m.used_kb(), 6_137_524 - 1_572_236);
    }

    #[test]
    fn proc_meminfo_falls_back_without_memavailable() {
        // 老内核形态：只有 MemFree/Buffers/Cached
        let old = "MemTotal:        1000 kB\nMemFree:          100 kB\nBuffers:           50 kB\nCached:           150 kB\n";
        let m = parse_proc_meminfo(old).expect("fallback");
        assert_eq!(m.total_kb, 1000);
        assert_eq!(m.available_kb, 300, "MemFree+Buffers+Cached 回退口径");
        assert_eq!(m.used_kb(), 700);
        assert_eq!(parse_proc_meminfo("SwapTotal: 1 kB\n"), None);
    }

    #[test]
    fn proc_loadavg_golden_and_malformed() {
        let l = parse_proc_loadavg(&fixture("proc_loadavg.txt")).expect("three floats");
        assert_eq!(
            l,
            LoadAvg {
                one: 1.10,
                five: 0.88,
                fifteen: 0.75
            }
        );
        assert_eq!(parse_proc_loadavg("0.00 0.01"), None, "不足三列拒绝");
        assert_eq!(parse_proc_loadavg("a b c d"), None);
    }

    #[test]
    fn proc_net_dev_golden_sums_non_loopback() {
        let n = parse_proc_net_dev(&fixture("proc_net_dev.txt")).expect("data lines");
        // 快照：lo 26845/26845、eth0 34742534/79002990 —— lo 不计入
        assert_eq!(n.rx_bytes, 34_742_534);
        assert_eq!(n.tx_bytes, 79_002_990);
    }

    #[test]
    fn proc_net_dev_multi_iface_and_empty() {
        let two = "inter-| header\n face |cols\n  lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n wlan0: 5 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0\n";
        let n = parse_proc_net_dev(two).expect("two ifaces");
        assert_eq!(n.rx_bytes, 15);
        assert_eq!(n.tx_bytes, 27);
        // 只有 lo → 无数据行 = None（collect 层按 Malformed 处置）
        assert_eq!(
            parse_proc_net_dev("head\n face |\n  lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n"),
            None
        );
        assert_eq!(parse_proc_net_dev(""), None);
    }

    #[test]
    fn df_k_golden_real_snapshot() {
        let rows = parse_df_k(&fixture("df_k.txt"));
        assert!(rows.len() >= 5, "夹具容器至少 5 个挂载点: {rows:?}");
        let root = rows.iter().find(|r| r.mount == "/").expect("root entry");
        assert_eq!(root.filesystem, "overlay");
        assert_eq!(root.total_kb, 516_489_216);
        assert_eq!(root.used_kb, 102_948_288);
        assert_eq!(root.avail_kb, 413_540_928);
        assert!((root.used_percent - 20.0).abs() < f64::EPSILON);
    }

    #[test]
    fn df_k_wrapped_long_device_name() {
        // GNU df 长设备名折行：1 列行 + 5 列数据行拼回
        let wrapped = "Filesystem     1K-blocks      Used Available Use% Mounted on\n\
/dev/mapper/very--long--vg--name-slowstorage\n\
               516489216 102948288 413540928  20% /srv\n\
overlay        516489216 102948288 413540928  20% /\n";
        let rows = parse_df_k(wrapped);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(
            rows[0].filesystem,
            "/dev/mapper/very--long--vg--name-slowstorage"
        );
        assert_eq!(rows[0].mount, "/srv");
        assert_eq!(rows[0].total_kb, 516_489_216);
        assert_eq!(rows[1].filesystem, "overlay");
        assert_eq!(rows[1].mount, "/");
    }

    #[test]
    fn df_k_skips_malformed_and_computes_missing_use_percent() {
        // 5 列行无 pending 设备名（折行名丢失）→ 跳过；Use% 坏列 → 现算
        let text = "Filesystem 1K-blocks Used Available Use% Mounted on\n\
               100 10 90 bad% /x\n\
tmpfs 100 25 75 25% /tmp\n";
        let rows = parse_df_k(text);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].mount, "/tmp");
        let calc =
            "Filesystem 1K-blocks Used Available Use% Mounted on\ntmpfs 200 50 150 25 /tmp\n";
        let rows = parse_df_k(calc);
        assert!(
            (rows[0].used_percent - 25.0).abs() < f64::EPSILON,
            "现算 used/total"
        );
    }
}
