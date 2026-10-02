//! 日志关键字采样面（Phase 4 Task 2，Phase 3 缺口②）：**定期 `tail` 轮询**
//! （裁定：不复刻 `tail -f` 长驻流——与会话生命周期解耦、沿监控采样模式，
//! 每轮一条独立 exec 通道，会话断开即本轮失败静默、下轮自然恢复）。
//!
//! 单轮 = **一条复合只读命令**（collect 同款 marker 分段纪律）：
//!
//! ```text
//! echo '===OTTR:LSTAT==='; stat -c '%i %s' <path>; \
//! echo '===OTTR:LDATA==='; tail -c +<offset+1> <path>
//! ```
//!
//! * stat 段：`inode size`——轮转/截断判定依据（GNU stat；macOS/BSD 远端
//!   解析失败 → inode=None，TS 侧静默跳过该轮，语义同监控采集的 Linux 专用）；
//! * 数据段：`tail -c +K` 从字节 K（1 基）读到 EOF——**字节级游标**由 TS
//!   引擎持有（RuleEvalState.logCursor），Rust 侧无状态。
//!
//! 【字节账只在 Rust 算】日志尾部可能残缺多字节 UTF-8（写入到一半的行），
//! lossy 转换会丢字节账。因此本层在**原始字节**上按最后一个 `\n` 截断：
//! [`LogTailSample::data`] 只含完整行（lossy UTF-8），[`LogTailSample::data_bytes`]
//! 是其精确字节长度——残缺尾行不入账、下轮重读。TS 侧不自己数字节。
//!
//! 【防注入（结构性）】path 来自规则表单（用户输入），进 shell 前过
//! [`log_path_is_safe`] 字符白名单（`[A-Za-z0-9/._-]` 且必须绝对路径）——
//! 空格/引号/`;|&$` 等元字符从字符集上不可能出现，命令只可能是固定词 +
//! 白名单路径 + 数字偏移（kill_cmd 的 u32 入参同款「类型/字符集上封死」
//! 纪律）。含空格路径不支持（引号拼装刻意不做——监控采集命令面零元字符）。

use ottr_ssh::SshSession;

use crate::collect::MonitorError;

/// stat 段 marker（collect::MARK_PREFIX 同族；行首整词）。
pub const LOG_STAT_MARK: &str = "===OTTR:LSTAT===";
/// 数据段 marker（数据段取到 EOF，其后日志正文即使出现 marker 文本也不误切）。
pub const LOG_DATA_MARK: &str = "===OTTR:LDATA===";

/// 单轮日志采样（serde snake_case，前端 src/monitor/api.ts 同构）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LogTailSample {
    /// 文件 inode（stat 失败/远端非 GNU stat = None——该轮 TS 静默跳过）。
    pub inode: Option<u64>,
    /// stat 时刻文件大小（字节；截断判据）。
    pub size: u64,
    /// 完整行前缀（按最后一个 `\n` 截断的 lossy UTF-8；无完整行 = 空）。
    pub data: String,
    /// `data` 的字节长度（游标推进面；残缺尾行不入账）。
    pub data_bytes: u64,
}

/// 路径字符白名单（结构性防注入，见模块文档）：绝对路径 +
/// `[A-Za-z0-9/._-]`——shell 元字符与空白从字符集上不可能出现。
pub fn log_path_is_safe(path: &str) -> bool {
    path.starts_with('/')
        && !path.is_empty()
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'))
}

/// 武装轮命令（offset=None）：只 stat 不 tail——首采样只记水位，
/// 不回放历史内容（重启/新建规则 = 从文件当前末尾起监，防告警风暴）。
pub fn log_stat_cmd(path: &str) -> String {
    format!("echo '{LOG_STAT_MARK}'; stat -c '%i %s' {path}")
}

/// 续读轮命令：stat（轮转/截断判据）+ `tail -c +K`（K = 游标+1，1 基）。
pub fn log_tail_cmd(path: &str, offset: u64) -> String {
    format!(
        "echo '{LOG_STAT_MARK}'; stat -c '%i %s' {path}; echo '{LOG_DATA_MARK}'; tail -c +{} {path}",
        offset.saturating_add(1)
    )
}

/// 在 marker 行（行首整词）之后取段：返回 marker 换行后的起点
/// （marker 不存在 → None）。
fn section_after<'a>(raw: &'a [u8], mark: &str) -> Option<&'a [u8]> {
    let mark = mark.as_bytes();
    raw.windows(mark.len())
        .position(|w| w == mark)
        .map(|pos| {
            let after = &raw[pos + mark.len()..];
            match after.iter().position(|&b| b == b'\n') {
                Some(i) => &after[i + 1..],
                None => &[],
            }
        })
}

