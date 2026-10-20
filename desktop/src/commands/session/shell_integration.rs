//! shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库的数据源前提）。
//! 纯搬家拆分（原 session.rs 单文件）。
//!
//! # 历史不干扰（2026-10-20 用户硬约束：「不能干扰用户快速切换历史命令」）
//!
//! 注入行作为交互输入下发时会进 shell 历史——回显关闭只瞒眼睛。三种 shell
//! 的最优解见 [`ottr_ssh::shell_integration`] 模块注释；本文件的编排职责：
//!
//! * bash/zsh：探测 stty → 有则隐身两/三步（首行关回显，等其落地再发后续行），
//!   无则跳过 stty 舞步（`stty` 报错不再上屏）；
//! * sh 系：**钩子本体经 exec 通道落盘**（不进交互历史），交互行只剩一条
//!   固定的短 source 行；exec 落盘失败才退化回「整行片段直发」。
//!
//! 其余四要素不变：
//!   1. shell 探测：exec 通道 `echo $SHELL`（同 LANG 探测先例；bash→Bash、
//!      zsh→Zsh、sh/ash/dash→Sh（POSIX sh 系，2026-10-19）、其他（fish/nushell…）
//!      → 跳过不报错）；
//!   2. 幂等探测：等首输出（banner+首提示符）稳定后查 TextTail 原始头部是否
//!      已有 OSC 133——用户自带集成则跳过（防双标记双入库）。**已知盲区
//!      （挂账）**：首提示符晚于稳定窗的慢 shell 会漏判为未集成而重复注入；
//!      前端 record.ts 的同秒去重兜底双 D（评审裁定 MVP 接受）；
//!   3. 用户开关：settings `shell.integration`（缺省开，validate_setting 注册）；
//!   4. 片段本身带 PROMPT_COMMAND/DEBUG 护栏（T6 终稿），重复注入天然幂等
//!      （覆盖式 export / 重定义 precmd）。
//!
//! sh 系附加护栏「验证-回退」（2026-10-19，用户硬约束：不支持也不得引起其他
//! 错误）：sh 片段依赖「PS1 展开时做命令替换」这一 ash/dash 行为，极端 shell
//! 不做的话 PS1 会以字面量上屏（提示符永久污染）。故下发后开窗观察原始头部
//! 是否真出现 `133;D;` 标记：出现 = 注入成立；窗口内未出现 = 下发还原行把
//! PS1 回填为片段内备份的原值，提示符回到注入前模样，会话分毫无损。

use std::time::{Duration, Instant};

use ottr_ssh::SshSession;
use ottr_ssh::shell_integration as si;

use crate::commands::state::{LANG_PROBE_TIMEOUT, TextTail};

/// `echo $SHELL` 输出 → ShellKind（basename 判定；其他 shell 显式 None）。
fn detect_shell_kind(shell_path: &str) -> Option<si::ShellKind> {
    let base = shell_path.trim().rsplit('/').next().unwrap_or("");
    match base {
        "bash" => Some(si::ShellKind::Bash),
        "zsh" => Some(si::ShellKind::Zsh),
        "sh" | "ash" | "dash" => Some(si::ShellKind::Sh),
        _ => None,
    }
}

/// 注入决策（可测纯函数）：开关开 + 识别的 shell + 未自带集成 → Some(kind)。
/// 仅测试面消费（注入实现内联同款判断——原 session.rs 起即如此，lib 构建下
/// 恒 dead，2026-10-08 拆分时以 cfg(test) 收敛告警；行为零改动）。
#[cfg(test)]
fn integration_decision(
    enabled: bool,
    kind: Option<si::ShellKind>,
    already_integrated: bool,
) -> Option<si::ShellKind> {
    if !enabled || already_integrated {
        return None;
    }
    kind
}

/// shell 集成注入结果（attach 打点 / fixture example 断言面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellIntegrationOutcome {
    /// 已下发片段（载荷 = shell 种类名）。
    Injected(&'static str),
    /// settings 开关关（调用方门卫，本函数不重复判）。
    SkippedDisabled,
    /// $SHELL 非 bash/zsh/sh 系（fish/nushell/…）——跳过不报错。
    SkippedNoShell,
    /// 首输出已见 OSC 133（用户自带集成，防双标记）。
    SkippedAlreadyIntegrated,
    /// exec 探测失败/超时（安全侧不注入，不打扰会话）。
    ProbeFailed,
    /// sh 系片段下发后窗口内未见标记（PS1 命令替换不生效）——已下发还原行
    /// 恢复原提示符（验证-回退护栏；会话无损，仅此一行在失败路径可见）。
    RevertedNoMarker,
}

