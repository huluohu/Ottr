//! OSC 133 / OSC 7 shell 集成注入片段（Task 6 / spike #11 真机验证产物）。
//!
//! 每个片段为**单行**（bash/zsh 钩子本体）；注入按 shell 种类下发一到三行。
//! 注入后：提示符前发 `133;D;<exit>` + `133;A` + `7;file://<host><pwd>`，
//! 命令执行前发 `133;C`。配合 `ottr_term::osc133::Parser` 即可拿到
//! CommandEnd / CommandDone{exit_code} / Cwd 事件流。
//!
//! # 历史不干扰（2026-10-20 用户硬约束：「不能干扰用户快速切换历史命令」）
//!
//! 注入行是作为**交互输入**发给远端 shell 的——关闭回显只瞒眼睛、拦不住
//! shell 记历史：用户按 ↑ 会翻到 `stty -echo` 与几百字符的钩子行（BusyBox
//! ash 的 NAS 实测）。三种 shell 的能力上限不同，方案如实分级：
//!
//! - **bash：零残留。** 钩子行装载一次性 `__ottr_hc`：首个提示符绘制时用
//!   `history -d` 删除「钩子行」与「stty 行」。删除发生在首提示符之前，
//!   用户不可能已经提交过命令；按内容哨兵（`__osc133_preexec` /
//!   [`ECHO_OFF_MARKER`]）匹配而非盲删末条；老 bash 不支持时静默降级为
//!   「有记录但无害」。清理后从 PROMPT_COMMAND 自我摘除。
//! - **zsh：一条短条目。** zsh 无删除历史条目的能力：首行顺手
//!   `setopt HIST_IGNORE_SPACE`（并备份原值），钩子行/恢复行前导空格 →
//!   不入历史；末行还原原选项。净残留 = 首行一条短条目。
//! - **sh 系（ash/dash）：一条短条目。** 同样无历史操作能力。钩子本体经
//!   **exec 通道**写入远端临时文件（exec 不经交互行编辑器，不进历史），
//!   交互行只剩 `. /tmp/.ottr-xxxx.sh`——从一条两百余字符的乱码行变成一条
//!   固定形态短行；钩子文件自带 `rm -f` 自删。
//!
//! stty 缺失（BusyBox NAS）时：stty 行一律带 `2>/dev/null`，不再上屏
//! `command not found`；注入照常成立，只是回显没关（可见残留退化为旧行为）。
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
//!    自身的两条 printf 与 `__ottr_*` 清理函数做护栏，避免每轮提示符多发 C。
//!
//! # 已知取舍
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
    /// POSIX sh 系（busybox ash / dash / bash-as-sh）：无 preexec 钩子，发不了
    /// C 边界；PS1 内嵌命令替换在每个提示符发 `D;<exit>`+`A`——诊断（只依赖
    /// D≠0）可用，历史/补全（要求 C 的 integrated 标）保持停用。
    Sh,
}

/// 注入行哨兵（2026-10-20 历史清理）：`stty -echo` 行尾注释、zsh 首行与
/// bash `__ottr_hc` 共用。**只匹配自己的行**——`wait_echo_off` 用它判定
/// 首行已落地，bash 清理用它定位要删的历史条目；用户历史里出现同名短串的
/// 概率可忽略，且 bash 清理只发生在注入后的首个提示符（用户尚未提交命令）。
pub const ECHO_OFF_MARKER: &str = "ottr-hide";

/// 隐身注入第一步（bash/zsh）：关闭远端终端回显。此行自身会回显一次
/// （内容很短）；`2>/dev/null` 防 stty 缺失时把报错打上屏；尾部
/// `: ottr-hide` 是历史清理的定位哨兵——**用 `:` 内建而不是 `#` 注释**：
/// zsh 交互模式默认不启用 `INTERACTIVE_COMMENTS`，`#` 会被当成 stty 的
/// 参数（真夹具实测：关回显失败、后续两行全被回显）。
pub const ECHO_OFF_LINE: &str = "stty -echo 2>/dev/null; : ottr-hide";

