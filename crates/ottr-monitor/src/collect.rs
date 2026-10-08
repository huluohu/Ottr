//! SSH exec 采集（[`collect`]）：**一条复合只读命令**一次拿全五类样本。
//!
//! 【选型：单 exec 拼合】五类数据一条命令取回——每采样轮只开 1 个 exec
//! 通道（分次 = 每轮 5 通道，4 个纯浪费的往返；5s 轮转下长跑浪费显著）。
//! 段间以 marker 行分隔，shell `;` 串联保证「某段不存在不吞后续段」：
//!
//! ```text
//! echo '===OTTR:STAT==='; cat /proc/stat; … echo '===OTTR:DF==='; df -k
//! ```
//!
//! 【只读白名单钉死】命令集常量为唯一构造点（`COMPOSITE_CMD`），只含
//! `echo`（marker）/ `cat`（/proc 只读）/ `df -k`——Phase 3 全局约束
//! 「监控采集命令必须只读，白名单外零扩展」由此从结构上保证。
//!
//! 【非 Linux 优雅降级】macOS/BSD 无 /proc：`cat /proc/stat` 失败但 `;`
//! 链继续，STAT 段为空 → [`collect`] 返回
//! [`MonitorError::Unsupported`]（采集循环收到即短路收尾，不再重试）。
use std::collections::HashMap;

use ottr_ssh::SshSession;

use crate::metrics::RawSample;
use crate::parse::{
    parse_df_k, parse_proc_loadavg, parse_proc_meminfo, parse_proc_net_dev, parse_proc_stat,
};

/// 段 marker 前缀（行内整词匹配，防 /proc 输出里出现子串误切）。
pub(crate) const MARK_PREFIX: &str = "===OTTR:";

/// 复合采集命令（只读白名单唯一构造点；见模块文档）。
pub const COMPOSITE_CMD: &str = "echo '===OTTR:STAT==='; cat /proc/stat; \
echo '===OTTR:MEM==='; cat /proc/meminfo; \
echo '===OTTR:LOAD==='; cat /proc/loadavg; \
echo '===OTTR:NET==='; cat /proc/net/dev; \
echo '===OTTR:DF==='; df -k";

/// 采集错误。`Unsupported` = 远端非 Linux（无 /proc）——结构性、重试无义；
/// 其余为瞬时失败（连接/输出异常，循环按连续失败计数处置）。
#[derive(Debug, Clone)]
pub enum MonitorError {
    /// exec 通道失败（连接断开/协议错）。
    Exec(String),
    /// 远端不支持：/proc/stat 无聚合 cpu 行（macOS/BSD 等）。
    Unsupported { detail: String },
    /// Linux 但输出解析失败（理论极罕见，安全侧按失败处置）。
    Malformed(String),
}

impl std::fmt::Display for MonitorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MonitorError::Exec(m) => write!(f, "monitor exec failed: {m}"),
            MonitorError::Unsupported { detail } => write!(f, "monitor unsupported: {detail}"),
            MonitorError::Malformed(m) => write!(f, "monitor output malformed: {m}"),
        }
    }
}

impl std::error::Error for MonitorError {}

/// marker 行 → 段文本切分（marker 行按整行 trim 后匹配）。
pub(crate) fn split_sections(text: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix(MARK_PREFIX)
            && let Some(end) = name.strip_suffix("===")
        {
            current = Some(end.to_string());
            out.entry(end.to_string()).or_default();
            continue;
        }
        if let Some(name) = &current {
            out.entry(name.clone()).or_default().push_str(line);
            out.get_mut(name).expect("刚入表").push('\n');
        }
    }
    out
}

/// 一次采集：跑复合命令 → 切段 → 解析为 [`RawSample`]。
/// exec 的非零退出码不拦（`;` 链下单段失败合法，分段判定位在 STAT 段）。
pub async fn collect(session: &SshSession) -> Result<RawSample, MonitorError> {
    let out = session
        .exec(COMPOSITE_CMD)
        .await
        .map_err(|e| MonitorError::Exec(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let sections = split_sections(&text);

    // 判定位：STAT 段无聚合 cpu 行 = 非 Linux /proc（macOS/BSD 优雅降级）。
    let stat_text = sections
        .get("STAT")
        .ok_or_else(|| MonitorError::Unsupported {
            detail: "composite output has no STAT section".into(),
        })?;
    let stat = parse_proc_stat(stat_text).ok_or_else(|| MonitorError::Unsupported {
        detail: "/proc/stat has no aggregate cpu line (non-Linux remote?)".into(),
    })?;

    let mem = sections
        .get("MEM")
        .and_then(|t| parse_proc_meminfo(t))
        .ok_or_else(|| MonitorError::Malformed("meminfo missing MemTotal".into()))?;
    let load = sections
        .get("LOAD")
        .and_then(|t| parse_proc_loadavg(t))
        .ok_or_else(|| MonitorError::Malformed("loadavg unparsable".into()))?;
    let net = sections
        .get("NET")
        .and_then(|t| parse_proc_net_dev(t))
        .ok_or_else(|| MonitorError::Malformed("net/dev has no data lines".into()))?;
    let disk = sections
        .get("DF")
        .map(|t| parse_df_k(t))
        .ok_or_else(|| MonitorError::Malformed("df section missing".into()))?;
    if disk.is_empty() {
        return Err(MonitorError::Malformed("df output empty".into()));
    }
    Ok(RawSample {
        stat,
        mem,
        load,
        net,
        disk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composite_cmd_is_readonly_whitelist() {
        // 白名单纪律的结构性守卫：只允许 echo/cat/df，禁写命令模式
        for banned in [
            "rm ", "mv ", ">>", ">", "mkfs", "dd ", "chmod", "chown", "kill", "sh -c",
        ] {
            assert!(
                !COMPOSITE_CMD.contains(banned),
                "复合命令出现白名单外模式 {banned:?}"
            );
        }
        for required in [
            "/proc/stat",
            "/proc/meminfo",
            "/proc/loadavg",
            "/proc/net/dev",
            "df -k",
        ] {
            assert!(COMPOSITE_CMD.contains(required), "缺 {required:?}");
        }
    }

    #[test]
    fn split_sections_marks_and_joins() {
        let text = "noise\n===OTTR:A===\nline1\nline2\n===OTTR:B===\nx\n";
        let m = split_sections(text);
        assert_eq!(m.get("A").unwrap(), "line1\nline2\n");
        assert_eq!(m.get("B").unwrap(), "x\n");
        assert!(!m.contains_key("C"));
    }

    #[test]
    fn split_sections_survives_missing_marker() {
        // 第二个 marker 缺失：前者照收，后者缺席（collect 判定位兜底）
        let text = "===OTTR:A===\nbody\n";
        let m = split_sections(text);
        assert_eq!(m.get("A").unwrap(), "body\n");
        assert!(!m.contains_key("DF"));
    }

    #[test]
    fn unsupported_display_is_stable() {
        let e = MonitorError::Unsupported { detail: "x".into() };
        assert_eq!(e.to_string(), "monitor unsupported: x");
    }
}
