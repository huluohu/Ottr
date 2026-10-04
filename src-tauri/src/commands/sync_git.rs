//! 同步通道宿主桥（Phase 5 Task 4）：git 通道 exec 桥 + 信封口令钥匙链。
//!
//! 背景（task-2-report 披露，归本任务清偿）：GitTransport（src/sync/git.ts）
//! 的 `GitExec` 注入面 + node 后端只覆盖 vitest/e2e——webview 无 child_process，
//! Rust 侧此前亦无通用 shell 命令，git 通道在生产 webview 不可用。本模块沿
//! trzsz_fs 先例交付**白名单 git exec 桥**：不是通用 shell，而是把
//! createGitTransport 实际发出的七种 argv 形态逐一钉死。
//!
//! **argv 形态钉死（本模块的安全核，比子命令白名单更紧）**：`plan_exec` 对完整
//! argv 做全形状匹配——选项面固定（`--quiet`/`--`/`-m`/`origin`/`--porcelain`），
//! 位置参数逐个再校验。攻击面闭环：
//!   * 选项注入（`--upload-pack=…` 形态）：形状匹配下多出的任何选项直接拒绝
//!     （TS 侧 `--` 分隔符 + repoUrl 校验之外的 Rust 权威层）；
//!   * 命令传输型 repoUrl（`ext::sh -c …`）：`validate_repo_url` 复刻
//!     git.ts validateRepoUrl 的 scheme 白名单（https/http/ssh/file/本地绝对
//!     路径/盘符/UNC/scp-like），`ext::`/`git::` 等在 Rust 边界再拒一次——
//!     TS 校验可被绕过（webview 进程可直连 invoke），Rust 才是权威边界；
//!   * cwd 逃逸：show/add/status/commit/push 的 cwd 必须落在 scratch 目录
//!     （`<tmp>/ottr-sync-git-*`，`pin_scratch_path` 按组件校验，拒 `..`）；
//!     clone 目标目录同钉；
//!   * env：恒设 `GIT_TERMINAL_PROMPT=0`（交互式凭据提示在无 TTY 只会挂起，
//!     git.ts 同款）；commit 作者经显式参数注入 env，不接受任意 env 表。
//!
//! scratch 三命令（mkdtemp/write/cleanup 的 Rust 落点；webview 不能写文件，
//! git.ts push 的 node:fs 写入由 `GitDeps.writeFile` 注入点改走这里）：
//! create → `sync_git_scratch`；写信封文件 → `sync_git_scratch_write`（路径
//! 钉在 scratch 下，父目录允许创建=git.ts filePath 校验过的子目录形态）；
//! 收尾 → `sync_git_scratch_cleanup`（remove_dir_all，同样钉死）。
//!
//! 超时：`EXEC_TIMEOUT` 120s 轮询 try_wait 超限 kill（nodeGitExec 60s 的
//! Rust 对应面）；`--quiet` 全覆盖 + 信封体积小，管道死锁面披露于测试注释。
//!
//! 信封口令钥匙链（task-2 裁定「不落盘，存系统钥匙链归 Task 4」→ 本任务
//! 落地，沿 T11 keyring 先例）：service = "ottr.dev"（vault 正式数据同
//! service）、account = "sync-passphrase"（条目级隔离，与主密码条目互不可见）。
//! 幂等写 = 先删后存（KeyringStorage::save 同款，平台 set-on-existing 行为
//! 不一）；无条目 = `None`（keyring v3 NoEntry）。CI 不测真钥匙链
//! （InMemoryStorage 先例：CI 无桌面环境），命令体薄包装不过自动化。
//! 边界声明（fix round 1 Minor-3）：口令明文过 invoke 参数（webview→Rust
//! IPC 进程内传递，落盘面只在钥匙链）——沿 T11 vault unlock 已知边界。
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// scratch 目录名前缀（std::env::temp_dir() 下的命名空间）。
const SCRATCH_PREFIX: &str = "ottr-sync-git-";
/// 单次 git 子命令上限（clone/push 网络操作含排队余量）。
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// 信封口令钥匙链（T11 keyring 先例；CI 不触真钥匙链，命令体薄包装）
// ---------------------------------------------------------------------------

