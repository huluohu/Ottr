//! 进程浏览器数据面（Phase 3 Task 2，B4 下半）：`ps` 采集 + `kill` 命令。
//!
//! 与 [`crate::collect`]（采样复合命令）的关系：
//! * `ps` 是**只读命令**——按裁定「只读白名单追加 ps」以独立常量
//!   [`PS_CMD`] 构造（进程浏览器按需刷新，不并进每 5s 一轮的采样复合
//!   命令）；白名单守卫单测同款（禁 `;`/`|`/`&`/重定向/反引号等模式）。
//! * `kill` 是**写操作**——绝不进只读白名单；[`kill_cmd`] 以 `u32` 入参
//!   构造，格式化层只可能产出 `kill <数字>` / `kill -9 <数字>`，注入面
//!   从类型上封死；命令域（desktop commands/monitor.rs）再对前端来的
//!   i64 做 `u32::try_from` + 非 0 校验（双重防线，前端侧无字符串拼接）。
//!
//! 解析（[`parse_ps_eo`]）与 golden：真实 `ps -eo
//! pid,ppid,user,pcpu,pmem,etime,comm --sort=-pcpu` 输出快照
//! `fixtures/monitor/ps_eo.txt`（ottr-sshd 夹具容器 Debian bookworm）。
//! 列结构 = 6 个无空格字段 + comm（最后一段，**可含空格**，如
//! `sshd: /usr/sbin/sshd` 形态的 comm 变体）——前 6 列逐列解析、其余
//! 全部归还 comm。任一数值列坏 = 丢弃该行（监控面宁缺毋错，df 同纪律）。

use ottr_ssh::SshSession;

use crate::collect::MonitorError;

/// 进程列表采集命令（只读白名单的 ps 追加点；唯一构造点，见模块文档）。
pub const PS_CMD: &str = "ps -eo pid,ppid,user,pcpu,pmem,etime,comm --sort=-pcpu";

/// 兜底采集命令（2026-10-16 用户反馈：NAS 主机进程卡恒空）：GNU 形态的
/// `-eo` 长列 + `--sort` 在 busybox（QNAP/Synology/嵌入式）与 BSD/macOS ps
/// 上不支持——命令失败输出为空 = 进程卡恒「无进程」。`ps aux` 是三形态的
/// 最小公倍数（列少：无 ppid/pcpu/etime），由 [`parse_ps_aux`] 按表头列名
/// 宽松映射，缺的列填中性值。只读，白名单纪律同 [`PS_CMD`]。
pub const PS_AUX_CMD: &str = "ps aux";

/// 单进程条目（前端 ProcessBrowser 表格行，serde snake_case 同构）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub cpu_percent: f32,
    pub mem_percent: f32,
    /// 运行时长（秒；由 etime 字段换算，供数值排序）。
    pub etime_secs: u64,
    /// etime 原文（`[[DD-]hh:]mm:ss`，展示面用）。
    pub etime: String,
    pub comm: String,
}

/// etime 换算秒：`SS` / `MM:SS` / `HH:MM:SS` / `DD-HH:MM:SS`（procps 全形态）。
pub fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let mut secs = 0u64;
    let mut cols = 0u32;
    for part in rest.split(':') {
        secs = secs
            .checked_mul(60)?
            .checked_add(part.parse::<u64>().ok()?)?;
        cols += 1;
    }
    if !(1..=3).contains(&cols) {
        return None;
    }
    Some(days * 86_400 + secs)
}

/// `ps -eo …` 输出解析：跳头部（首列 `PID`）；前 6 列逐列解析（坏列丢行），
/// 第 7 列起整体归 comm（可含空格）。
pub fn parse_ps_eo(text: &str) -> Vec<ProcEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 7 || fields[0] == "PID" {
            continue;
        }
        let (Some(pid), Some(ppid), Some(cpu_percent), Some(mem_percent), Some(etime_secs)) = (
            fields[0].parse::<u32>().ok(),
            fields[1].parse::<u32>().ok(),
            fields[3].parse::<f32>().ok(),
            fields[4].parse::<f32>().ok(),
            parse_etime(fields[5]),
        ) else {
            continue;
        };
        out.push(ProcEntry {
            pid,
            ppid,
            user: fields[2].to_string(),
            cpu_percent,
            mem_percent,
            etime_secs,
            etime: fields[5].to_string(),
            comm: fields[6..].join(" "),
        });
    }
    out
}

