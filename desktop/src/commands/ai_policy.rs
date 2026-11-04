//! 自动档（Ask Ottr 执行模式第三步）的**命令分级器**与**主机授权面**。
//!
//! # 为什么后端要自己判
//!
//! 前端也有一份危险分级（`frontend/ai/danger.ts`，用于给命令打红黄绿徽章），
//! 但**放行判断只能在后端**：webview 是信任边界内的，最后一道闸在 Rust 侧。
//! 两份规则表靠一条**跨语言钉死测试**（[`tests::red_rules_match_frontend_table`]
//! ——直接读 `frontend/ai/danger.ts` 比对规则源）保持一致：前端把命令显示成
//! 「绿色」而后端当成「红色」，就是安全面上的事故。
//!
//! # 分级语义（自动档的处置）
//!
//! | 分级 | 自动档处置 |
//! |---|---|
//! | [`AiCommandClass::Red`] | **直接拒绝**（不降级、不执行、不登记） |
//! | [`AiCommandClass::Escape`] | **降级为逐条确认**（管道/重定向/命令替换/解释器） |
//! | [`AiCommandClass::ReadOnly`] | **直接执行**（只读白名单） |
//! | [`AiCommandClass::Write`] | 该主机授权了对应类别 → 直接执行；否则降级确认 |
//! | [`AiCommandClass::Unknown`] | **降级为逐条确认**（不认识 = 不放行） |
//!
//! # 边界（如实说）
//!
//! * 白名单是**首段启发式**：`sh -c '…'`、别名、PATH 上的同名脚本都可能绕过
//!   → 逃逸形态一律降级为确认是兜底，**不能宣称绝对安全**。
//! * 已发出的远端命令**无法回滚**。

use ottr_vault::{AiHostPolicies, AiHostPolicy, AiHostPolicyInput, AiWriteCategory};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::vault::{CmdResult, VaultState, ensure_unlocked};

/// 命令分级（自动档的判定结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiCommandClass {
    /// 只读白名单命令：自动档可直接执行。
    ReadOnly,
    /// 写操作（带类别）：仅当该主机授权了对应类别时才自动执行。
    Write(AiWriteCategory),
    /// 逃逸形态：管道 / 重定向 / 命令替换 / 解释器 / 提权 → 一律降级确认。
    Escape,
    /// 不可逆/灾难面（red）：自动档**直接拒绝**。
    Red,
    /// 未识别的命令：降级为逐条确认（保守侧：不认识 = 不放行）。
    Unknown,
}

/// 分级结论（分级 + 人类可读的原因，供回灌模型与 UI 展示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiCommandVerdict {
    pub class: AiCommandClass,
    /// 命中原因（红档规则名 / 逃逸形态 / 写类别 / 未识别）。
    pub reason: String,
}