/// 与 ottr-vault master_key::DEFAULT_SERVICE 同 service（正式数据命名空间），
/// account 独立条目——主密码与信封口令互不可见。pub(crate)：vault_reset
/// 清库须同删本条目（T5 评审 P1——漏清则重置后云信封仍可被记忆口令解密）。
pub(crate) const SYNC_SERVICE: &str = "ottr.dev";
pub(crate) const SYNC_ACCOUNT: &str = "sync-passphrase";

fn sync_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SYNC_SERVICE, SYNC_ACCOUNT).map_err(|e| format!("entry new: {e}"))
}

/// 保存/更换信封口令（幂等：先删后存）。
#[tauri::command]
pub fn sync_passphrase_set(value: String) -> Result<(), String> {
    let entry = sync_entry()?;
    let _ = entry.delete_credential();
    entry.set_password(&value).map_err(|e| format!("set: {e}"))
}

/// 读取信封口令；无条目 = None（keyring v3 NoEntry 显式映射，不当错误吞）。
#[tauri::command]
pub fn sync_passphrase_get() -> Result<Option<String>, String> {
    match sync_entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("get: {e}")),
    }
}

/// 清除记住的口令（UI「不记住」出口；无条目亦 Ok）。
#[tauri::command]
pub fn sync_passphrase_del() -> Result<(), String> {
    match sync_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("del: {e}")),
    }
}

// ---------------------------------------------------------------------------
// scratch 目录（git 一次性工作副本的 Rust 落点）
// ---------------------------------------------------------------------------

/// scratch 根（temp_dir + SCRATCH_PREFIX 命名空间）。
fn scratch_root() -> PathBuf {
    std::env::temp_dir()
}

/// 路径钉死：必须在 `<tmp>/ottr-sync-git-*/` 命名空间内，逐组件拒 `..`。
/// 返回规范化前的原路径（string 来 string 去，与 TS 侧逐字一致）。
fn pin_scratch_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if raw.is_empty() {
        return Err("sync-git: scratch path is empty".into());
    }
    if !path.is_absolute() {
        return Err(format!("sync-git: scratch path must be absolute: {raw}"));
    }
    let root = scratch_root();
    if !path.starts_with(&root) {
        return Err(format!("sync-git: scratch path escapes temp dir: {raw}"));
    }
    let mut comps = path
        .strip_prefix(&root)
        .expect("checked prefix")
        .components();
    let first = comps
        .next()
        .ok_or_else(|| format!("sync-git: scratch path missing namespace: {raw}"))?;
    if !first
        .as_os_str()
        .to_string_lossy()
        .starts_with(SCRATCH_PREFIX)
    {
        return Err(format!("sync-git: path is not a scratch dir: {raw}"));
    }
    for comp in comps {
        let s = comp.as_os_str().to_string_lossy();
        if s == ".." || s == "." || s.is_empty() {
            return Err(format!(
                "sync-git: scratch path has unsafe component: {raw}"
            ));
        }
    }
    Ok(path.to_path_buf())
}

/// 新建一次性 scratch 工作目录（mkdtemp 等效：pid + 纳秒 + 重试计数，冲突
/// 概率即重试；std 无随机源不引依赖）。
#[tauri::command]
pub fn sync_git_scratch() -> Result<String, String> {
    let root = scratch_root();
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    for attempt in 0..64u128 {
        let dir = root.join(format!("{SCRATCH_PREFIX}{pid}-{}", nanos + attempt));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir.to_string_lossy().into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("sync-git scratch create: {e}")),
        }
    }
    Err("sync-git scratch: exhausted unique-name retries".into())
}

/// 写信封文件进 scratch（数据 = 信封 JSON 文本；父目录允许创建——git.ts
/// filePath 校验过的子目录形态，路径整体过 `pin_scratch_path`）。
#[tauri::command]
pub fn sync_git_scratch_write(path: String, data: String) -> Result<(), String> {
    let path = pin_scratch_path(&path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("sync-git write mkdir: {e}"))?;
    }
    std::fs::write(&path, data.as_bytes()).map_err(|e| format!("sync-git write: {e}"))
}