/// stat 段解析：`inode size`（GNU stat 输出）。空/坏 = (None, 0)
/// （文件消失/非 GNU stat → TS 侧按「该轮不可判」静默跳过）。
fn parse_stat_line(raw: &[u8]) -> (Option<u64>, u64) {
    let text = String::from_utf8_lossy(raw);
    let mut it = text.split_whitespace();
    match (it.next(), it.next()) {
        (Some(i), Some(s)) => match (i.parse::<u64>(), s.parse::<u64>()) {
            (Ok(i), Ok(s)) => (Some(i), s),
            _ => (None, 0),
        },
        _ => (None, 0),
    }
}

/// 原始输出解析：stat 段 → (inode, size)；数据段按最后一个 `\n` 截完整行。
/// 数据段取**首个 LDATA marker 之后到 EOF**（日志正文里的 marker 文本不误切）。
pub fn parse_log_sample(raw: &[u8]) -> LogTailSample {
    let stat = section_after(raw, LOG_STAT_MARK).unwrap_or(&[]);
    let (inode, size) = parse_stat_line(stat);
    let data_raw = section_after(raw, LOG_DATA_MARK).unwrap_or(&[]);
    let complete = data_raw
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(&data_raw[..0], |i| &data_raw[..i + 1]);
    LogTailSample {
        inode,
        size,
        data: String::from_utf8_lossy(complete).into_owned(),
        data_bytes: complete.len() as u64,
    }
}

