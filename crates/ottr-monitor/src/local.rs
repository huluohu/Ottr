//! 本机执行面（2026-10-20 本地终端）：进程列表 / 终止进程 / 日志尾随的
//! 本机版本。与 SSH 路径**共用解析器与白名单**（`proc::parse_ps_eo`、
//! `log::parse_log_sample`、`log::log_path_is_safe`），只把「exec 通道」换成
//! `std::process::Command` / `std::fs`——语义、返回结构与远端完全一致，前端零感知。
//!
//! 阻塞 I/O 一律下 `spawn_blocking`（ps 列表/读日志文件可能毫秒到秒级，不占
//! 异步运行时）。macOS/BSD `ps` 不认 GNU `--sort`，排序在 Rust 侧做（两端一致）。

use std::process::Command;

use crate::collect::MonitorError;
use crate::log::{LOG_DATA_MARK, LOG_STAT_MARK, LogTailSample, log_path_is_safe, parse_log_sample};
use crate::metrics::RawSample;
use crate::parse::{DiskEntry, LoadAvg, MemInfo, NetCounters, StatCounters};
use crate::proc::{PS_AUX_CMD, ProcEntry, parse_ps_aux, parse_ps_eo};

// ---------------------------------------------------------------------------
// 本机指标采样（监控页签 / 总览本机卡片）
// ---------------------------------------------------------------------------

/// 本机采样器：持有 sysinfo 的三张表跨轮复用（CPU 使用率是两次 refresh 之间
/// 的差分，表不能每轮新建），产出与 `/proc` 解析同形的 [`RawSample`]，交给
/// [`crate::run_sampling`] 的同一条 `Metrics::from_diff` 差分管线。
///
/// **CPU 计数器合成**：sysinfo 跨平台只给「上一次 refresh 以来的使用率」，
/// 没有 /proc/stat 那种累计 tick。为了不给差分管线开第二条口径，这里把
/// 使用率编码成单调计数：每轮 `total += CPU_TICK_SCALE`、
/// `idle += CPU_TICK_SCALE × (1 − usage)`——`from_diff` 算出的
/// `(1 − Δidle/Δtotal)` 恰好还原为本轮使用率。
/// 网络用 `total_received/total_transmitted`（自启动累计，真计数器）；
/// 内存/负载/磁盘是瞬时量，直接填。
pub struct LocalSampler {
    sys: sysinfo::System,
    nets: sysinfo::Networks,
    disks: sysinfo::Disks,
    cpu_total: u64,
    cpu_idle: u64,
}

const CPU_TICK_SCALE: u64 = 1_000_000;

impl Default for LocalSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalSampler {
    pub fn new() -> Self {
        let mut sys = sysinfo::System::new();
        sys.refresh_cpu_usage(); // 建立 CPU 差分基线（首轮使用率 0，恰为管线跳过的基线轮）
        Self {
            sys,
            nets: sysinfo::Networks::new_with_refreshed_list(),
            disks: sysinfo::Disks::new_with_refreshed_list(),
            cpu_total: 0,
            cpu_idle: 0,
        }
    }

    fn is_loopback(name: &str) -> bool {
        name == "lo" || name.starts_with("lo0") || name.contains("Loopback")
    }

    /// 采一轮（阻塞：sysinfo refresh 毫秒级；调用方下 spawn_blocking）。
    pub fn sample(&mut self) -> RawSample {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        self.disks.refresh(true);

        let usage = (self.sys.global_cpu_usage() as f64 / 100.0).clamp(0.0, 1.0);
        self.cpu_total += CPU_TICK_SCALE;
        self.cpu_idle += ((1.0 - usage) * CPU_TICK_SCALE as f64) as u64;

        let total_kb = self.sys.total_memory() / 1024;
        let available_kb = self.sys.available_memory() / 1024;

        let la = sysinfo::System::load_average();

        let (mut rx, mut tx) = (0u64, 0u64);
        for (name, data) in self.nets.iter() {
            if Self::is_loopback(name) {
                continue;
            }
            rx = rx.saturating_add(data.total_received());
            tx = tx.saturating_add(data.total_transmitted());
        }

        let mut disk: Vec<DiskEntry> = self
            .disks
            .iter()
            .filter(|d| d.total_space() > 0)
            .map(|d| {
                let total_kb = d.total_space() / 1024;
                let avail_kb = d.available_space() / 1024;
                let used_kb = total_kb.saturating_sub(avail_kb);
                let used_percent = if total_kb == 0 {
                    0.0
                } else {
                    (used_kb as f64 / total_kb as f64 * 100.0).clamp(0.0, 100.0)
                };
                DiskEntry {
                    filesystem: d.name().to_string_lossy().into_owned(),
                    total_kb,
                    used_kb,
                    avail_kb,
                    used_percent,
                    mount: d.mount_point().to_string_lossy().into_owned(),
                }
            })
            .collect();
        disk.sort_by(|a, b| a.mount.cmp(&b.mount));
        disk.dedup_by(|a, b| a.mount == b.mount);

        RawSample {
            stat: StatCounters {
                total: self.cpu_total,
                idle: self.cpu_idle,
            },
            mem: MemInfo {
                total_kb,
                available_kb,
            },
            load: LoadAvg {
                one: la.one,
                five: la.five,
                fifteen: la.fifteen,
            },
            net: NetCounters {
                rx_bytes: rx,
                tx_bytes: tx,
            },
            disk,
        }
    }
}