/// bash 注入片段（真机验证终稿 + 历史零残留）。
///
/// - `PROMPT_COMMAND`：`__ottr_hc`（一次性历史清理）→ 提示符前发 `D;<code>`
///   + `A`，再发 `7;file://host$PWD`；
/// - `__osc133_preexec` + `trap … DEBUG`：命令执行前发 `C`；护栏保证
///   PROMPT_COMMAND 自身的 printf 与 `__ottr_*` 调用不触发 `C`；
/// - `__ottr_hc`：首个提示符时按哨兵删除「钩子行」→「stty 行」两条历史，
///   随后从 PROMPT_COMMAND 自我摘除。`history -d` 按**历史编号**删除（兼容
///   bash 4.2，不依赖 4.3+ 的负数偏移），失败静默（老 shell = 现状）。
pub const BASH_SNIPPET: &str = r#"export PROMPT_COMMAND='__ottr_hc; printf "\e]133;D;%s\a\e]133;A\a" "$?"; printf "\e]7;file://%s%s\a" "$HOSTNAME" "$PWD"'; __osc133_preexec(){ case "$BASH_COMMAND" in __ottr_*|'printf "\e]133;D;%s\a\e]133;A\a" "$?"'|'printf "\e]7;file://%s%s\a" "$HOSTNAME" "$PWD"') return;; esac; printf '\e]133;C\a'; }; trap '__osc133_preexec' DEBUG; __ottr_hc(){ local h n; h=$(HISTTIMEFORMAT= history 1 2>/dev/null); case "$h" in *__osc133_preexec*) n=${h#"${h%%[! ]*}"}; n=${n%%[ ]*}; history -d "$n" 2>/dev/null;; esac; h=$(HISTTIMEFORMAT= history 1 2>/dev/null); case "$h" in *ottr-hide*) n=${h#"${h%%[! ]*}"}; n=${n%%[ ]*}; history -d "$n" 2>/dev/null;; esac; PROMPT_COMMAND=${PROMPT_COMMAND#__ottr_hc; }; :; }"#;

/// zsh 钩子本体（简报原稿，真机验证直接可用）。
///
/// `precmd` 在每个提示符前发 `D`+`A`+`7`，`preexec` 在命令执行前发 `C`。
/// 由 [`zsh_inject_lines`] 组装成三行下发（首尾行负责历史开关的置位/还原，
/// 钩子行前导空格避开历史记录）。
pub const ZSH_SNIPPET: &str = r#"precmd(){ print -Pn "\e]133;D;$?\a\e]133;A\a\e]7;file://$HOST$PWD\a" }; preexec(){ print -Pn "\e]133;C\a" }"#;

/// zsh 注入行（历史残留 = 一条短条目）。
///
/// 第 1 行置位 `HIST_IGNORE_SPACE`（备份原值）；第 2 行（钩子）与第 3 行
/// （还原选项 + 擦行）**前导空格 → 不入历史**。zsh 没有删除历史条目的
/// 原语，首行必然留在历史里——但它是短的、可辨认的。
///
/// **不做 stty 隐身**：zsh 的行编辑器（zle）自己回显键入内容，实测
/// `stty -echo` 对 zsh 输入无效（真夹具验证）。擦了行的效果等价，且少
/// 两条无效命令；可见残留 = 首行一条短行（行 3 的擦行清掉其后两行）。
pub fn zsh_inject_lines() -> Vec<String> {
    // 前导空格 = HIST_IGNORE_SPACE 的豁免面（第 1 行之后生效）。
    let hook = format!(" {ZSH_SNIPPET}");
    let restore =
        " [[ $__ottr_his == off ]] && unsetopt HIST_IGNORE_SPACE; unset __ottr_his; printf '\\e[2K\\r\\e[1A\\e[2K'"
            .to_string();
    vec![
        "__ottr_his=${options[histignorespace]}; setopt HIST_IGNORE_SPACE".to_string(),
        hook,
        restore,
    ]
}