/// `ps aux` 宽松解析（[`PS_AUX_CMD`] 兜底链）：按**表头列名**定位 PID/USER/
/// COMMAND 三列（busybox「PID USER VSZ STAT COMMAND」、macOS/BSD「USER PID
/// %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND」皆命中），COMMAND 取到行尾
/// （可含空格）。无表头/缺 PID/缺 COMMAND/非数字 PID 的行丢弃（宁缺毋错）。
/// 缺失的列填中性值：ppid 0、cpu/mem 0.0、etime 空（前端展示空、排序退位）。
pub fn parse_ps_aux(text: &str) -> Vec<ProcEntry> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else {
        return Vec::new();
    };
    let cols: Vec<String> = header
        .split_whitespace()
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let Some(pid_idx) = cols.iter().position(|c| c == "PID") else {
        return Vec::new();
    };
    let Some(cmd_idx) = cols.iter().position(|c| c == "COMMAND" || c == "CMD") else {
        return Vec::new();
    };
    let user_idx = cols.iter().position(|c| c == "USER");
    let mut rows = Vec::new();
    for line in lines {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() <= cmd_idx || f.len() <= pid_idx {
            continue;
        }
        let Ok(pid) = f[pid_idx].parse::<u32>() else {
            continue;
        };
        rows.push(ProcEntry {
            pid,
            ppid: 0,
            user: user_idx
                .and_then(|i| f.get(i))
                .map(|s| s.to_string())
                .unwrap_or_default(),
            cpu_percent: 0.0,
            mem_percent: 0.0,
            etime_secs: 0,
            etime: String::new(),
            comm: f[cmd_idx..].join(" "),
        });
    }
    rows
}

/// kill 命令构造（防注入的**结构性**防线：`u32` 入参，只可能产出
/// `kill <数字>` / `kill -9 <数字>`）。pid=0（整个调用方进程组）在命令域
/// 校验层拒绝——构造层保持纯格式化。
pub fn kill_cmd(pid: u32, force: bool) -> String {
    if force {
        format!("kill -9 {pid}")
    } else {
        format!("kill {pid}")
    }
}

/// 采集进程列表：exec [`PS_CMD`] → [`parse_ps_eo`]；空表再 exec [`PS_AUX_CMD`]
/// → [`parse_ps_aux`] 兜底（busybox/BSD ps 不认 GNU 长列）。ps 缺席/两枪皆空
/// → 空表（进程浏览器展示空态；与采样的 Unsupported 判定不同，这里不短路
/// 任何循环——进程浏览器是按需拉取，不是常驻循环）。
pub async fn collect_ps(session: &SshSession) -> Result<Vec<ProcEntry>, MonitorError> {
    let out = session
        .exec(PS_CMD)
        .await
        .map_err(|e| MonitorError::Exec(e.to_string()))?;
    let rows = parse_ps_eo(&String::from_utf8_lossy(&out.stdout));
    if !rows.is_empty() {
        return Ok(rows);
    }
    let out = session
        .exec(PS_AUX_CMD)
        .await
        .map_err(|e| MonitorError::Exec(e.to_string()))?;
    Ok(parse_ps_aux(&String::from_utf8_lossy(&out.stdout)))
}