/// 首输出稳定窗参数：banner+首提示符落定后 400ms 无增长即稳定；至少观察
/// 500ms；封顶 6s（慢链路兜底——超时按现状判定，盲区挂账见模块注释）。
const INJECT_STABLE_WINDOW: Duration = Duration::from_millis(400);
const INJECT_MIN_OBSERVE: Duration = Duration::from_millis(500);
const INJECT_MAX_WAIT: Duration = Duration::from_secs(6);

/// sh 系验证窗：片段下发后等首个标记的最长时间。片段执行后 shell 立即绘
/// 新提示符，标记正常在数百毫秒内到达；超窗按「不支持」处理回退原 PS1
/// （慢链路假阴性的代价 = 本会话无注入，安全侧）。
const INJECT_VERIFY_MAX_WAIT: Duration = Duration::from_millis(2500);

/// 辅助 exec 探测（stty 可用性 / sh 钩子落盘）的超时：这两步只是优化面，
/// 失败即降级；不能用 `$SHELL` 探测的 10s 上限——那会让注入在用户已经开始
/// 输入后才发生（键序交错）。
const INJECT_AUX_TIMEOUT: Duration = Duration::from_secs(3);

/// 向 PTY 写一行交互输入（`\r` 提交）。锁只在写入期间持有——等回显/等标记
/// 期间必须释放，否则用户键入会被注入流程阻塞。
async fn send_line(
    writer: &tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    line: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut w = writer.lock().await;
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    w.write_all(b"\r")
        .await
        .map_err(|e| format!("write: {e}"))?;
    w.flush().await.map_err(|e| format!("flush: {e}"))
}

/// 等首输出稳定（原始头部无增长达稳定窗），返回（是否已见 133）。
async fn wait_initial_output(text_tail: &TextTail) -> bool {
    let start = Instant::now();
    let mut last_len = text_tail.raw_head_len();
    let mut stable_since: Option<Instant> = None;
    while start.elapsed() < INJECT_MAX_WAIT {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let len = text_tail.raw_head_len();
        if len != last_len {
            last_len = len;
            stable_since = None;
            continue;
        }
        let stable_for = stable_since.get_or_insert_with(Instant::now).elapsed();
        if start.elapsed() >= INJECT_MIN_OBSERVE && stable_for >= INJECT_STABLE_WINDOW {
            break;
        }
    }
    text_tail.raw_head_has_133()
}

/// 等首行（stty -echo / zsh 首行）被远端回显：判定面 = 哨兵
/// [`si::ECHO_OFF_MARKER`] 出现在 TextTail 原始头部，而后缓冲 150ms（让
/// stty 真正执行完，而非仅被行纪律回显）；封顶 1.5s——超时按已生效处理，
/// 最坏退化为旧的可见行为。
async fn wait_echo_off(text_tail: &TextTail) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1500) {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if text_tail.raw_head_contains(si::ECHO_OFF_MARKER) {
            tokio::time::sleep(Duration::from_millis(150)).await;
            return;
        }
    }
}

/// stty 可用性探测（exec 通道，不进历史）。失败/超时按「无」处理：最坏是
/// 少走一轮隐身步骤，注入本身不受影响（所有 stty 行都带 `2>/dev/null`）。
async fn probe_has_stty(session: &SshSession) -> bool {
    matches!(
        tokio::time::timeout(INJECT_AUX_TIMEOUT, session.exec("command -v stty")).await,
        Ok(Ok(out)) if out.exit_status == Some(0) && !out.stdout.is_empty()
    )
}

/// sh 系验证-回退护栏：等片段真正发标记（原始头部出现 `\x1b]133;D;`——
/// 进入注入路径前已判过 raw_head_has_133()==false，此刻任何出现都来自
/// 我们的片段）。max_wait 可注入（单测用短窗）。
async fn wait_sh_marker(text_tail: &TextTail, max_wait: Duration) -> bool {
    const MARKER: &str = "\x1b]133;D;";
    let start = Instant::now();
    while start.elapsed() < max_wait {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if text_tail.raw_head_contains(MARKER) {
            return true;
        }
    }
    false
}

