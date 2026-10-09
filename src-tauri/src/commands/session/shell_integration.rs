//! shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库的数据源前提）。
//! 纯搬家拆分（原 session.rs 单文件）。

use std::time::{Duration, Instant};

use ottr_ssh::SshSession;

use crate::commands::state::{LANG_PROBE_TIMEOUT, TextTail};

// ---------------------------------------------------------------------------
// shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库的数据源前提）
// ---------------------------------------------------------------------------
// 接线点 = attach_host_session 的 request_shell 成功后、首提示符消费前：注入
// 片段经 PTY writer 下发（作为一行命令发给交互 shell 执行，Phase 0 T6 spike
// 同源调用，asset = ottr_ssh::shell_integration::inject_for T6 真机验证终稿）。
// 四要素：
//   1. shell 探测：exec 通道 `echo $SHELL`（同 LANG 探测先例；bash→Bash、
//      zsh→Zsh、其他（fish/sh/nushell…）→ 跳过不报错）；
//   2. 幂等探测：等首输出（banner+首提示符）稳定后查 TextTail 原始头部是否
//      已有 OSC 133——用户自带集成则跳过（防双标记双入库）。**已知盲区
//      （挂账）**：首提示符晚于稳定窗的慢 shell 会漏判为未集成而重复注入；
//      前端 record.ts 的同秒去重兜底双 D（评审裁定 MVP 接受）；
//   3. 用户开关：settings `shell.integration`（缺省开，validate_setting 注册）；
//   4. 片段本身带 PROMPT_COMMAND/DEBUG 护栏（T6 终稿），重复注入天然幂等
//      （覆盖式 export / 重定义 precmd）。
// 注入走**两步隐身通道**（2026-10-09，T6 挂账「隐身注入」清偿）：第 1 步先
// 关远端回显（此行自身回显一次，内容很短），第 2 步在静默中下发片段并恢复
// 回显、顺带擦除第 1 步的回显残留——净可见残留为零。远端无 stty 时第 2 步
// 退化为旧的可见行为（清理步骤仍会收敛大部分残留）。

/// `echo $SHELL` 输出 → ShellKind（basename 判定；其他 shell 显式 None）。
fn detect_shell_kind(shell_path: &str) -> Option<ottr_ssh::shell_integration::ShellKind> {
    let base = shell_path.trim().rsplit('/').next().unwrap_or("");
    match base {
        "bash" => Some(ottr_ssh::shell_integration::ShellKind::Bash),
        "zsh" => Some(ottr_ssh::shell_integration::ShellKind::Zsh),
        _ => None,
    }
}

/// 注入决策（可测纯函数）：开关开 + 识别的 shell + 未自带集成 → Some(kind)。
/// 仅测试面消费（注入实现内联同款判断——原 session.rs 起即如此，lib 构建下
/// 恒 dead，2026-10-08 拆分时以 cfg(test) 收敛告警；行为零改动）。
#[cfg(test)]
fn integration_decision(
    enabled: bool,
    kind: Option<ottr_ssh::shell_integration::ShellKind>,
    already_integrated: bool,
) -> Option<ottr_ssh::shell_integration::ShellKind> {
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
    /// $SHELL 非 bash/zsh（fish/sh/…）——跳过不报错。
    SkippedNoShell,
    /// 首输出已见 OSC 133（用户自带集成，防双标记）。
    SkippedAlreadyIntegrated,
    /// exec 探测失败/超时（安全侧不注入，不打扰会话）。
    ProbeFailed,
}

/// 首输出稳定窗参数：banner+首提示符落定后 400ms 无增长即稳定；至少观察
/// 500ms；封顶 6s（慢链路兜底——超时按现状判定，盲区挂账见模块注释）。
const INJECT_STABLE_WINDOW: Duration = Duration::from_millis(400);
const INJECT_MIN_OBSERVE: Duration = Duration::from_millis(500);
const INJECT_MAX_WAIT: Duration = Duration::from_secs(6);

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

/// 等第 1 步的 `stty -echo` 执行生效：判定面 = 远端回显（"stty -echo" 出现
/// 在 TextTail 原始头部）落地后再缓冲 150ms（让 stty 真正执行完，而非仅被
/// 行纪律回显）；封顶 1.5s——超时按已生效处理，最坏退化为旧的可见行为。
async fn wait_echo_off(text_tail: &TextTail) {
    const MARKER: &str = ottr_ssh::shell_integration::ECHO_OFF_LINE;
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1500) {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if text_tail.raw_head_contains(MARKER) {
            tokio::time::sleep(Duration::from_millis(150)).await;
            return;
        }
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
    // 片段下发（**隐身注入两步**，2026-10-09 T6 挂账清偿）：
    //   第 1 步 `stty -echo`——此行自身回显一次（很短），执行后进入静默；
    //   等回显落在 TextTail 后再下发第 2 步（否则第 2 步会被回显）。
    //   第 2 步 静默下发集成片段 + 恢复回显 + 光标上移擦除第 1 步残留——
    //   shell 的新提示符正好落在擦净的位置，净可见残留为零。
    //   stty 缺失的远端：第 1 步报错、回显不关，第 2 步退化为旧的可见行为
    //   （清理步骤仍会收敛大部分残留），功能不受影响。
    let snippet_line = ottr_ssh::shell_integration::hidden_inject_line(kind);
    let result = (async {
        use tokio::io::AsyncWriteExt;
        let mut w = writer.lock().await;
        w.write_all(ottr_ssh::shell_integration::ECHO_OFF_LINE.as_bytes())
            .await?;
        w.write_all(b"\r").await?;
        w.flush().await?;
        wait_echo_off(text_tail).await;
        w.write_all(snippet_line.as_bytes()).await?;
        w.write_all(b"\r").await?;
        Ok::<(), std::io::Error>(())
    })
    .await;
    match result {
        Ok(()) => ShellIntegrationOutcome::Injected(match kind {
            ottr_ssh::shell_integration::ShellKind::Bash => "bash",
            ottr_ssh::shell_integration::ShellKind::Zsh => "zsh",
        }),
        Err(e) => {
            eprintln!("[shell-integration] write failed: {e}");
            ShellIntegrationOutcome::ProbeFailed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::state::RAW_HEAD_CAP;

    // --- shell 集成注入（Task 15 fix 1/5）：探测/决策/头部探针 ---------------

    /// $SHELL basename 判定表：bash/zsh 识别，其他（fish/sh/nushell/空）显式跳过。
    #[test]
    fn detect_shell_kind_supports_bash_and_zsh_only() {
        use ottr_ssh::shell_integration::ShellKind;
        assert_eq!(detect_shell_kind("/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/usr/bin/bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("bash"), Some(ShellKind::Bash));
        assert_eq!(detect_shell_kind("/bin/zsh"), Some(ShellKind::Zsh));
        assert_eq!(detect_shell_kind("/usr/bin/zsh\n"), Some(ShellKind::Zsh));
        for skip in [
            "/bin/sh",
            "/usr/bin/fish",
            "/opt/homebrew/bin/nu",
            "",
            "/bin/dash",
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