/// 采集一轮：path 白名单校验（不安全即 Err，不发命令）→ exec → 解析。
/// exec 失败（会话断开等）上抛——TS 侧「采集失败不动游标」纪律的信号源。
pub async fn collect_log_tail(
    session: &SshSession,
    path: &str,
    offset: Option<u64>,
) -> Result<LogTailSample, MonitorError> {
    if !log_path_is_safe(path) {
        return Err(MonitorError::Exec(format!(
            "unsafe log path (charset whitelist): {path:?}"
        )));
    }
    let cmd = match offset {
        Some(off) => log_tail_cmd(path, off),
        None => log_stat_cmd(path),
    };
    let out = session
        .exec(&cmd)
        .await
        .map_err(|e| MonitorError::Exec(e.to_string()))?;
    Ok(parse_log_sample(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_whitelist_accepts_typical_log_paths() {
        for p in [
            "/var/log/syslog",
            "/var/log/nginx/error.log",
            "/opt/app/logs/app-2026.09.30.log",
            "/var/log/app_1/err-LOG.txt",
        ] {
            assert!(log_path_is_safe(p), "{p} 应在白名单内");
        }
    }

    #[test]
    fn path_whitelist_rejects_metacharacters_and_relative() {
        for p in [
            "app.log",                   // 相对路径
            "",                          // 空
            "/var/log/a b.log",          // 空格
            "/var/log/a;rm -rf /b",      // 分号
            "/var/log/$(whoami)",        // 替换
            "/var/log/`id`",             // 反引号
            "/var/log/a|b",              // 管道
            "/var/log/a&b",              // 后台
            "/var/log/a>b",              // 重定向
            "/var/log/a<b",              // 重定向
            "/var/log/a'b",              // 单引号
            "/var/log/a\"b",             // 双引号
            "/var/log/a\\b",             // 反斜杠
            "/var/log/a\nb",             // 换行
            "/var/log/a*b",              // glob
            "/var/log/日本.log",         // 非 ASCII
        ] {
            assert!(!log_path_is_safe(p), "{p:?} 必须被拒");
        }
    }

    #[test]
    fn stat_cmd_is_stat_only_readonly() {
        let cmd = log_stat_cmd("/var/log/app.log");
        assert!(cmd.starts_with(&format!("echo '{LOG_STAT_MARK}'; stat -c '%i %s' ")));
        assert!(!cmd.contains("tail"), "武装轮不 tail");
        assert!(!cmd.contains(">") && !cmd.contains("|") && !cmd.contains(";rm"));
    }

    #[test]
    fn tail_cmd_shape_and_offset_one_based() {
        let cmd = log_tail_cmd("/var/log/app.log", 0);
        assert!(cmd.contains("tail -c +1 /var/log/app.log"), "{cmd}");
        assert!(log_tail_cmd("/a.log", 999).contains("tail -c +1000 /a.log"));
        // 数据段之后（真正执行 tail 的尾段）除固定词与数字外无任何可注入面——
        // marker echo 的收尾引号属固定词面，剥掉后校验
        let tail_seg = cmd
            .split(LOG_DATA_MARK)
            .nth(1)
            .expect("LDATA marker 段")
            .strip_prefix("'; ")
            .expect("LDATA echo 收尾");
        for banned in ["$", "`", ">", "|", "&", "'", "\"", "\n", ";"] {
            assert!(!tail_seg.contains(banned), "tail 段出现 {banned:?}: {tail_seg:?}");
        }
    }

    #[test]
    fn parse_stat_and_data_sections() {
        let raw = b"===OTTR:LSTAT===\n12345 4096\n===OTTR:LDATA===\nline one\nline two\n";
        let s = parse_log_sample(raw);
        assert_eq!(s.inode, Some(12345));
        assert_eq!(s.size, 4096);
        assert_eq!(s.data, "line one\nline two\n");
        assert_eq!(s.data_bytes, 18);
    }

    #[test]
    fn parse_drops_partial_tail_line_and_accounts_bytes() {
        // 尾行残缺（无换行）：不入 data、不入字节账（下轮重读）
        let raw = b"===OTTR:LSTAT===\n7 100\n===OTTR:LDATA===\nfull line\nparti";
        let s = parse_log_sample(raw);
        assert_eq!(s.data, "full line\n");
        assert_eq!(s.data_bytes, "full line\n".len() as u64);
        assert_eq!(s.size, 100);
    }

    #[test]
    fn parse_no_complete_line_yields_empty_data() {
        let raw = b"===OTTR:LSTAT===\n7 5\n===OTTR:LDATA===\nabc";
        let s = parse_log_sample(raw);
        assert_eq!(s.data, "");
        assert_eq!(s.data_bytes, 0);
        assert_eq!(s.inode, Some(7));
    }

    #[test]
    fn parse_missing_file_stat_section_empty() {
        // stat 失败（stderr）→ stdout 只有 marker → inode None
        let raw = b"===OTTR:LSTAT===\n===OTTR:LDATA===\n";
        let s = parse_log_sample(raw);
        assert_eq!(s.inode, None);
        assert_eq!(s.size, 0);
        assert_eq!(s.data, "");
    }

    #[test]
    fn parse_data_containing_marker_text_is_not_resplit() {
        // 日志正文出现 LSTAT marker 文本：数据段取到 EOF，不误切
        let raw = b"===OTTR:LSTAT===\n7 99\n===OTTR:LDATA===\nuser typed ===OTTR:LSTAT=== in log\n";
        let s = parse_log_sample(raw);
        assert_eq!(s.inode, Some(7));
        assert_eq!(s.size, 99);
        assert_eq!(s.data, "user typed ===OTTR:LSTAT=== in log\n");
    }

    #[test]
    fn parse_multibyte_complete_lines_counted_in_bytes() {
        // 多字节完整行：字节账按原始字节（非字符数）
        let line = "注入テスト行\n"; // 18 UTF-8 字节（每 CJK 3 字节、假名 3 字节）
        let raw = format!("===OTTR:LSTAT===\n7 64\n===OTTR:LDATA===\n{line}");
        let s = parse_log_sample(raw.as_bytes());
        assert_eq!(s.data, line);
        assert_eq!(s.data_bytes, line.len() as u64);
    }

    #[test]
    fn unsafe_path_rejected_before_exec() {
        // collect 层校验：不发命令直接 Err（会话参数以 None 不可构造——
        // 校验在 connect 之前，此处锁错误面契约）
        assert!(!log_path_is_safe("/a b"));
    }

    /// 真实输出 golden（ottr-sshd 夹具容器 Debian bookworm 实拍快照，
    /// `fixtures/monitor/log_tail.txt`）：stat -c '%i %s' 输出形态与
    /// tail 数据段逐字对账。inode 值随容器重建而变——只钉「可解析的正数」
    /// 形态；size/data 冻结逐字。
    #[test]
    fn golden_real_snapshot() {
        let raw = std::fs::read(format!(
            "{}/../../fixtures/monitor/log_tail.txt",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read fixture log_tail.txt");
        let s = parse_log_sample(&raw);
        assert!(s.inode.is_some_and(|i| i > 0), "inode 形态: {:?}", s.inode);
        assert_eq!(s.size, 29);
        assert_eq!(s.data, "INFO boot ok\nFATAL disk full\n");
        assert_eq!(s.data_bytes, 29);
    }
}