/// 清扫 scratch（remove_dir_all；已不存在 = Ok 幂等）。
#[tauri::command]
pub fn sync_git_scratch_cleanup(dir: String) -> Result<(), String> {
    let dir = pin_scratch_path(&dir)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("sync-git cleanup: {e}")),
    }
}

// ---------------------------------------------------------------------------
// git exec 桥（argv 形态钉死）
// ---------------------------------------------------------------------------

/// git 子命令执行回执（GitExecResult 同构：TS 侧 { code, stdout, stderr }）。
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct SyncGitExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// 相对路径参数（show 的 `HEAD:<path>`、add 的 path）校验——与 git.ts
/// validateFilePath 同规则：相对、`/` 分隔、拒空/`.`/`..` 组件与反斜杠。
fn validate_repo_relative_path(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("sync-git: repo file path must not be empty".into());
    }
    if raw.starts_with('/') {
        return Err(format!("sync-git: repo file path must be relative: {raw}"));
    }
    if raw.contains('\\') {
        return Err(format!("sync-git: repo file path must use \"/\": {raw}"));
    }
    for comp in raw.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." {
            return Err(format!("sync-git: unsafe path component in: {raw}"));
        }
    }
    Ok(())
}

/// repoUrl scheme 白名单（git.ts validateRepoUrl 的 Rust 权威复刻）：
/// https/http/ssh/file、POSIX 绝对路径、Windows 盘符、UNC、scp-like；
/// 命令传输面（ext::/git:: 等）与 `-` 前缀（选项注入）拒绝。
fn validate_repo_url(raw: &str) -> Result<(), String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("sync-git: repoUrl must not be empty".into());
    }
    if url.starts_with('-') {
        return Err(format!(
            "sync-git: repoUrl must not start with \"-\": {}",
            &url[..url.len().min(80)]
        ));
    }
    let lower = url.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("ssh://")
        || lower.starts_with("file://")
        || url.starts_with('/')
        || is_windows_drive(url)
        || url.starts_with("\\\\")
        || is_scp_like(url);
    if !allowed {
        return Err(format!(
            "sync-git: unsupported repoUrl scheme (allowed: https, http, ssh, file, local path, scp-like): {}",
            &url[..url.len().min(80)]
        ));
    }
    Ok(())
}