/// 本机 ps 列（与 [`crate::proc::PS_CMD`] 同列、去掉 GNU 独有 `--sort`）。
pub const PS_LOCAL_ARGS: [&str; 2] = ["-eo", "pid,ppid,user,pcpu,pmem,etime,comm"];

/// 日志续读单轮最大读取字节（本机读文件没有 SSH 流式背压，游标远落后时
/// 不把整个大日志一次吞进内存；下一轮从新游标继续）。
pub const LOG_LOCAL_MAX_READ: u64 = 16 * 1024 * 1024;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, MonitorError> + Send + 'static,
) -> Result<T, MonitorError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| MonitorError::Exec(format!("local task join error: {e}")))?
}

fn run_capture(program: &str, args: &[&str]) -> Result<String, MonitorError> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| MonitorError::Exec(format!("{program}: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 本机进程列表：`ps -eo …` → [`parse_ps_eo`]，空表再 `ps aux` →
/// [`parse_ps_aux`] 兜底（与 [`crate::proc::collect_ps`] 同款两枪）；按 CPU% 降序。
/// Windows 无 ps：显式 Unsupported（前端错误面可见，不假装空表）。
pub async fn collect_ps_local() -> Result<Vec<ProcEntry>, MonitorError> {
    blocking(|| {
        if cfg!(windows) {
            return Err(MonitorError::Unsupported {
                detail: "local process list is not available on Windows yet".into(),
            });
        }
        let mut rows = parse_ps_eo(&run_capture("ps", &PS_LOCAL_ARGS)?);
        if rows.is_empty() {
            let mut it = PS_AUX_CMD.split_whitespace();
            let prog = it.next().unwrap_or("ps");
            let args: Vec<&str> = it.collect();
            rows = parse_ps_aux(&run_capture(prog, &args)?);
        }
        rows.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.pid.cmp(&b.pid))
        });
        Ok(rows)
    })
    .await
}

/// 本机终止进程：unix `kill [-9] pid`；Windows `taskkill /PID pid [/F]`。
/// 退出码非 0 → Err 携带 stderr 原文（EPERM 等可见），与远端口径一致。
pub async fn kill_process_local(pid: u32, force: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let pid_s = pid.to_string();
        let out = if cfg!(windows) {
            let mut args = vec!["/PID", pid_s.as_str()];
            if force {
                args.push("/F");
            }
            Command::new("taskkill").args(&args).output()
        } else {
            let sig = if force { "-9" } else { "-15" };
            Command::new("kill").args([sig, pid_s.as_str()]).output()
        }
        .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stderr = stderr.trim();
        if stderr.is_empty() {
            Err(format!(
                "kill {pid} failed (exit {:?})",
                out.status.code().unwrap_or(1)
            ))
        } else {
            Err(stderr.to_string())
        }
    })
    .await
    .map_err(|e| format!("local task join error: {e}"))?
}

#[cfg(unix)]
fn inode_of(meta: &std::fs::Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.ino())
}
#[cfg(not(unix))]
fn inode_of(_meta: &std::fs::Metadata) -> Option<u64> {
    None
}