impl AiCommandVerdict {
    fn new(class: AiCommandClass, reason: impl Into<String>) -> Self {
        Self {
            class,
            reason: reason.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// red 规则表（与 frontend/ai/danger.ts 的 red 档**逐条对应**）
// ---------------------------------------------------------------------------

/// red 规则：(规则名, 正则源, JS 标志位)。
///
/// ★ **词边界必须显式写成 ASCII**（`(?:^|[^A-Za-z0-9_])` / `(?:[^A-Za-z0-9_]|$)`），
/// 不能直接用 `\b` / `\w`：
/// JS 的 `\b`/`\w` 在**无 u 标志**时恒为 ASCII（`[A-Za-z0-9_]`），而 Rust 的
/// regex crate 默认 **Unicode 词字符**。两边语义不同会出**危险方向**的错位：
/// `cat ürm -rf /` 前端判**红**（`ü` 之后有 ASCII 词边界）、后端判**只读**
/// → 自动档会**直接执行**前端标红的命令（2026-11-04 独立审查实测）。
///
/// 标志位沿用 JS 原义：`i` = 忽略大小写、`s` = `.` 匹配换行（Rust 写成 `(?s)`）。
///
/// **两侧的等价性由行为钉死**（`dangerCases.json` 共享用例表：前端断言 JS
/// 判定、Rust 断言 Rust 判定），不再比对源码文本 —— 语义差异是文本比对
/// 测不出来的。
const RED_RULES: &[(&str, &str, &str)] = &[
    (
        "delete-root",
        r"(?:^|[^A-Za-z0-9_])rm\s+[^|;\n]*\s+\/(\s|$|\*)",
        "i",
    ),
    (
        "disk-write",
        r"(?:^|[^A-Za-z0-9_])(dd\s+[^\n]*of=\/dev\/|mkfs(\.[A-Za-z0-9_]+)?\s)",
        "i",
    ),
    ("fork-bomb", r":\(\)\{.*\};\s*:", "s"),
    (
        "kill9-init",
        r"(?:^|[^A-Za-z0-9_])kill\s+(-9|--sigkill|-s\s+sigkill)\s+(-1|1)(?:[^A-Za-z0-9_]|$)",
        "i",
    ),
    (
        "perm-open-recursive-root",
        r"(?:^|[^A-Za-z0-9_])chmod\s+-R\s+777\s+\/(\s|$)",
        "i",
    ),
    (
        "owner-change-root",
        r"(?:^|[^A-Za-z0-9_])chown\s+(-R\s+)?[A-Za-z0-9_.-]+\s+\/(\s|$)",
        "i",
    ),
    (
        "force-push",
        r"(?:^|[^A-Za-z0-9_])git\s+push\s+(-f|--force|--force-with-lease)(\s|$)",
        "i",
    ),
    (
        "hard-reset",
        r"(?:^|[^A-Za-z0-9_])git\s+reset\s+--hard(?:[^A-Za-z0-9_]|$)",
        "i",
    ),
    (
        "sql-drop",
        r"(?:^|[^A-Za-z0-9_])drop\s+(table|database|schema)(?:[^A-Za-z0-9_]|$)",
        "i",
    ),
    (
        "device-redirect",
        r">>?\s*\/dev\/(?:sd|hd|nvme|vd|disk|mapper)",
        "i",
    ),
    (
        "disk-erase",
        r"(?:^|[^A-Za-z0-9_])(shred|wipefs|blkdiscard)(?:[^A-Za-z0-9_]|$)",
        "i",
    ),
];

/// 短旗标 token（`-rf` 这种）：**纯 ASCII 字母**才算（与 danger.ts 的
/// `/^-[a-zA-Z]+$/` 同义）。`rm -rf2 x` 因此**不算**递归强删——两侧一致。
fn is_short_flag_token(tok: &str) -> bool {
    let Some(letters) = tok.strip_prefix('-') else {
        return false;
    };
    // **单个字母也算**（`-r` / `-f`）——与 danger.ts 的 `/^-[a-zA-Z]+$/` 同义。
    !letters.is_empty() && letters.chars().all(|c| c.is_ascii_alphabetic())
}

/// rm 的「递归 + 强制」判定（danger.ts `matchRmRecursiveForce` 的 Rust 移植：
/// 正则表达不了「旗标分散在多个 token」，只能按 token 扫）。
///
/// 段边界按 `[\r\n;|&]+` 切——`rm a && rsync --recursive --force` 不误伤
/// （旗标属各段）。
fn match_rm_recursive_force(cmd: &str) -> Option<String> {
    for segment in cmd.split(['\r', '\n', ';', '|', '&']) {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        let mut saw_rm = false;
        let mut recursive = false;
        let mut force = false;
        for tok in tokens {
            if !saw_rm {
                if tok == "rm" || tok.ends_with("/rm") {
                    saw_rm = true;
                }
                continue;
            }
            if let Some(long) = tok.strip_prefix("--") {
                if long == "recursive" {
                    recursive = true;
                }
                if long == "force" {
                    force = true;
                }
            } else if is_short_flag_token(tok) {
                // 与 danger.ts 的 /^-[a-zA-Z]+$/ **完全一致**（纯 ASCII 字母）：
                // `rm -rf2 x` 在 JS 侧不算递归强删 → 两侧必须同样不算。
                let letters = &tok[1..];
                if letters.chars().any(|c| c == 'r' || c == 'R') {
                    recursive = true;
                }
                if letters.chars().any(|c| c == 'f') {
                    force = true;
                }
            }
        }
        if saw_rm && recursive && force {
            return Some(segment.trim().chars().take(80).collect());
        }
    }
    None
}

/// 扫 red 规则（返回命中的规则名与片段）。
fn scan_red(cmd: &str) -> Option<(String, String)> {
    // token 判定（rm 递归强删）在前——它不是正则。
    if let Some(excerpt) = match_rm_recursive_force(cmd) {
        return Some(("recursive-delete".to_string(), excerpt));
    }
    for (kind, pattern, flags) in RED_RULES {
        // JS 标志位 → Rust 内联标志（/i = 忽略大小写、/s = dot 匹配换行）。
        let mut prefix = String::new();
        if flags.contains('i') {
            prefix.push_str("(?i)");
        }
        if flags.contains('s') {
            prefix.push_str("(?s)");
        }
        let re = Regex::new(&format!("{prefix}{pattern}"))
            .expect("red 规则正则必须可编译（编译期常量）");
        if let Some(m) = re.find(cmd) {
            return Some((
                (*kind).to_string(),
                m.as_str().trim().chars().take(80).collect(),
            ));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 逃逸形态（管道 / 重定向 / 命令替换 / 解释器 / 提权）
// ---------------------------------------------------------------------------

/// shell 元字符（出现即降级）：命令连接、重定向、命令替换、子 shell。
const ESCAPE_CHARS: &[char] = &[';', '&', '|', '>', '<', '`', '(', ')'];

/// 解释器 / 提权 / 任务包装类命令（首个 token 命中即降级——它们能把任意
/// 命令塞进来，白名单判定对它们没有意义）。
const ESCAPE_COMMANDS: &[&str] = &[
    // shell 解释器
    "sh", "bash", "zsh", "ksh", "dash", "csh", "tcsh", "fish", "ash", "busybox",
    // 包装 / 提权 / 任务
    "env", "xargs", "nohup", "setsid", "timeout", "watch", "nice", "ionice", "stdbuf", "sudo", "su",
    "doas", "eval", "exec", "source", "command", "builtin", "trap",
    // 脚本解释器（可执行任意代码）
    "perl", "python", "python3", "ruby", "node", "php", "awk", "sed", "make", "cargo", "go", "java",
    "dotnet", "deno", "bun", "lua", "tclsh", "expect",
];

/// 判定是否含逃逸形态（返回命中原因）。
fn scan_escape(cmd: &str) -> Option<String> {
    if let Some(c) = cmd.chars().find(|c| ESCAPE_CHARS.contains(c)) {
        return Some(format!("shell metacharacter {c:?}"));
    }
    if cmd.contains("$(") {
        return Some("command substitution $(...)".to_string());
    }
    if cmd.contains('\n') || cmd.contains('\r') {
        return Some("multi-line command".to_string());
    }
    // 首 token 是解释器 / 提权命令。
    let first = cmd.split_whitespace().next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    if ESCAPE_COMMANDS.contains(&base) {
        return Some(format!("interpreter/privileged command {base:?}"));
    }
    None
}

// ---------------------------------------------------------------------------
// 只读白名单与写操作类别
// ---------------------------------------------------------------------------

/// 单条命令的规格：只读子命令白名单（`None` = 整体只读）+ 写操作类别。
struct CommandSpec {
    /// 只读子命令白名单（`Some` 时：不在名单里的子命令按写操作处置）。
    read_only_subcommands: Option<&'static [&'static str]>,
    /// 写操作类别（`None` = 该命令不写盘）。
    write_category: Option<AiWriteCategory>,
}

/// 整体只读的命令（首段命中即只读）。
const READ_ONLY_COMMANDS: &[&str] = &[
    "ls",
    "cat",
    "df",
    "du",
    "ps",
    "grep",
    "find",
    "head",
    "tail",
    "wc",
    "stat",
    "free",
    "uptime",
    "id",
    "whoami",
    "uname",
    "which",
    "journalctl",
    "date",
    "hostname",
    "who",
    "groups",
    "file",
    "sort",
    "uniq",
    "cut",
    "diff",
    "cmp",
    "md5sum",
    "sha256sum",
    "tree",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "pwd",
    "echo",
    "printf",
    "column",
    "tr",
    "nl",
    "paste",
    "join",
    "expr",
    "seq",
    "tty",
    "stty",
    "locale",
    "getconf",
    "nproc",
    "lscpu",
    "lsblk",
    "mount",
    "vmstat",
    "iostat",
    "mpstat",
    "sar",
    "last",
    "w",
    "whereis",
    "type",
];

/// 带子命令语义 / 写操作类别的命令表。
fn command_spec(base: &str) -> Option<CommandSpec> {
    let spec = match base {
        // systemctl：status/show/list-* 只读；其余是服务写操作。
        "systemctl" => CommandSpec {
            read_only_subcommands: Some(&[
                "status",
                "show",
                "is-active",
                "is-enabled",
                "is-failed",
                "list-units",
                "list-unit-files",
                "list-timers",
                "list-sockets",
                "cat",
                "get-default",
            ]),
            write_category: Some(AiWriteCategory::Service),
        },
        // git：只读子命令 vs 写子命令。
        "git" => CommandSpec {
            read_only_subcommands: Some(&[
                "status",
                "log",
                "diff",
                "show",
                "blame",
                "ls-files",
                "shortlog",
                "describe",
                "rev-parse",
                "cat-file",
                "reflog",
                // ★ **不含 config**：`git config` 是**写命令**（写 ~/.gitconfig，
                //   或 `--file <路径>` 写任意文件）——当只读 = 自动档绕过写类别门。
            ]),
            write_category: Some(AiWriteCategory::Git),
        },
        // 包管理：查询子命令只读，安装/卸载是写操作。
        "apt" | "apt-get" | "apt-cache" | "dnf" | "yum" | "apk" | "pacman" | "brew" | "npm"
        | "pnpm" | "yarn" | "pip" | "pip3" | "gem" | "composer" => CommandSpec {
            read_only_subcommands: Some(&["list", "show", "policy", "search", "info", "outdated"]),
            write_category: Some(AiWriteCategory::Package),
        },
        // 文件写操作。
        "rm" | "rmdir" | "mv" | "cp" | "mkdir" | "touch" | "chmod" | "chown" | "ln" | "tee"
        | "truncate" | "shred" | "install" | "tar" | "unzip" | "zip" | "dd" | "mount"
        | "umount" | "chattr" => CommandSpec {
            read_only_subcommands: None,
            write_category: Some(AiWriteCategory::File),
        },
        // 服务控制。
        "service" | "rc-service" | "launchctl" | "pm2" | "supervisorctl" => CommandSpec {
            read_only_subcommands: None,
            write_category: Some(AiWriteCategory::Service),
        },
        _ => return None,
    };
    Some(spec)
}

/// 只读白名单里**带例外**的命令：命中「会写盘 / 改系统状态」的参数或形态
/// 就**不是只读**（降级为写类别，走主机授权门）。
///
/// ★ 判据是**能写**不是「看起来无害」：命令本身只读、但参数能写盘/改状态的
/// 形态必须逐个覆盖（2026-11-04 独立审查实测：`git config --file X a b`、
/// `git diff --output=X`、`sort -oX`、`find … -fprint0 X`、`find … -fls X`、
/// `date -s @…`、`hostname 新名` 全都真会写/改——之前都被当成只读 → 自动档
/// 直接执行，绕过 write_categories 门）。
///
/// 附着写法（`-oFILE`）与长选项（`--output=FILE`）都要覆盖。
fn read_only_exception(base: &str, args: &[&str]) -> Option<(AiWriteCategory, String)> {
    match base {
        // find：-delete/-exec 会删/跑；-fprint*/-fls 会写文件。
        "find" => args
            .iter()
            .find(|a| {
                matches!(
                    **a,
                    "-delete"
                        | "-exec"
                        | "-execdir"
                        | "-ok"
                        | "-okdir"
                        | "-fprint"
                        | "-fprint0"
                        | "-fprintf"
                        | "-fls"
                )
            })
            .map(|a| (AiWriteCategory::File, format!("find {a} writes"))),
        // sort / uniq：-o 与 --output 都写文件（-oFILE 是附着写法）。
        "sort" | "uniq" => args
            .iter()
            .find(|a| a.starts_with("--output") || (a.starts_with("-o") && a.len() > 2))
            .map(|a| (AiWriteCategory::File, format!("{base} {a} writes a file"))),
        // git：--output=<file> 把输出写进文件。
        "git" => args
            .iter()
            .find(|a| a.starts_with("--output"))
            .map(|a| (AiWriteCategory::File, format!("git {a} writes a file"))),
        // journalctl：--vacuum* / --rotate 会删日志。
        "journalctl" => args
            .iter()
            .find(|a| a.starts_with("--vacuum") || **a == "--rotate")
            .map(|a| {
                (
                    AiWriteCategory::File,
                    format!("journalctl {a} deletes logs"),
                )
            }),
        // date：-s / --set 改系统时钟。
        "date" => args
            .iter()
            .find(|a| **a == "-s" || a.starts_with("--set"))
            .map(|a| {
                (
                    AiWriteCategory::Service,
                    format!("date {a} changes the system clock"),
                )
            }),
        // hostname：带位置参数 = 改主机名（无参只读）。
        "hostname" => args.iter().find(|a| !a.starts_with('-')).map(|a| {
            (
                AiWriteCategory::Service,
                format!("hostname {a} changes the system hostname"),
            )
        }),
        _ => None,
    }
}

/// 命令分级（**自动档的放行判断入口**）。
///
/// 顺序：**red 先判**（逃逸形态里也可能有 red——`echo x; rm -rf /` 必须拒，
/// 不能因为「有 `;`」就降级放行），再判逃逸，最后只读/写/未知。
pub fn classify_command(cmd: &str) -> AiCommandVerdict {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return AiCommandVerdict::new(AiCommandClass::Unknown, "empty command");
    }
    // 1) red：不可逆/灾难面 → 直接拒绝。
    if let Some((kind, excerpt)) = scan_red(trimmed) {
        return AiCommandVerdict::new(
            AiCommandClass::Red,
            format!("red rule {kind} matched: {excerpt}"),
        );
    }
    // 2) 逃逸形态 → 降级确认。
    if let Some(reason) = scan_escape(trimmed) {
        return AiCommandVerdict::new(AiCommandClass::Escape, reason);
    }
    // 3) 只读 / 写 / 未知。
    let mut tokens = trimmed.split_whitespace();
    let first = tokens.next().unwrap_or("");
    let base = first.rsplit('/').next().unwrap_or(first);
    let args: Vec<&str> = tokens.collect();
    if let Some(spec) = command_spec(base) {
        if let Some(sub_ro) = spec.read_only_subcommands {
            let sub = args.first().copied().unwrap_or("");
            // 「只读子命令 + 不会写盘的参数」→ 只读；否则按写操作处置。
            // 例外命中的按**例外自己的类别**算（`git diff --output=X` 是写文件，
            // 不是写 git 仓库）。
            if let Some((cat, reason)) = read_only_exception(base, &args) {
                return AiCommandVerdict::new(AiCommandClass::Write(cat), reason);
            }
            if sub_ro.contains(&sub) {
                return AiCommandVerdict::new(
                    AiCommandClass::ReadOnly,
                    format!("read-only subcommand {base} {sub}"),
                );
            }
            // 不在只读子命令名单里 → 按写操作处置（无类别 = 未识别）。
            return match spec.write_category {
                Some(cat) => AiCommandVerdict::new(
                    AiCommandClass::Write(cat),
                    format!("write command {base} ({cat:?})"),
                ),
                None => AiCommandVerdict::new(
                    AiCommandClass::Unknown,
                    format!("unrecognized subcommand {base} {sub}"),
                ),
            };
        }
        if let Some((cat, reason)) = read_only_exception(base, &args) {
            return AiCommandVerdict::new(AiCommandClass::Write(cat), reason);
        }
        return match spec.write_category {
            Some(cat) => AiCommandVerdict::new(
                AiCommandClass::Write(cat),
                format!("write command {base} ({cat:?})"),
            ),
            None => AiCommandVerdict::new(
                AiCommandClass::Unknown,
                format!("unrecognized command {base}"),
            ),
        };
    }
    if READ_ONLY_COMMANDS.contains(&base) {
        if let Some((cat, reason)) = read_only_exception(base, &args) {
            return AiCommandVerdict::new(AiCommandClass::Write(cat), reason);
        }
        return AiCommandVerdict::new(
            AiCommandClass::ReadOnly,
            format!("read-only command {base}"),
        );
    }
    AiCommandVerdict::new(
        AiCommandClass::Unknown,
        format!("unrecognized command {base}"),
    )
}

// ---------------------------------------------------------------------------
// 主机授权面（Tauri 命令）
// ---------------------------------------------------------------------------

/// 主机授权行（前端消费面；serde camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHostPolicyView {
    pub host_id: i64,
    /// 自动档总闸。
    pub auto_enabled: bool,
    /// 自动档允许直接执行的写操作类别（线面字符串数组）。
    pub write_categories: Vec<String>,
}

fn to_view(p: &AiHostPolicy) -> AiHostPolicyView {
    AiHostPolicyView {
        host_id: p.host_id,
        auto_enabled: p.auto_enabled,
        write_categories: p
            .write_categories
            .iter()
            .map(|c| c.as_str().to_string())
            .collect(),
    }
}

/// 取某主机的自动执行授权（无行 = 默认拒：自动档不可用）。
#[tauri::command]
pub(crate) fn ai_policy_get(
    state: State<'_, VaultState>,
    host_id: i64,
) -> CmdResult<Option<AiHostPolicyView>> {
    ensure_unlocked(&state.0)?;
    let row = AiHostPolicies::get_for_host(&state.0, host_id).map_err(|e| policy_error(&e))?;
    Ok(row.as_ref().map(to_view))
}

/// 落/改某主机的自动执行授权（upsert）。
#[tauri::command]
pub(crate) fn ai_policy_set(
    state: State<'_, VaultState>,
    host_id: i64,
    auto_enabled: bool,
    write_categories: Vec<String>,
) -> CmdResult<AiHostPolicyView> {
    ensure_unlocked(&state.0)?;
    let mut cats = Vec::with_capacity(write_categories.len());
    for raw in &write_categories {
        let cat = AiWriteCategory::parse(raw).ok_or_else(|| {
            format!("unknown write category: {raw:?}（合法值：package/service/file/git）")
        })?;
        if !cats.contains(&cat) {
            cats.push(cat);
        }
    }
    let row = AiHostPolicies::upsert(
        &state.0,
        &AiHostPolicyInput {
            host_id,
            auto_enabled,
            write_categories: cats,
        },
    )
    .map_err(|e| policy_error(&e))?;
    Ok(to_view(&row))
}

/// 可自动执行的**写操作类别清单**（前端据此渲染勾选项——后端是唯一真源，
/// 前端不再手写一份：后端加一类、前端漏一类 = 那个类别永远勾不上 ✅）。
#[tauri::command]
pub(crate) fn ai_policy_categories() -> Vec<String> {
    AiWriteCategory::ALL
        .iter()
        .map(|c| c.as_str().to_string())
        .collect()
}

/// 全部已授权主机（设置页列表）。
#[tauri::command]
pub(crate) fn ai_policy_list(state: State<'_, VaultState>) -> CmdResult<Vec<AiHostPolicyView>> {
    ensure_unlocked(&state.0)?;
    let rows = AiHostPolicies::list(&state.0).map_err(|e| e.to_string())?;
    Ok(rows.iter().map(to_view).collect())
}

/// 回收某主机的自动执行权（删行 = 回到默认拒）。
#[tauri::command]
pub(crate) fn ai_policy_delete(state: State<'_, VaultState>, host_id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    AiHostPolicies::delete(&state.0, host_id).map_err(|e| policy_error(&e))
}

/// 授权面错误 → **可读**（不把 SQLite 原文甩给用户）。
///
/// 悬空 host 的 FK 违例是最常见的一种（主机刚被删）——原文是
/// 「FOREIGN KEY constraint failed」，用户看不懂也不知道该做什么。
/// ★ 文案用**英文**：后端错误面统一英文（它们会原文进模型上下文；本地化
/// 由前端 i18n 层做——硬编码中文会把非中文用户绕过本地化面）。
fn policy_error(e: &ottr_vault::VaultError) -> String {
    let text = e.to_string();
    if text.contains("FOREIGN KEY") {
        return "host not found (it may have been deleted) - refresh the host list and retry"
            .to_string();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_commands_are_auto_executable() {
        for cmd in [
            "ls -la /var/log",
            "df -h /",
            "cat /etc/hostname",
            "ps aux",
            "grep -r pattern /etc",
            "uptime",
            "systemctl status nginx",
            "journalctl -n 50",
            "git status",
            "git log --oneline",
        ] {
            let v = classify_command(cmd);
            assert_eq!(
                v.class,
                AiCommandClass::ReadOnly,
                "只读命令应放行: {cmd} ({:?})",
                v.class
            );
        }
    }

    #[test]
    fn red_commands_are_rejected_outright() {
        for cmd in [
            "rm -rf /",
            "rm -rf /*",
            "rm -r -f /var",
            "dd if=/dev/zero of=/dev/sda",
            "mkfs.ext4 /dev/sdb1",
            ":(){ :|:& };:",
            "kill -9 1",
            "chmod -R 777 /",
            "chown -R root /",
            "git push --force origin main",
            "git reset --hard HEAD~1",
            "DROP TABLE users;",
            "shred /dev/sda",
            "echo x > /dev/sda",
        ] {
            let v = classify_command(cmd);
            assert_eq!(
                v.class,
                AiCommandClass::Red,
                "red 命令必须直接拒: {cmd}（实际 {:?}）",
                v.class
            );
        }
    }

    #[test]
    fn escape_forms_are_downgraded_not_executed() {
        for cmd in [
            "cat /etc/passwd > /tmp/x",
            "ls | grep root",
            "echo $(whoami)",
            "sh -c 'rm -rf /tmp/x'",
            "bash -c ls",
            "sudo ls /root",
            "env FOO=1 ls",
            "xargs rm",
            "python3 -c 'print(1)'",
            "cat a && cat b",
        ] {
            let v = classify_command(cmd);
            assert_eq!(
                v.class,
                AiCommandClass::Escape,
                "逃逸形态必须降级: {cmd}（实际 {:?}）",
                v.class
            );
        }
    }

    #[test]
    fn write_commands_carry_their_category() {
        assert_eq!(
            classify_command("apt install nginx").class,
            AiCommandClass::Write(AiWriteCategory::Package)
        );
        assert_eq!(
            classify_command("systemctl restart nginx").class,
            AiCommandClass::Write(AiWriteCategory::Service)
        );
        assert_eq!(
            classify_command("rm /tmp/x").class,
            AiCommandClass::Write(AiWriteCategory::File)
        );
        assert_eq!(
            classify_command("git commit -m x").class,
            AiCommandClass::Write(AiWriteCategory::Git)
        );
    }

    #[test]
    fn read_only_exceptions_fall_back_to_write() {
        // find -delete / -exec 会写 → 不是只读。
        assert_ne!(
            classify_command("find /tmp -name '*.log' -delete").class,
            AiCommandClass::ReadOnly
        );
        assert_ne!(
            classify_command("find /tmp -name '*.log' -exec rm {} ;").class,
            AiCommandClass::ReadOnly
        );
        // journalctl --vacuum 会删日志。
        assert_ne!(
            classify_command("journalctl --vacuum-time=7d").class,
            AiCommandClass::ReadOnly
        );
        // systemctl 非只读子命令 → 服务写操作。
        assert_eq!(
            classify_command("systemctl restart nginx").class,
            AiCommandClass::Write(AiWriteCategory::Service)
        );
    }

    #[test]
    fn unknown_commands_are_downgraded() {
        assert_eq!(
            classify_command("frobnicate --all").class,
            AiCommandClass::Unknown
        );
        assert_eq!(classify_command("").class, AiCommandClass::Unknown);
    }

    #[test]
    fn red_wins_over_escape() {
        // 有 `;`（逃逸形态）但内容是 red → 必须拒，不能降级放行。
        assert_eq!(
            classify_command("echo hi; rm -rf /").class,
            AiCommandClass::Red
        );
    }

    #[test]
    fn path_prefixed_commands_are_classified_by_base_name() {
        assert_eq!(
            classify_command("/usr/bin/ls -la").class,
            AiCommandClass::ReadOnly
        );
        assert_eq!(classify_command("/bin/rm -rf /").class, AiCommandClass::Red);
    }

    /// **跨语言钉死（行为面）**：共享用例表 `frontend/ai/dangerCases.json`
    /// ——前端用 `danger.ts` 的 `classify()` 断言 jsLevel、Rust 用
    /// `classify_command` 断言 rustClass，**同一批命令两边必须同结论**。
    ///
    /// 为什么不用「比对源码文本」：文本比对测不出**正则引擎的语义差异**
    /// （JS 的 `\b`/`\w` 恒为 ASCII，Rust 的 regex crate 默认 Unicode）——
    /// 正是那种差异让 `cat ürm -rf /` 前端判红、后端判只读 → 自动档会直接
    /// 执行前端标红的命令（2026-11-04 独立审查实测）。
    #[test]
    fn shared_danger_cases_match_frontend_classification() {
        let raw = include_str!("../../../frontend/ai/dangerCases.json");
        let doc: serde_json::Value = serde_json::from_str(raw).expect("用例表是合法 JSON");
        let cases = doc["cases"].as_array().expect("cases 是数组");
        assert!(!cases.is_empty(), "用例表不能为空");
        for c in cases {
            let cmd = c["cmd"].as_str().expect("cmd 是字符串");
            let want = c["rustClass"].as_str().expect("rustClass 是字符串");
            let js_level = c["jsLevel"].as_str().expect("jsLevel 是字符串");
            let got = classify_command(cmd);
            let got_class = match &got.class {
                AiCommandClass::ReadOnly => "readonly".to_string(),
                AiCommandClass::Escape => "escape".to_string(),
                AiCommandClass::Red => "red".to_string(),
                AiCommandClass::Unknown => "unknown".to_string(),
                AiCommandClass::Write(cat) => format!("write:{}", cat.as_str()),
            };
            assert_eq!(
                got_class, want,
                "命令 {cmd:?} 的 Rust 判定与用例表不符（前端判 {js_level}）"
            );
            // **危险方向的红**：前端判红 → 后端必须也判红（否则自动档会执行
            // 前端标红的命令）。
            if js_level == "red" {
                assert_eq!(
                    got.class,
                    AiCommandClass::Red,
                    "命令 {cmd:?} 前端判红、后端没判红 —— 两侧语义必须一致"
                );
            }
        }
    }

    /// red 规则表与前端 danger.ts 的**规则名**双向覆盖（新增规则漏一边会红）。
    #[test]
    fn red_rules_match_frontend_table() {
        let ts = include_str!("../../../frontend/ai/danger.ts");
        for (kind, _pattern, _flags) in RED_RULES {
            assert!(
                ts.contains(&format!("kind: \"{kind}\"")),
                "前端 danger.ts 缺少 red 规则 {kind}（Rust 侧有）"
            );
        }
        // 反向：前端 red 档的每个 kind 都得在 Rust 侧有对应条目。
        for kind in [
            "recursive-delete",
            "delete-root",
            "disk-write",
            "fork-bomb",
            "kill9-init",
            "perm-open-recursive-root",
            "owner-change-root",
            "force-push",
            "hard-reset",
            "sql-drop",
            "device-redirect",
            "disk-erase",
        ] {
            let in_rust =
                RED_RULES.iter().any(|(k, _, _)| *k == kind) || kind == "recursive-delete"; // token 判定（非正则）
            assert!(in_rust, "Rust 侧缺少 red 规则 {kind}");
        }
    }
}