/// `^[A-Za-z]:[\\/]`（盘符）。
fn is_windows_drive(url: &str) -> bool {
    let b = url.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

/// `^[^:/@]+@[^:/]+:\S`（scp-like：user@host:path，ssh 家族）。
fn is_scp_like(url: &str) -> bool {
    let Some(at) = url.find('@') else {
        return false;
    };
    let user = &url[..at];
    if user.is_empty() || user.contains([':', '/', '@']) {
        return false;
    }
    let rest = &url[at + 1..];
    let Some(colon) = rest.find(':') else {
        return false;
    };
    let host = &rest[..colon];
    if host.is_empty() || host.contains([':', '/']) {
        return false;
    }
    !rest[colon + 1..].trim().is_empty()
}

/// git refspec 尾段（分支名）校验：git ref 规则的保守子集——非空、无空白/
/// 控制字符、无 `..`/`~`/`^`/`:`/`?`/`*`/`[`/`\`、不以 `-`/`/` 开头、不以
/// `/` 或 `.lock` 结尾。
fn validate_branch(branch: &str) -> Result<(), String> {
    let bad = |why: &str| Err::<(), String>(format!("sync-git: invalid branch {why}: {branch}"));
    if branch.is_empty() || branch.starts_with(['-', '/']) || branch.ends_with('/') {
        return bad("shape");
    }
    if branch.ends_with(".lock") || branch.ends_with('.') {
        return bad("suffix");
    }
    for ch in branch.chars() {
        if ch.is_whitespace() || ch.is_control() {
            return bad("whitespace/control char");
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return bad("reserved char");
        }
    }
    if branch.contains("..") {
        return bad("range");
    }
    Ok(())
}

/// 计划好的 exec：最终 argv + cwd + env（plan_exec 纯函数的产物，测试面）。
#[derive(Clone, Debug, PartialEq)]
struct GitPlan {
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: Vec<(String, String)>,
}

/// argv 形态钉死：七种形态逐一全匹配，位置参数逐个校验，多余/缺失/未知
/// 一律拒绝。cwd 语义：clone/ls-remote 无 cwd（且 clone 目标必须是 scratch）；
/// 其余必须有 scratch cwd。
fn plan_exec(
    args: &[String],
    cwd: Option<String>,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitPlan, String> {
    let require_cwd = || -> Result<PathBuf, String> {
        let cwd = cwd
            .as_deref()
            .ok_or_else(|| "sync-git: missing cwd for workdir subcommand".to_string())?;
        pin_scratch_path(cwd)
    };
    let s = |i: usize| -> Option<&str> { args.get(i).map(|x| x.as_str()) };

    let plan = match (s(0), s(1), s(2), s(3), s(4), args.len()) {
        // clone --quiet -- <url> <scratch-dir>（目标目录钉在 scratch 命名空间）
        (Some("clone"), Some("--quiet"), Some("--"), Some(url), Some(dir), 5) => {
            validate_repo_url(url)?;
            pin_scratch_path(dir)?;
            GitPlan {
                args: args.to_vec(),
                cwd: None,
                env: vec![],
            }
        }
        // ls-remote --quiet -- <url> HEAD
        (Some("ls-remote"), Some("--quiet"), Some("--"), Some(url), Some("HEAD"), 5) => {
            validate_repo_url(url)?;
            GitPlan {
                args: args.to_vec(),
                cwd: None,
                env: vec![],
            }
        }
        // show HEAD:<path>（读信封文件；缺 = 文件未入库）
        (Some("show"), Some(rev), _, _, _, 2) => {
            let path = rev
                .strip_prefix("HEAD:")
                .ok_or_else(|| format!("sync-git: show expects HEAD:<path>, got {rev}"))?;
            validate_repo_relative_path(path)?;
            GitPlan {
                args: args.to_vec(),
                cwd: Some(require_cwd()?),
                env: vec![],
            }
        }
        // add -- <path>
        (Some("add"), Some("--"), Some(path), _, _, 3) => {
            validate_repo_relative_path(path)?;
            GitPlan {
                args: args.to_vec(),
                cwd: Some(require_cwd()?),
                env: vec![],
            }
        }
        // status --porcelain
        (Some("status"), Some("--porcelain"), _, _, _, 2) => GitPlan {
            args: args.to_vec(),
            cwd: Some(require_cwd()?),
            env: vec![],
        },
        // commit --quiet -m <msg>
        (Some("commit"), Some("--quiet"), Some("-m"), Some(_msg), _, 4) => {
            let mut env = vec![("GIT_TERMINAL_PROMPT".into(), "0".into())];
            if let Some(name) = author_name {
                env.push(("GIT_AUTHOR_NAME".into(), name.clone()));
                env.push(("GIT_COMMITTER_NAME".into(), name));
            }
            if let Some(email) = author_email {
                env.push(("GIT_AUTHOR_EMAIL".into(), email.clone()));
                env.push(("GIT_COMMITTER_EMAIL".into(), email));
            }
            GitPlan {
                args: args.to_vec(),
                cwd: Some(require_cwd()?),
                env,
            }
        }
        // push --quiet origin HEAD:refs/heads/<branch>
        (Some("push"), Some("--quiet"), Some("origin"), Some(refspec), _, 4) => {
            let branch = refspec.strip_prefix("HEAD:refs/heads/").ok_or_else(|| {
                format!("sync-git: push expects HEAD:refs/heads/<branch>, got {refspec}")
            })?;
            validate_branch(branch)?;
            GitPlan {
                args: args.to_vec(),
                cwd: Some(require_cwd()?),
                env: vec![],
            }
        }
        _ => {
            return Err(format!(
                "sync-git: argv shape not allowed (subcommand: {})",
                s(0).unwrap_or("<empty>")
            ))
        }
    };
    // GIT_TERMINAL_PROMPT=0 恒设（除 commit 已带，其余形态补齐）。
    let mut p = plan;
    if !p.env.iter().any(|(k, _)| k == "GIT_TERMINAL_PROMPT") {
        p.env.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    }
    Ok(p)
}

/// 管道抽干线程（stdout/stderr 共用形态；进程退出 → EOF → 线程自然收尾）。
fn drain_pipe<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> Option<std::thread::JoinHandle<String>> {
    pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    })
}