/// bash/zsh：隐身通道逐行下发（首行关回显 → 等落地 → 其余行静默下发）。
async fn inject_hidden(
    writer: &tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    probe_session: &SshSession,
    text_tail: &TextTail,
    kind: si::ShellKind,
) -> ShellIntegrationOutcome {
    // stty 探测只对 bash 有意义：zsh 的 zle 自己回显输入，stty 隐身无效
    // （真夹具实测），zsh 三行不夹 stty，也无需等待。
    let has_stty = kind == si::ShellKind::Bash && probe_has_stty(probe_session).await;
    let lines = si::hidden_inject_lines(kind, has_stty);
    for (i, line) in lines.iter().enumerate() {
        if let Err(e) = send_line(writer, line).await {
            eprintln!("[shell-integration] write failed: {e}");
            return ShellIntegrationOutcome::ProbeFailed;
        }
        // 首行关回显：等它真正生效再发后续行，否则后续行会被回显。
        // 无 stty 时不关回显，也就没有等待的必要（后续行照常可见）。
        if i == 0 && has_stty {
            wait_echo_off(text_tail).await;
        }
    }
    match kind {
        si::ShellKind::Bash => ShellIntegrationOutcome::Injected("bash"),
        si::ShellKind::Zsh => ShellIntegrationOutcome::Injected("zsh"),
        si::ShellKind::Sh => ShellIntegrationOutcome::Injected("sh"),
    }
}

/// sh 系：钩子本体经 exec 通道落盘（不进交互历史），交互行只发一条短
/// source 行；落盘失败才退化回整行片段直发（功能优先，可见残留为旧行为）。
async fn inject_sh(
    writer: &tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    probe_session: &SshSession,
    text_tail: &TextTail,
) -> ShellIntegrationOutcome {
    let path = si::sh_hook_temp_path();
    let write_cmd = si::sh_hook_write_command(&path);
    let file_ready = matches!(
        tokio::time::timeout(INJECT_AUX_TIMEOUT, probe_session.exec(&write_cmd)).await,
        Ok(Ok(out)) if String::from_utf8_lossy(&out.stdout).contains("OTTR_HOOK_OK")
    );
    if file_ready {
        if let Err(e) = send_line(writer, &si::sh_hook_source_line(&path)).await {
            eprintln!("[shell-integration] write failed: {e}");
            return ShellIntegrationOutcome::ProbeFailed;
        }
    } else {
        // 落盘失败（只读 /tmp、无 cat、exec 通道异常）：退回旧的整行片段
        // 直发。stty 可用时仍走「关回显 → 片段 → 恢复/擦行」三步，避免
        // 整行片段被回显（夹具断言「防提示符污染」）；stty 缺失才退化为
        // 可见长行（旧行为，功能不受影响）。
        eprintln!("[shell-integration] sh hook file unavailable; falling back to inline snippet");
        let has_stty = probe_has_stty(probe_session).await;
        if has_stty {
            if let Err(e) = send_line(writer, si::ECHO_OFF_LINE).await {
                eprintln!("[shell-integration] write failed: {e}");
                return ShellIntegrationOutcome::ProbeFailed;
            }
            wait_echo_off(text_tail).await;
        }
        if let Err(e) = send_line(writer, si::SH_SNIPPET).await {
            eprintln!("[shell-integration] write failed: {e}");
            return ShellIntegrationOutcome::ProbeFailed;
        }
        if has_stty {
            let restore = "stty echo 2>/dev/null; printf '\\e[2K\\r\\e[1A\\e[2K'";
            if let Err(e) = send_line(writer, restore).await {
                eprintln!("[shell-integration] write failed: {e}");
                return ShellIntegrationOutcome::ProbeFailed;
            }
        }
    }
    // 片段依赖 PS1 命令替换，窗口内未见标记即回填原 PS1（验证-回退护栏）
    if wait_sh_marker(text_tail, INJECT_VERIFY_MAX_WAIT).await {
        ShellIntegrationOutcome::Injected("sh")
    } else {
        if let Err(e) = send_line(writer, si::SH_REVERT_LINE).await {
            eprintln!("[shell-integration] sh revert write failed: {e}");
        }
        ShellIntegrationOutcome::RevertedNoMarker
    }
}