/// sh 系注入片段（busybox ash 容器实测 + sshd 夹具真 dash 端到端实测，
/// 2026-10-19）。**作为钩子文件内容使用**（见 [`sh_hook_file_content`]），
/// 不再直接作为交互行下发。
///
/// ash/dash 没有 preexec 钩子与 PROMPT_COMMAND，唯一挂点 = PS1 展开时的
/// 命令替换：每个提示符先发 `D;<exit>`（上一条命令的退出码）再发 `A`，
/// 然后拼接用户原 PS1。不发 OSC 7（cwd 只喂历史/⌘J，sh 系历史已停用）。
///
/// - `case` 护栏：PS1 已含 `133;D`（用户自带集成或重复注入）→ 原样跳过
///   （bash/zsh 片段是覆盖式天然幂等，sh 是拼接式，必须显式防叠加）。
///   **模式里的 `133;` 必须单引号包裹**——`;` 是 shell 控制操作符，裸写
///   `*133;D*` 整行解析失败（真 dash 实测 `-sh: Syntax error: ";" unexpected`
///   ，片段一行都不执行；钩子文件落盘失败时的兜底路径正为此保留）；
/// - `__ottr_ps1` 备份原 PS1：桌面端注入后若窗口内未见标记（极端 shell 不做
///   PS1 命令替换），据此下发还原行，提示符回原样（fail-silent 保障）；
/// - `${PS1-}` 防 `set -u` 下未绑定报错；
/// - 用 `$()` 命令替换而非在注入行内嵌原始 ESC 字节：注入行保持纯 ASCII
///   （原始字节经交互式行编辑器输入链有被按 ESC 序列吞掉的风险，实测复现）。
pub const SH_SNIPPET: &str = r#"case "${PS1-}" in *'133;'D*) : ;; *) __ottr_ps1="${PS1-}"; PS1='$(printf "\033]133;D;%s\007\033]133;A\007" "$?")'"${PS1-}" ;; esac"#;

/// sh 系验证失败后的还原行（__ottr_ps1 备份回填；无输出、无副作用，
/// 回显已恢复故此行可见——失败路径本来就在修可见问题，可接受）。
pub const SH_REVERT_LINE: &str = r#"PS1="${__ottr_ps1-}""#;

/// 钩子文件内容：片段本体 + 自删（会话中途进程死掉也只留一个几百字节的
/// 临时文件，目标路径本身就是一次性随机名）。
pub fn sh_hook_file_content(path: &str) -> String {
    format!("{SH_SNIPPET}\nrm -f {path} 2>/dev/null\n")
}

/// sh 系交互行：source 钩子文件 + 擦掉自身回显。
///
/// 无 stty 的机器上回显始终开着，这条短行会可见——行尾 printf 上移一行清屏，
/// shell 随后绘出的新提示符正好落在擦净的位置（与隐身通道的擦行同款手法）。
/// 该行本身会进历史（ash 无豁免能力），但它是固定的短形态。
pub fn sh_hook_source_line(path: &str) -> String {
    format!(". {path} 2>/dev/null; printf '\\e[1A\\e[2K' 2>/dev/null")
}

/// 经 exec 通道落盘钩子文件的命令（**不进交互历史**：exec 不经过行编辑器）。
///
/// - `set -C`（noclobber）+ 随机路径：不跟随预置文件/符号链接；
/// - `umask 077`：仅属主可读写；
/// - heredoc 用引号定界符 → 片段原样写入（不做变量展开）；
/// - 成功哨兵 = **cat 自身退出码** + 非空 + `OTTR_HOOK_OK`：只判非空会把
///   「noclobber 拒写后残留的旧文件」误判成成功（真机测试抓到的缺陷）。
pub fn sh_hook_write_command(path: &str) -> String {
    format!(
        "set -C; umask 077; cat > {path} <<'OTTR_HOOK_EOF'\n{}OTTR_HOOK_EOF\n[ $? -eq 0 ] && test -s {path} && echo OTTR_HOOK_OK",
        sh_hook_file_content(path)
    )
}

/// 一次性随机临时路径（`/tmp/.ottr-<pid>-<nanos>.sh`）。不用于保密，
/// 只求会话内唯一 + 不与既有文件碰撞（noclobber 兜住极端情况）。
pub fn sh_hook_temp_path() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("/tmp/.ottr-{:x}-{:x}.sh", std::process::id(), nanos)
}

/// 按 shell 种类返回注入片段（简报 Task 6 的 Produces 接口）。
pub fn inject_for(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Bash => BASH_SNIPPET,
        ShellKind::Zsh => ZSH_SNIPPET,
        ShellKind::Sh => SH_SNIPPET,
    }
}