/// 执行 GitPlan：spawn → **双读线程立即开抽**（fix round 1 I-1：轮询
/// try_wait 期间若不读管道，`git show` 的 stdout（整份信封）超管道缓冲
/// （macOS/Linux 64KB，数百条凭据即可达）时 git 阻塞在 write 永不退出 →
/// 120s kill → git 通道功能性失效。stdout/stderr 各一线程 read_to_string
/// 到 EOF；轮询只管进程态，进程退出后 join 取回全量）→ 超时 kill（kill 后
/// 管道 EOF、线程自然收尾，join 仍回收已产出部分）。选型说明：线程读 +
/// try_wait 轮询保留 120s 超时语义（纯阻塞 `wait()` 无超时面；poll 循环内
/// 非阻塞读要自管 EAGAIN 状态机，复杂度不成比例）。
fn run_plan(plan: GitPlan) -> Result<SyncGitExecResult, String> {
    let mut cmd = Command::new("git");
    cmd.args(&plan.args)
        .envs(plan.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &plan.cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| format!("sync-git spawn: {e}"))?;
    let stdout_task = drain_pipe(child.stdout.take());
    let stderr_task = drain_pipe(child.stderr.take());
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("sync-git wait: {e}"))?
        {
            Some(status) => break status,
            None => {
                if start.elapsed() > EXEC_TIMEOUT {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().map_err(|e| format!("sync-git reap: {e}"))?;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let stdout = stdout_task.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = stderr_task.and_then(|h| h.join().ok()).unwrap_or_default();
    if timed_out {
        return Ok(SyncGitExecResult {
            code: 124,
            stdout,
            stderr: format!(
                "sync-git: timed out after {}s\n{}",
                EXEC_TIMEOUT.as_secs(),
                stderr.trim()
            ),
        });
    }
    Ok(SyncGitExecResult {
        code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}

/// git 子命令执行（webview 唯一入口；纯校验 + spawn_blocking，无共享状态）。
#[tauri::command]
pub async fn sync_git_exec(
    args: Vec<String>,
    cwd: Option<String>,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<SyncGitExecResult, String> {
    let plan = plan_exec(&args, cwd, author_name, author_email)?;
    tauri::async_runtime::spawn_blocking(move || run_plan(plan))
        .await
        .map_err(|e| format!("sync-git join: {e}"))?
}

// ---------------------------------------------------------------------------
// 测试：形状钉死 / URL 白名单 / 路径钉死 / 分支校验为纯函数面；真 git 走
// 本地 bare 仓库全链（clone→write→add/commit/push→show），git 缺失即失败
// （fail-loud，沿 T2 e2e 纪律）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn scratch_dir(tag: &str) -> String {
        scratch_root()
            .join(format!("{SCRATCH_PREFIX}test-{tag}"))
            .to_string_lossy()
            .into_owned()
    }

    // --- validate_repo_url ---

    #[test]
    fn repo_url_whitelist_accepts_documented_forms() {
        for url in [
            "https://github.com/u/r.git",
            "http://gitea.lan/u/r.git",
            "ssh://git@host/u/r.git",
            "file:///tmp/repo.git",
            "/tmp/repo.git",
            "C:\\repos\\r.git",
            "\\\\nas\\repos\\r",
            "git@github.com:u/r.git",
        ] {
            validate_repo_url(url).unwrap_or_else(|e| panic!("{url}: {e}"));
        }
    }

    #[test]
    fn repo_url_rejects_option_injection_and_command_transports() {
        for url in [
            "",
            "-quiet",
            "--upload-pack=touch /tmp/x",
            "ext::sh -c touch /tmp/x",
            "git::whatever",
            "ftp://host/r.git",
        ] {
            assert!(validate_repo_url(url).is_err(), "must reject: {url}");
        }
    }

    // --- 相对路径 / 分支 ---

    #[test]
    fn repo_relative_path_rejects_escape_forms() {
        for p in [
            "", "/abs/x", "a\\b", "a//b", "./a", "../a", "a/../b", "a/..",
        ] {
            assert!(validate_repo_relative_path(p).is_err(), "must reject: {p}");
        }
        validate_repo_relative_path("ottr-sync.json").unwrap();
        validate_repo_relative_path("snapshots/ottr-sync.json").unwrap();
    }

    #[test]
    fn branch_validation_rejects_reserved_shapes() {
        for b in [
            "", "-x", "/x", "a b", "a..b", "a~b", "a^b", "a:b", "a*b", "x.lock", "a/",
        ] {
            assert!(validate_branch(b).is_err(), "must reject: {b}");
        }
        validate_branch("main").unwrap();
        validate_branch("feature/sync-1").unwrap();
    }

    // --- plan_exec：七形态通过 + 注入/缺 cwd/未知形态拒绝 ---

    #[test]
    fn plan_accepts_all_seven_pinned_shapes() {
        let dir = scratch_dir("plan");
        let ok = |args: &[&str], cwd: Option<String>| {
            plan_exec(&s(args), cwd, None, None).unwrap_or_else(|e| panic!("{args:?}: {e}"))
        };
        ok(&["clone", "--quiet", "--", "https://h/r.git", &dir], None);
        ok(&["ls-remote", "--quiet", "--", "git@h:r.git", "HEAD"], None);
        ok(&["show", "HEAD:ottr-sync.json"], Some(dir.clone()));
        ok(&["add", "--", "ottr-sync.json"], Some(dir.clone()));
        ok(&["status", "--porcelain"], Some(dir.clone()));
        ok(&["commit", "--quiet", "-m", "ottr sync"], Some(dir.clone()));
        ok(
            &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
            Some(dir.clone()),
        );
    }

    #[test]
    fn plan_rejects_extra_options_workdir_escapes_and_unknowns() {
        let dir = scratch_dir("rej");
        let bad = |args: &[&str], cwd: Option<String>| {
            assert!(
                plan_exec(&s(args), cwd, None, None).is_err(),
                "must reject: {args:?}"
            );
        };
        // 选项注入：多出的 --depth / 选项形 URL（repoUrl 校验层）全拒
        bad(
            &[
                "clone",
                "--quiet",
                "--depth",
                "1",
                "--",
                "https://h/r.git",
                &dir,
            ],
            None,
        );
        bad(&["clone", "--quiet", "--", "--upload-pack=x", &dir], None);
        bad(&["clone", "--", "https://h/r.git", &dir], None); // 缺 --quiet 也拒（形状钉死）
        bad(
            &["ls-remote", "--quiet", "--", "ext::sh -c x", "HEAD"],
            None,
        );
        bad(&["show", "HEAD:../../etc/passwd"], Some(dir.clone()));
        bad(&["show", "HEAD:ottr-sync.json"], None); // 缺 cwd
        bad(&["add", "--", "../escape"], Some(dir.clone()));
        bad(
            &["status", "--porcelain"],
            Some("/tmp/not-scratch/x".into()),
        );
        bad(
            &["commit", "--quiet", "-m", "x", "--amend"],
            Some(dir.clone()),
        ); // 多参
        bad(
            &["push", "--quiet", "origin", "HEAD:refs/heads/a..b"],
            Some(dir.clone()),
        );
        bad(
            &["push", "--quiet", "origin", "refs/heads/main"],
            Some(dir.clone()),
        );
        bad(&["rev-parse", "HEAD"], Some(dir.clone())); // 白名单外子命令
        bad(&["config", "user.name", "evil"], Some(dir.clone()));
        bad(&[], None);
    }

    #[test]
    fn plan_always_sets_terminal_prompt_off() {
        let dir = scratch_dir("env");
        for (args, cwd) in [
            (
                vec!["clone", "--quiet", "--", "https://h/r.git", &dir],
                None,
            ),
            (vec!["show", "HEAD:ottr-sync.json"], Some(dir.clone())),
        ] {
            let args: Vec<String> = args.iter().map(|x| x.to_string()).collect();
            let plan = plan_exec(&args, cwd, None, None).unwrap();
            assert!(plan
                .env
                .iter()
                .any(|(k, v)| k == "GIT_TERMINAL_PROMPT" && v == "0"));
        }
        // commit 作者经显式参数进 env，不接受任意 env 表
        let plan = plan_exec(
            &s(&["commit", "--quiet", "-m", "m"]),
            Some(dir),
            Some("Ottr".into()),
            Some("ottr@local".into()),
        )
        .unwrap();
        assert!(plan
            .env
            .contains(&("GIT_AUTHOR_NAME".into(), "Ottr".into())));
        assert!(plan
            .env
            .contains(&("GIT_COMMITTER_EMAIL".into(), "ottr@local".into())));
    }

    // --- pin_scratch_path ---

    #[test]
    fn scratch_path_pinning() {
        let good = scratch_dir("pin");
        pin_scratch_path(&good).unwrap();
        pin_scratch_path(&format!("{good}/sub/ottr-sync.json")).unwrap();
        for p in [
            "",
            "relative/x",
            "/tmp/elsewhere/x",
            &format!("{good}/../escape"),
            &format!("{good}/sub/../../escape"),
            &scratch_root().join("other-prefix/x").to_string_lossy(),
        ] {
            assert!(pin_scratch_path(p).is_err(), "must reject: {p}");
        }
    }

    // --- scratch 生命周期 + 真 git 全链（fail-loud：git 缺失即 panic）---

    fn require_git() {
        let ok = Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .status();
        assert!(
            ok.map(|s| s.success()).unwrap_or(false),
            "git must be on PATH (fail-loud)"
        );
    }

    #[test]
    fn scratch_lifecycle_and_real_git_roundtrip() {
        require_git();
        let scratch = sync_git_scratch().expect("scratch create");
        assert!(Path::new(&scratch).is_dir());
        // 命名空间在 pin 之下（自产自销闭环）
        pin_scratch_path(&scratch).expect("own scratch must pass pinning");

        let bare = scratch_root().join(format!("{SCRATCH_PREFIX}test-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        let bare_str = bare.to_string_lossy().into_owned();
        let init = Command::new("git")
            .args(["init", "--bare", "--initial-branch=main", &bare_str])
            .status()
            .unwrap();
        assert!(init.success());

        // clone → write → add → commit → push → show 全链（经形状钉死面）
        let exec = |args: &[&str], cwd: Option<String>| {
            let r = tauri::async_runtime::block_on(sync_git_exec(
                s(args),
                cwd,
                Some("Ottr Test".into()),
                Some("ottr@test.local".into()),
            ))
            .expect("exec ok");
            assert_eq!(r.code, 0, "git failed: {args:?} → {r:?}");
            r
        };
        exec(&["clone", "--quiet", "--", &bare_str, &scratch], None);
        sync_git_scratch_write(
            format!("{scratch}/snapshots/ottr-sync.json"),
            "{\"ottr-sync\":1}".into(),
        )
        .unwrap();
        exec(
            &["add", "--", "snapshots/ottr-sync.json"],
            Some(scratch.clone()),
        );
        let status = exec(&["status", "--porcelain"], Some(scratch.clone()));
        assert!(!status.stdout.trim().is_empty(), "staged change must show");
        exec(
            &["commit", "--quiet", "-m", "ottr sync test"],
            Some(scratch.clone()),
        );
        exec(
            &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
            Some(scratch.clone()),
        );
        let shown = exec(
            &["show", "HEAD:snapshots/ottr-sync.json"],
            Some(scratch.clone()),
        );
        assert_eq!(shown.stdout.trim(), "{\"ottr-sync\":1}");

        // 越权写 / 越权清扫拒绝
        assert!(sync_git_scratch_write("/tmp/ottr-not-scratch/x".into(), "x".into()).is_err());
        assert!(sync_git_scratch_write("/etc/passwd".into(), "x".into()).is_err());

        let scratch2 = scratch.clone();
        assert!(sync_git_scratch_cleanup(scratch2).is_ok());
        assert!(!Path::new(&scratch).exists());
        // 幂等：再清一次仍 Ok
        assert!(sync_git_scratch_cleanup(scratch.clone()).is_ok());
        let _ = std::fs::remove_dir_all(&bare);
    }

    /// fix round 1 I-1 回归钉死：`git show` 输出超管道缓冲（macOS/Linux
    /// 64KB）不死于 write 阻塞——首版轮询期间不读管道，信封 >64KB（数百条
    /// 凭据的现实体量）会被 120s kill，git 通道功能性失效。构造：bare 仓库
    /// 塞一个 256KB blob，`show HEAD:<大文件>` 必须全量取回（头尾标记 + 精确
    /// 长度）。修复前本测试命中 120s 超时（fail），修复后即刻通过。
    #[test]
    fn show_large_envelope_drains_full_stdout() {
        require_git();
        let scratch = sync_git_scratch().expect("scratch create");
        let bare = scratch_root().join(format!(
            "{SCRATCH_PREFIX}test-bare-big-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        let bare_str = bare.to_string_lossy().into_owned();
        let init = Command::new("git")
            .args(["init", "--bare", "--initial-branch=main", &bare_str])
            .status()
            .unwrap();
        assert!(init.success());

        let exec = |args: &[&str], cwd: Option<String>| {
            let r = tauri::async_runtime::block_on(sync_git_exec(
                s(args),
                cwd,
                Some("Ottr Test".into()),
                Some("ottr@test.local".into()),
            ))
            .expect("exec ok");
            assert_eq!(r.code, 0, "git failed: {args:?} → {r:?}");
            r
        };
        exec(&["clone", "--quiet", "--", &bare_str, &scratch], None);
        // 256KB 信封（head/tail 标记 + 每行带序号，防 git 内容压缩巧合）
        const BIG: usize = 256 * 1024;
        let mut payload = String::with_capacity(BIG + 64);
        payload.push_str("\"HEAD-MARK:");
        let mut line = 0usize;
        while payload.len() < BIG {
            payload.push_str(&format!("\"row-{line:06}\":{},", line));
            line += 1;
        }
        payload.push_str("\"TAIL-MARK\"}");
        sync_git_scratch_write(format!("{scratch}/ottr-sync.json"), payload.clone()).unwrap();
        exec(&["add", "--", "ottr-sync.json"], Some(scratch.clone()));
        exec(
            &["commit", "--quiet", "-m", "big envelope"],
            Some(scratch.clone()),
        );
        exec(
            &["push", "--quiet", "origin", "HEAD:refs/heads/main"],
            Some(scratch.clone()),
        );

        let before = std::time::Instant::now();
        let shown = exec(&["show", "HEAD:ottr-sync.json"], Some(scratch.clone()));
        // 全量取回（不是缓冲截断），且远快于 120s 超时（秒级内 = 未阻塞）
        assert_eq!(shown.stdout.len(), payload.len(), "stdout must be complete");
        assert!(shown.stdout.starts_with("\"HEAD-MARK:"));
        assert!(shown.stdout.ends_with("\"TAIL-MARK\"}"));
        assert!(
            before.elapsed() < std::time::Duration::from_secs(30),
            "show must not block on pipe buffer (elapsed {:?})",
            before.elapsed()
        );
        sync_git_scratch_cleanup(scratch).unwrap();
        let _ = std::fs::remove_dir_all(&bare);
    }
}
