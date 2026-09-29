//! OSC 133 / OSC 7 shell 集成注入片段（Task 6 / spike #11 真机验证产物）。
//!
//! 每个片段为**单行**（attach 后作为一条命令行发给交互式 shell，行尾补 `\r`），
//! 注入后：提示符前发 `133;D;<exit>` + `133;A` + `7;file://<host><pwd>`，
//! 命令执行前发 `133;C`。配合 `ottr_term::osc133::Parser` 即可拿到
//! CommandEnd / CommandDone{exit_code} / Cwd 事件流。
//!
//! # 与简报原稿的差异（真机探测结论，全文见 task-6-report.md）
//!
//! bash 片段有两处真机必现失败，zsh 片段原样可用：
//!
//! 1. `printf "...;D;%?\a"`：bash 的 printf 无 `%?` 转换 →
//!    ``printf: `?': invalid format character``，输出止于 `ESC]133;D;`
//!    且**无 BEL 终止**——退出码丢失、同条 printf 里的 `133;A` 一并丢失、
//!    未终止的 OSC 还会让后续事件流错位。改为 `%s` + `"$?"`。
//! 2. `bind 'SET "\C-m": …'`：readline 把它当 inputrc `set` 指令解析 →
//!    `unknown variable name`，绑定静默失效。去掉 `SET` 后宏的内层 `\C-m`
//!    自引用绑定的宏 → `maximum macro execution nesting level exceeded`，
//!    **Enter 永远无法提交命令**；改内层为 `\C-j` 的变体虽能提交命令，
//!    但宏尾部 `\e]133;C\a` 被 readline 键表分派吞掉（C 事件到不了输出流，
//!    只剩一个 ding）。故 bash 的 CommandEnd 改用 **DEBUG trap**
//!    （bash-preexec / iTerm2 / kitty 同款机制），trap 内对 PROMPT_COMMAND
//!    自身的两条 printf 做护栏，避免每轮提示符多发一次 C。
//!
//! # spike 阶段的已知取舍（Phase 1 再处理）
//!
//! - 片段直接**覆盖** shell 已有的 PROMPT_COMMAND / precmd / preexec / DEBUG
//!   trap（因此重复注入天然幂等＝覆写）；与既有 hook 合并用 add-zsh-hook /
//!   bash-preexec 式拼接。
//! - bash 的 DEBUG trap 对复合命令（`a; b`、for 循环体）会按简单命令逐个触发，
//!   C 可能一条命令多次；退出码语义不受影响。
//! - 片段未发 `133;B`（命令输入行开始）；Task 5 解析器支持，spec 不强制。

/// 已支持注入的 shell 种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// bash 5.x（Debian bookworm 夹具 / 常见发行版默认）。
    Bash,
    /// zsh 5.x。
    Zsh,
}

/// bash 注入片段（真机验证终稿）。
///
/// - `PROMPT_COMMAND`：提示符前发 `D;<code>` + `A`，再发 `7;file://host$PWD`；
/// - `__osc133_preexec` + `trap … DEBUG`：命令执行前发 `C`；护栏保证
///   PROMPT_COMMAND 自身的两条 printf 不触发 `C`（否则每轮提示符多一次 C）。
pub const BASH_SNIPPET: &str = r#"export PROMPT_COMMAND='printf "\e]133;D;%s\a\e]133;A\a" "$?"; printf "\e]7;file://%s%s\a" "$HOSTNAME" "$PWD"'; __osc133_preexec(){ [[ "$BASH_COMMAND" == 'printf "\e]133;D;%s\a\e]133;A\a" "$?"' || "$BASH_COMMAND" == 'printf "\e]7;file://%s%s\a" "$HOSTNAME" "$PWD"' ]] && return; printf '\e]133;C\a'; }; trap '__osc133_preexec' DEBUG"#;

/// zsh 注入片段（简报原稿，真机验证直接可用）。
///
/// `precmd` 在每个提示符前发 `D`+`A`+`7`，`preexec` 在命令执行前发 `C`。
pub const ZSH_SNIPPET: &str = r#"precmd(){ print -Pn "\e]133;D;$?\a\e]133;A\a\e]7;file://$HOST$PWD\a" }; preexec(){ print -Pn "\e]133;C\a" }"#;

/// 按 shell 种类返回注入片段（简报 Task 6 的 Produces 接口）。
pub fn inject_for(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Bash => BASH_SNIPPET,
        ShellKind::Zsh => ZSH_SNIPPET,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_are_single_line() {
        assert!(!BASH_SNIPPET.contains('\n'));
        assert!(!ZSH_SNIPPET.contains('\n'));
    }

    #[test]
    fn bash_snippet_has_no_brief_bugs() {
        // 简报 bug 1：`%?` 是 bash printf 的非法转换（真机：invalid format
        // character 且输出无 BEL 终止）。终稿必须用 `%s` + `"$?"`。
        assert!(!BASH_SNIPPET.contains("%?"));
        assert!(BASH_SNIPPET.contains(r#"D;%s\a\e]133;A\a" "$?""#));
        // 简报 bug 2：`bind 'SET "\C-m": …'` 被 readline 当 `set` 指令 → 静默
        // 失效；自引用宏触发 nesting level 超限。终稿不含 bind，用 DEBUG trap。
        assert!(!BASH_SNIPPET.contains("bind"));
        assert!(BASH_SNIPPET.contains("trap '__osc133_preexec' DEBUG"));
        // 护栏：PROMPT_COMMAND 的两条 printf 不再触发 C。
        assert!(
            BASH_SNIPPET
                .contains(r#"[[ "$BASH_COMMAND" == 'printf "\e]133;D;%s\a\e]133;A\a" "$?"'"#)
        );
        assert!(BASH_SNIPPET.contains("133;C"));
        assert!(BASH_SNIPPET.contains("133;D"));
        assert!(BASH_SNIPPET.contains("133;A"));
        assert!(BASH_SNIPPET.contains("7;file://%s%s"));
    }

    #[test]
    fn zsh_snippet_matches_brief_verbatim() {
        assert!(ZSH_SNIPPET.contains("precmd(){ print -Pn"));
        assert!(ZSH_SNIPPET.contains("133;D;$?\\a"));
        assert!(ZSH_SNIPPET.contains("preexec(){ print -Pn \"\\e]133;C\\a\" }"));
        assert!(ZSH_SNIPPET.contains("file://$HOST$PWD"));
    }

    #[test]
    fn inject_for_dispatches() {
        assert_eq!(inject_for(ShellKind::Bash), BASH_SNIPPET);
        assert_eq!(inject_for(ShellKind::Zsh), ZSH_SNIPPET);
    }
}