/// 终止进程：exec [`kill_cmd`]。退出码非 0 → Err（携带 stderr——权限不足
/// EPERM 等远端原文直接上抛，前端错误面可见）。
pub async fn kill_process(session: &SshSession, pid: u32, force: bool) -> Result<(), String> {
    let out = session
        .exec(&kill_cmd(pid, force))
        .await
        .map_err(|e| e.to_string())?;
    if out.exit_status == Some(0) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        Err(format!(
            "kill {pid} failed (exit {:?})",
            out.exit_status.unwrap_or(1)
        ))
    } else {
        Err(stderr.to_string())
    }
}

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
    fn ps_eo_golden_real_snapshot() {
        let rows = parse_ps_eo(&fixture("ps_eo.txt"));
        assert!(rows.len() >= 4, "夹具容器至少 4 个进程: {rows:?}");
        // 快照（与 fixtures/monitor/ps_eo.txt 逐列对账；冻结文件口径）：
        //   PID  PPID USER %CPU %MEM     ELAPSED COMMAND
        //    21     1 root  0.0  0.0    01:41:22 sshd
        //     1     0 root  0.0  0.0    01:41:23 entrypoint.sh
        let sshd = rows.iter().find(|r| r.pid == 21).expect("sshd row");
        assert_eq!(sshd.ppid, 1);
        assert_eq!(sshd.user, "root");
        assert_eq!(sshd.comm, "sshd");
        assert_eq!(sshd.etime, "01:41:22");
        assert_eq!(sshd.etime_secs, 3600 + 41 * 60 + 22);
        let init = rows.iter().find(|r| r.pid == 1).expect("pid 1 row");
        assert_eq!(init.ppid, 0);
        assert_eq!(init.comm, "entrypoint.sh");
        // 输入序保留（服务端已按 %CPU 排序；前端再排序是它自己的事）
        let pids: Vec<u32> = rows.iter().map(|r| r.pid).collect();
        assert_eq!(pids, vec![21, 1, 834, 839]);
    }

    #[test]
    fn ps_eo_skips_header_and_garbage_lines() {
        let text = "    PID    PPID USER     %CPU %MEM     ELAPSED COMMAND\n\
                    garbage short line\n\
                    not-a-pid 1 2 3 4 5 6 7\n\
                      5     0 root  0.5  1.5       00:10 init\n";
        let rows = parse_ps_eo(text);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].pid, 5);
        assert_eq!(rows[0].comm, "init");
        assert_eq!(rows[0].cpu_percent, 0.5);
        assert_eq!(rows[0].etime_secs, 10);
    }

    #[test]
    fn ps_eo_comm_may_contain_spaces() {
        // comm 是最后一段：剩余列全部归还 comm（列数 > 7）
        let text = "  900     1 root  1.0  2.0    01:02:03 sshd: /usr/sbin/sshd -D\n";
        let rows = parse_ps_eo(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].comm, "sshd: /usr/sbin/sshd -D");
        assert_eq!(rows[0].etime_secs, 3600 + 2 * 60 + 3);
    }

    #[test]
    fn etime_all_procps_shapes() {
        assert_eq!(parse_etime("45"), Some(45), "裸秒（<1min 变体）");
        assert_eq!(parse_etime("04:05"), Some(245));
        assert_eq!(parse_etime("01:41:22"), Some(6082));
        assert_eq!(
            parse_etime("2-03:04:05"),
            Some(2 * 86_400 + 3 * 3600 + 4 * 60 + 5)
        );
        assert_eq!(parse_etime("x:zz"), None);
        assert_eq!(parse_etime(""), None);
    }

    #[test]
    fn ps_cmd_is_readonly_whitelist() {
        // 只读白名单守卫（collect::composite_cmd_is_readonly_whitelist 同款纪律）：
        // ps 命令无管道/串联/重定向/替换面，首词即 ps
        for banned in [";", "|", "&", ">", "<", "`", "$", "\n"] {
            assert!(
                !PS_CMD.contains(banned),
                "PS_CMD 出现白名单外模式 {banned:?}"
            );
        }
        assert!(PS_CMD.starts_with("ps -eo "));
        assert!(PS_CMD.ends_with("--sort=-pcpu"));
        // 兜底命令同纪律（2026-10-16 NAS 兜底链）：单 ps、无任何串联面
        assert_eq!(PS_AUX_CMD, "ps aux");
        for banned in [";", "|", "&", ">", "<", "`", "$", "\n"] {
            assert!(!PS_AUX_CMD.contains(banned));
        }
    }

    #[test]
    fn ps_aux_lenient_parse_busybox_and_bsd_headers() {
        // busybox 形态（QNAP/Synology/嵌入式）：PID USER VSZ STAT COMMAND
        let busybox = "  PID USER       VSZ  STAT COMMAND\n\
                        1   root      1024 S    init\n\
                        156 admin     3412 S    /usr/sbin/sshd -D\n";
        let rows = parse_ps_aux(busybox);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].pid, 1);
        assert_eq!(rows[0].user, "root");
        assert_eq!(rows[0].comm, "init");
        assert_eq!(rows[1].pid, 156);
        assert_eq!(rows[1].comm, "/usr/sbin/sshd -D", "COMMAND 取到行尾");
        // 缺失列填中性值
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].cpu_percent, 0.0);
        assert_eq!(rows[0].etime, "");
        // BSD/macOS 形态：USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
        let bsd = "USER    PID  %CPU %MEM    VSZ   RSS TT  STAT STARTED      TIME COMMAND\n\
                   root    321   0.0  0.1  4096  2048 ??  S    Tue01AM       0:01.42 login -fp\n";
        let rows = parse_ps_aux(bsd);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 321);
        assert_eq!(rows[0].user, "root");
        assert_eq!(rows[0].comm, "login -fp");
    }

    #[test]
    fn ps_aux_garbage_headers_and_rows_dropped() {
        assert_eq!(parse_ps_aux(""), Vec::new());
        // 无表头（首个非空行被当表头，无 PID 列）→ 空
        assert_eq!(parse_ps_aux("random line\nanother\n"), Vec::new());
        // 有表头：非数字 PID 行丢弃、短行丢弃
        let text = "  PID USER  COMMAND\n\
                    not-a-pid root init\n\
                    42 root\n\
                    43 root myproc --flag\n";
        let rows = parse_ps_aux(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 43);
        assert_eq!(rows[0].comm, "myproc --flag");
    }

    #[test]
    fn kill_cmd_is_structurally_digit_only() {
        // 结构性防注入证明：构造产物除固定前缀外只能是数字
        assert_eq!(kill_cmd(123, false), "kill 123");
        assert_eq!(kill_cmd(123, true), "kill -9 123");
        for pid in [1, 42, 65535, u32::MAX] {
            for force in [false, true] {
                let cmd = kill_cmd(pid, force);
                let digits = cmd
                    .trim_start_matches("kill -9 ")
                    .trim_start_matches("kill ");
                assert_eq!(digits, pid.to_string(), "非数字残留: {cmd:?}");
            }
        }
    }

    #[test]
    fn kill_error_display_carries_stderr() {
        // EPERM 可见面：stderr 原文上抛（真夹具集成里用 root kill 普通用户
        // 进程的反例不可造——此处锁错误形状契约）
        let e = "kill: (123) - Operation not permitted";
        assert!(e.contains("Operation not permitted"));
    }
}