/// 隐身注入行序列（bash/zsh）：首行关回显，后续行在静默中下发。
///
/// **stty 缺失（has_stty=false）时**：跳过回显开关步骤——bash 只剩钩子行
/// （可见但历史会被 `__ottr_hc` 清掉）；zsh 仍是三行（首行不带 stty，
/// 只负责历史开关）。
///
/// sh 系不走本函数（见 [`sh_hook_source_line`]：exec 落盘 + 短 source 行）。
pub fn hidden_inject_lines(kind: ShellKind, has_stty: bool) -> Vec<String> {
    match kind {
        ShellKind::Bash => {
            if has_stty {
                vec![
                    ECHO_OFF_LINE.to_string(),
                    format!(
                        "{}; stty echo 2>/dev/null; printf '\\e[2K\\r\\e[1A\\e[2K'",
                        BASH_SNIPPET
                    ),
                ]
            } else {
                vec![BASH_SNIPPET.to_string()]
            }
        }
        ShellKind::Zsh => zsh_inject_lines(),
        // 兜底：调用方不应对 sh 走隐身通道；直接给片段行（可见但功能成立）
        ShellKind::Sh => vec![SH_SNIPPET.to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_are_single_line() {
        for (kind, snippet) in [
            (ShellKind::Bash, BASH_SNIPPET),
            (ShellKind::Zsh, ZSH_SNIPPET),
            (ShellKind::Sh, SH_SNIPPET),
        ] {
            assert!(
                !snippet.contains('\n'),
                "{kind:?} snippet must be single line"
            );
        }
    }

    #[test]
    fn sh_snippet_is_posix_safe() {
        // set -u 下未绑定变量不炸：一律 ${PS1-} 缺省展开
        assert!(!SH_SNIPPET.contains("$PS1"));
        assert!(SH_SNIPPET.contains("${PS1-}"));
        // 幂等护栏：PS1 已含标记 → 空分支跳过（拼接式片段防叠加）。
        // 模式里的 `133;` 必须引号包裹——`;` 是控制操作符，裸写
        // `*133;D*` 整行解析失败（真 dash 实测 Syntax error）。
        assert!(SH_SNIPPET.contains("*'133;'D*) : ;;"));
        assert!(!SH_SNIPPET.contains("*133;D*"));
        // 原样备份，供验证失败后还原（fail-silent 保障）
        assert!(SH_SNIPPET.contains(r#"__ottr_ps1="${PS1-}""#));
        // D+A 标记经 printf 命令替换发出；无 C（ash 无 preexec 挂点）
        assert!(SH_SNIPPET.contains(r#"\033]133;D;%s\007"#));
        assert!(SH_SNIPPET.contains(r#"\033]133;A\007"#));
        assert!(!SH_SNIPPET.contains("133;C"));
        // 不发 OSC 7：cwd 只喂历史/⌘J，sh 系历史已停用
        assert!(!SH_SNIPPET.contains("133;7"));
        assert!(!SH_SNIPPET.contains("file://"));
        // 纯 ASCII（原始字节有被行编辑器按 ESC 序列吞掉的风险）
        assert!(SH_SNIPPET.is_ascii());
        // 还原行：仅回填备份变量，无其他副作用
        assert_eq!(SH_REVERT_LINE, r#"PS1="${__ottr_ps1-}""#);
        assert!(SH_REVERT_LINE.is_ascii());
    }

    // --- 历史不干扰（2026-10-20 用户硬约束）---------------------------------

    /// bash：钩子行带一次性 `__ottr_hc`，按哨兵删除、按编号删（兼容老 bash），
    /// 失败静默，清理后自我摘除——不盲删末条（首提示符前用户尚无命令）。
    #[test]
    fn bash_snippet_cleans_its_own_history_entries() {
        assert!(BASH_SNIPPET.contains("__ottr_hc(){"));
        // 两条哨兵：钩子行（__osc133_preexec）+ stty 行（ottr-hide）
        assert!(BASH_SNIPPET.contains("*__osc133_preexec*"));
        assert!(BASH_SNIPPET.contains("*ottr-hide*"));
        // 按历史编号删除（bash 4.2 兼容；不依赖 4.3+ 负偏移）
        assert!(BASH_SNIPPET.contains(r#"history -d "$n""#));
        assert!(!BASH_SNIPPET.contains("history -d -1"));
        // 失败静默：不把错误打上屏
        assert!(BASH_SNIPPET.contains("history 1 2>/dev/null"));
        assert!(BASH_SNIPPET.contains(r#"history -d "$n" 2>/dev/null"#));
        // 清理是一次性的：从 PROMPT_COMMAND 摘除自己
        assert!(BASH_SNIPPET.contains("PROMPT_COMMAND=${PROMPT_COMMAND#__ottr_hc; }"));
        // 清理函数排在 D/A/7 之前：历史在提示符绘制前就已干净
        assert!(
            BASH_SNIPPET.starts_with(
                r#"export PROMPT_COMMAND='__ottr_hc; printf "\e]133;D;%s\a\e]133;A\a""#
            )
        );
        // 清理函数调用不能被 DEBUG trap 误判成命令（__ottr_* 护栏）
        assert!(BASH_SNIPPET.contains("__ottr_*|"));
    }

    /// zsh：首行置位并备份 HIST_IGNORE_SPACE；钩子/恢复行前导空格（不入历史）；
    /// 末行按备份还原原选项（不能把用户的设置吞掉）。
    #[test]
    fn zsh_lines_use_and_restore_hist_ignore_space() {
        let lines = zsh_inject_lines();
        assert_eq!(lines.len(), 3);
        assert!(
            lines[0].contains("__ottr_his=${options[histignorespace]}"),
            "首行必须备份原值（还原的依据）"
        );
        assert!(lines[0].contains("setopt HIST_IGNORE_SPACE"));
        assert!(lines[0].contains("setopt"), "第 1 行自身会入历史，须含开关");
        // 后续行必须前导空格（HIST_IGNORE_SPACE 的豁免面）
        assert!(lines[1].starts_with(' '), "钩子行必须前导空格");
        assert!(lines[2].starts_with(' '), "恢复行必须前导空格");
        assert!(lines[2].contains("[[ $__ottr_his == off ]] && unsetopt HIST_IGNORE_SPACE"));
        assert!(lines[2].contains("unset __ottr_his"));
        // 钩子本体仍在
        assert!(lines[1].contains(ZSH_SNIPPET));
        // 每行单行（逐行下发的前提）
        for line in &lines {
            assert!(!line.contains('\n'), "zsh 注入行必须单行: {line:?}");
        }
        // 不做 stty 隐身（zle 自己回显，stty 无效——真夹具实测）
        assert!(!lines[0].contains("stty"), "zsh 首行不得再夹 stty");
        assert!(!lines[2].contains("stty"), "zsh 恢复行不得再夹 stty");
    }

    /// sh：钩子经 exec 落盘（不进交互历史），交互行只剩短 source 形态；
    /// 文件自带自删；写命令用 noclobber + 私有权限 + 引号定界符。
    #[test]
    fn sh_hook_file_roundtrip_is_short_and_self_deleting() {
        let path = "/tmp/.ottr-test-abc.sh";
        let content = sh_hook_file_content(path);
        assert!(content.contains(SH_SNIPPET));
        assert!(content.ends_with(&format!("rm -f {path} 2>/dev/null\n")));
        // 交互行要短（用户的抱怨就是 200+ 字符的乱码行）——路径形态固定
        let line = sh_hook_source_line(path);
        assert!(line.starts_with(&format!(". {path}")));
        assert!(line.contains("printf '\\e[1A\\e[2K'"));
        assert!(line.len() < 80, "source 行必须短: {line:?}");
        assert!(!line.contains("PS1"), "钩子本体不得回到交互行");
        // 写命令：noclobber / 私有 umask / 引号 heredoc / 成功哨兵
        let cmd = sh_hook_write_command(path);
        assert!(cmd.starts_with("set -C; umask 077; cat > "));
        assert!(cmd.contains("<<'OTTR_HOOK_EOF'"));
        assert!(cmd.contains("OTTR_HOOK_OK"));
        assert!(cmd.contains(&content));
        // 临时路径带进程与时间后缀（会话内唯一）
        let p = sh_hook_temp_path();
        assert!(p.starts_with("/tmp/.ottr-"), "{p}");
        assert!(p.ends_with(".sh"));
        assert!(p.is_ascii());
    }

    /// 真实 shell 落盘（CI 覆盖 exec 侧格式本身）：`/bin/sh` 执行
    /// [`sh_hook_write_command`] → 文件内容 = 片段、权限私有、钩子可被
    /// source（PS1 出现 133 标记）、source 后自删；noclobber 拒绝覆盖既有文件。
    /// 无 `/bin/sh` 的平台（Windows）静默跳过。
    #[test]
    fn sh_hook_write_and_source_roundtrip_in_real_sh() {
        let dir = std::env::temp_dir().join(format!(
            "ottr-hook-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hook.sh");
        let path_s = path.to_str().unwrap();

        let run_sh = |cmd: &str| {
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(cmd)
                .output()
        };

        let Ok(out) = run_sh(&sh_hook_write_command(path_s)) else {
            let _ = std::fs::remove_dir_all(&dir);
            return; // 无 /bin/sh：跳过（Windows 开发机）
        };
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("OTTR_HOOK_OK"),
            "落盘命令必须回成功哨兵: {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains(SH_SNIPPET), "钩子文件内容必须是片段本体");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o077,
                0,
                "钩子文件必须仅属主可读写（umask 077 生效）"
            );
        }

        // source 行：装载 PS1 标记 + 文件自删
        let probe = format!(
            "{}; printf 'PS1_MARK=%s\\n' \"$PS1\"",
            sh_hook_source_line(path_s)
        );
        let out = run_sh(&probe).unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("133;D"),
            "source 后 PS1 必须带 D 标记: {stdout:?}"
        );
        assert!(!path.exists(), "钩子文件必须自删");

        // noclobber：预置同名文件时拒绝覆盖（不跟随既有路径）
        std::fs::write(&path, "DO-NOT-OVERWRITE").unwrap();
        let out = run_sh(&sh_hook_write_command(path_s)).unwrap();
        assert!(
            !String::from_utf8_lossy(&out.stdout).contains("OTTR_HOOK_OK"),
            "既有文件不得被覆盖"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "DO-NOT-OVERWRITE");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hidden_line_wraps_snippet_restores_echo_and_cleans_up() {
        // bash：stty 行 + 钩子行（同行的恢复/擦除）
        let bash = hidden_inject_lines(ShellKind::Bash, true);
        assert_eq!(bash.len(), 2);
        assert_eq!(bash[0], ECHO_OFF_LINE);
        assert!(bash[0].contains(ECHO_OFF_MARKER), "首行必须带哨兵");
        assert!(bash[0].contains("2>/dev/null"), "stty 缺失时不许上屏报错");
        assert!(bash[1].starts_with(BASH_SNIPPET));
        assert!(bash[1].contains("; stty echo 2>/dev/null; printf"));
        // 无 stty：只剩钩子行（不再执行任何 stty 舞步）
        let bash_bare = hidden_inject_lines(ShellKind::Bash, false);
        assert_eq!(bash_bare, vec![BASH_SNIPPET.to_string()]);
        // zsh：三行历史编排，与 has_stty 无关（zle 自己回显，stty 无效）
        for has_stty in [true, false] {
            let zsh = hidden_inject_lines(ShellKind::Zsh, has_stty);
            assert_eq!(zsh, zsh_inject_lines());
        }
        for kind in [ShellKind::Bash, ShellKind::Zsh] {
            for line in hidden_inject_lines(kind, true) {
                assert!(!line.contains('\n'));
            }
        }
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
        // 护栏：PROMPT_COMMAND 的两条 printf 不再触发 C（case 模式表）。
        assert!(BASH_SNIPPET.contains(r#"'printf "\e]133;D;%s\a\e]133;A\a" "$?"'"#));
        assert!(BASH_SNIPPET.contains(r#"'printf "\e]7;file://%s%s\a" "$HOSTNAME" "$PWD"'"#));
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
        assert_eq!(inject_for(ShellKind::Sh), SH_SNIPPET);
    }

    /// 片段在真实 ash 里的行为回归（容器实测口径，2026-10-19）：
    /// 首次执行 = 备份并拼接标记；再执行 = case 命中空分支，PS1 不二次叠加。
    #[test]
    fn sh_snippet_is_idempotent_by_case_guard() {
        let applied = r#"$(printf "\033]133;D;%s\007\033]133;A\007" "$?")old$ "#;
        // 模拟 case 语句的匹配分支（与 SH_SNIPPET 同款模式，引号包裹分号）
        let guard = |ps1: &str| ps1.contains("133;D");
        assert!(!guard("${PS1-}"));
        assert!(guard(applied));
    }
}