/// 本机日志尾随：白名单校验（同远端）→ stat → `offset` None 只记水位 /
/// Some(k) 从 k 读到 EOF（上限 [`LOG_LOCAL_MAX_READ`]）。拼成与远端 exec 输出
/// 同形的 marker 字节流交给 [`parse_log_sample`]——完整行截断/游标推进语义
/// 一处定义，两端不漂。
pub async fn collect_log_tail_local(
    path: &str,
    offset: Option<u64>,
) -> Result<LogTailSample, MonitorError> {
    if !log_path_is_safe(path) {
        return Err(MonitorError::Exec(format!(
            "unsafe log path rejected: {path}"
        )));
    }
    let path = path.to_string();
    blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let meta = std::fs::metadata(&path)
            .map_err(|e| MonitorError::Exec(format!("stat {path}: {e}")))?;
        let size = meta.len();
        let mut raw = Vec::new();
        raw.extend_from_slice(LOG_STAT_MARK.as_bytes());
        raw.push(b'\n');
        match inode_of(&meta) {
            Some(ino) => raw.extend_from_slice(format!("{ino} {size}\n").as_bytes()),
            None => raw.extend_from_slice(format!("0 {size}\n").as_bytes()),
        }
        if let Some(k) = offset {
            raw.extend_from_slice(LOG_DATA_MARK.as_bytes());
            raw.push(b'\n');
            if k < size {
                let mut f = std::fs::File::open(&path)
                    .map_err(|e| MonitorError::Exec(format!("open {path}: {e}")))?;
                f.seek(SeekFrom::Start(k))
                    .map_err(|e| MonitorError::Exec(format!("seek {path}: {e}")))?;
                let want = (size - k).min(LOG_LOCAL_MAX_READ);
                let mut buf = Vec::with_capacity(want as usize);
                f.take(want)
                    .read_to_end(&mut buf)
                    .map_err(|e| MonitorError::Exec(format!("read {path}: {e}")))?;
                raw.extend_from_slice(&buf);
            }
        }
        let mut sample = parse_log_sample(&raw);
        if inode_of(&meta).is_none() {
            sample.inode = None; // 非 unix 无 inode：与远端非 GNU stat 同语义（该轮不可判轮转）
        }
        Ok(sample)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn local_sampler_produces_monotonic_cpu_counters_and_sane_memory() {
        let mut s = LocalSampler::new();
        let a = s.sample();
        std::thread::sleep(std::time::Duration::from_millis(250));
        let b = s.sample();
        assert!(b.stat.total > a.stat.total, "合成 CPU 计数单调递增");
        assert!(b.stat.idle >= a.stat.idle);
        assert!(
            b.stat.idle - a.stat.idle <= b.stat.total - a.stat.total,
            "idle 增量 ≤ total 增量"
        );
        assert!(b.mem.total_kb > 0 && b.mem.available_kb <= b.mem.total_kb);
        let m = crate::Metrics::from_diff(&a, &b, std::time::Duration::from_millis(250))
            .expect("两轮即可差分");
        assert!((0.0..=100.0).contains(&m.cpu_percent));
        assert!((0.0..=100.0).contains(&m.mem_used_percent));
    }

    #[cfg(unix)]
    #[test]
    fn local_ps_lists_current_process_sorted_by_cpu() {
        let rows = rt().block_on(collect_ps_local()).unwrap();
        assert!(!rows.is_empty(), "本机 ps 至少有当前进程");
        let me = std::process::id();
        assert!(rows.iter().any(|r| r.pid == me), "列表含测试进程自身");
        assert!(
            rows.windows(2)
                .all(|w| w[0].cpu_percent >= w[1].cpu_percent),
            "按 CPU% 降序"
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_log_tail_arms_then_reads_complete_lines_from_offset() {
        let dir = std::env::temp_dir().join(format!("ottr-monitor-local-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("app.log");
        std::fs::write(&p, b"line1\nline2\npartial").unwrap();
        let path = p.to_string_lossy().into_owned();

        let armed = rt().block_on(collect_log_tail_local(&path, None)).unwrap();
        assert_eq!(armed.size, 19);
        assert!(armed.inode.is_some());
        assert_eq!(armed.data, "", "武装轮不回放历史");

        let read = rt()
            .block_on(collect_log_tail_local(&path, Some(6)))
            .unwrap();
        assert_eq!(read.data, "line2\n", "从游标起只取完整行，残缺尾行不入账");
        assert_eq!(read.data_bytes, 6);

        assert!(
            rt().block_on(collect_log_tail_local("relative/or;bad", None))
                .is_err(),
            "白名单拒绝非绝对/含特殊字符路径"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