/// shell 集成注入（生产 attach 与 fixture example 共用同一实现）：
/// 开关→shell 探测→幂等探测→片段下发。返回结果供打点/断言；失败不打扰
/// 会话（注入是增强面，缺了只是历史/诊断不工作）。
pub async fn inject_shell_integration(
    writer: &tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    probe_session: &SshSession,
    text_tail: &TextTail,
    enabled: bool,
) -> ShellIntegrationOutcome {
    if !enabled {
        return ShellIntegrationOutcome::SkippedDisabled;
    }
    // $SHELL 探测（exec 通道，不进 PTY 数据流；同 LANG 探测先例）
    let kind =
        match tokio::time::timeout(LANG_PROBE_TIMEOUT, probe_session.exec("echo $SHELL")).await {
            Ok(Ok(out)) => detect_shell_kind(&String::from_utf8_lossy(&out.stdout)),
            Ok(Err(_)) | Err(_) => return ShellIntegrationOutcome::ProbeFailed,
        };
    let Some(kind) = kind else {
        return ShellIntegrationOutcome::SkippedNoShell;
    };
    // 幂等探测：首输出已有 133 = 用户自带集成，跳过（防双标记双入库）
    if wait_initial_output(text_tail).await {
        return ShellIntegrationOutcome::SkippedAlreadyIntegrated;
    }
    match kind {
        si::ShellKind::Sh => inject_sh(writer, probe_session, text_tail).await,
        si::ShellKind::Bash | si::ShellKind::Zsh => {
            inject_hidden(writer, probe_session, text_tail, kind).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::state::RAW_HEAD_CAP;

    // --- shell 集成注入（Task 15 fix 1/5）：探测/决策/头部探针 ---------------

    /// $SHELL basename 判定表：bash/zsh/sh 系识别，其他（fish/nushell/空）显式跳过。
    #[test]
    fn detect_shell_kind_supports_bash_zsh_and_sh_family() {
        use ottr_ssh::shell_integration::ShellKind;
        assert_eq!(detect_shell_kind("/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/usr/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(detect_shell_kind("/usr/bin/zsh\n"), Some(ShellKind::Zsh));
        // sh 系：busybox ash（NAS 常见默认）与 dash（Debian /bin/sh）
        assert_eq!(detect_shell_kind("/bin/sh"), Some(ShellKind::Sh));
        assert_eq!(detect_shell_kind("/bin/ash"), Some(ShellKind::Sh));
        assert_eq!(detect_shell_kind("/usr/bin/dash"), Some(ShellKind::Sh));
        for skip in [
            "/usr/bin/fish",
            "/opt/homebrew/bin/nu",
            "",
            "/bin/csh",
            "/bin/tcsh",
        ] {
            assert_eq!(detect_shell_kind(skip), None, "{skip:?} must be skipped");
        }
    }

    /// 注入决策表：开关关 / 非目标 shell / 已自带集成（幂等）一律不注入。
    #[test]
    fn integration_decision_table() {
        use ottr_ssh::shell_integration::ShellKind;
        assert_eq!(
            integration_decision(true, Some(ShellKind::Bash), false),
            Some(ShellKind::Bash)
        );
        assert_eq!(
            integration_decision(true, Some(ShellKind::Zsh), false),
            Some(ShellKind::Zsh)
        );
        assert_eq!(
            integration_decision(true, Some(ShellKind::Sh), false),
            Some(ShellKind::Sh)
        );
        // 开关关 → 不注入（探测都省了）
        assert_eq!(
            integration_decision(false, Some(ShellKind::Bash), false),
            None
        );
        // 未识别 shell → 不注入不报错
        assert_eq!(integration_decision(true, None, false), None);
        // 已自带 133 集成（幂等探测）→ 不注入（防双标记双入库）
        assert_eq!(
            integration_decision(true, Some(ShellKind::Bash), true),
            None
        );
        assert_eq!(integration_decision(true, Some(ShellKind::Sh), true), None);
    }

    /// sh 系验证-回退护栏：标记出现（即时）→ true；窗口内无标记 → false
    /// （触发还原行）。等待函数参数化窗口，单测用 80ms 短窗不拖慢测试。
    #[tokio::test]
    async fn wait_sh_marker_reports_seen_and_timeout() {
        let tail = TextTail::new();
        // 未喂标记：短窗内到点返回 false（护栏的回退触发面）
        let start = Instant::now();
        assert!(!wait_sh_marker(&tail, Duration::from_millis(80)).await);
        assert!(start.elapsed() >= Duration::from_millis(80));
        // 喂入标记（模拟片段发标）：首轮轮询即命中
        tail.push(b"\x1b]133;D;1\x07\x1b]133;A\x07");
        assert!(wait_sh_marker(&tail, Duration::from_millis(80)).await);
    }

    /// TextTail 原始头部探针：OSC 133 完整保留（剥 ANSI 前）、截满即停。
    #[test]
    fn text_tail_raw_head_keeps_osc_and_caps() {
        let tail = TextTail::new();
        assert!(!tail.raw_head_has_133());
        // 带颜色与 133 标记的原始批（flush_batch 喂入口径）
        tail.push(b"\x1b]133;D;0\x07\x1b]133;A\x07prompt$ \x1b[31mhi\x1b[0m\n");
        assert!(tail.raw_head_has_133(), "OSC 133 必须完整进头部探针");
        // 尾缓冲（AI 诊断面）不受影响：剥 ANSI 纯文本
        assert!(tail.tail(8192).contains("prompt$ hi"));
        // 截满即停：再喂大块不超上限
        let big = vec![b'x'; RAW_HEAD_CAP * 2];
        tail.push(&big);
        assert!(tail.raw_head_len() <= RAW_HEAD_CAP);
    }
}
