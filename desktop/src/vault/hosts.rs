//! hosts / host_groups / known_hosts 存储面（0004 迁移起 known_hosts 按
//! host 端点记账）。纯搬家拆分（原 vault.rs 单文件）。
//!
//! **known_hosts 导入链的三道闸**（2026-11-02 审计整改）：
//! 1. **路径准入**（[`validate_import_path`]）：绝对路径 + 非符号链接 +
//!    常规文件——原实现接受任意 path 并整文件读入 + 逐条落库，等于
//!    「任意文件读 + 批量写信任锚」；
//! 2. **规模上限**：字节 8 MiB + **条目数** 2 万条
//!    （`ottr_ssh::known_hosts::MAX_KNOWN_HOSTS_ENTRIES`）——超限报错，
//!    不静默截断；
//! 3. **不在 async 运行时线程上做阻塞 IO**：文件读 + 解析 + 落库整段下
//!    `spawn_blocking`（Tauri 的 async 命令跑在 tokio 运行时线程上，阻塞
//!    IO 占住它 = 其他 IPC 排队 = 用户侧「应用卡住」）。
//!
//! 错误码前缀（前端据此分流提示）：[`KNOWN_HOSTS_FILE_NOT_FOUND`]（文件
//! 不存在，返回全零报告）/ [`KNOWN_HOSTS_PATH_REJECTED`]（路径不可用，
//! 直接报错）。

use std::path::{Path, PathBuf};

use tauri::State;

use ottr_vault::{Host, HostGroups, HostInput, Hosts, KnownHosts};

use super::{CmdResult, VaultState, cmd, ensure_unlocked};

// --- hosts -----------------------------------------------------------------

#[specta::specta]
#[tauri::command]
pub fn hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_get(state: State<'_, VaultState>, id: i64) -> CmdResult<Option<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::get(&state.0, id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_create(state: State<'_, VaultState>, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::create(&state.0, input))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_update(state: State<'_, VaultState>, id: i64, input: HostInput) -> CmdResult<Host> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::update(&state.0, id, input))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::delete(&state.0, id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_list_by_group(
    state: State<'_, VaultState>,
    group_id: Option<i64>,
) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::list_by_group(&state.0, group_id))
}

#[specta::specta]
#[tauri::command]
pub fn hosts_search(state: State<'_, VaultState>, query: String) -> CmdResult<Vec<Host>> {
    ensure_unlocked(&state.0)?;
    cmd(Hosts::search(&state.0, &query))
}

// --- host_groups -----------------------------------------------------------

#[specta::specta]
#[tauri::command]
pub fn host_groups_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::HostGroup>> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_create(
    state: State<'_, VaultState>,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::create(
        &state.0,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_update(
    state: State<'_, VaultState>,
    id: i64,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
) -> CmdResult<ottr_vault::HostGroup> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::update(
        &state.0,
        id,
        &name,
        parent_id,
        color.as_deref(),
    ))
}

#[specta::specta]
#[tauri::command]
pub fn host_groups_delete(state: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&state.0)?;
    cmd(HostGroups::delete(&state.0, id))
}

// --- known_hosts -----------------------------------------------------------
// 0004 迁移（Task 8 义务①）起按 host 端点记账：host_key = "address:port"
// （ottr_vault::host_endpoint_key 构造），fingerprint 列 = 当前信任锚。

#[specta::specta]
#[tauri::command]
pub fn known_hosts_list(state: State<'_, VaultState>) -> CmdResult<Vec<ottr_vault::KnownHost>> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::list(&state.0))
}

#[specta::specta]
#[tauri::command]
pub fn known_hosts_upsert(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::upsert(&state.0, &host_key, &fingerprint))
}

/// 把某端点的信任锚置为「已核验」（state=ok）。
///
/// 【信任模型，已记录】本命令是**用户可见功能**（已知主机管理页里，用户看着
/// 指纹点「信任」），不是内部接口。它**不做**「只有连接流程能写 ok」的闸门——
/// 本应用的安全边界是 **webview 即信任边界**（同 TOFU 问询的既有口径）：能调用
/// IPC 的代码已被视为可信。因此「webview 内任意脚本可写一条受信锚」是既有模型
/// 的固有面，不是本命令独有的洞。
///
/// 若将来要收紧，正解是给写操作加**用户在场令牌**（用户在 UI 上确认 → 后端发
/// 一次性 token → 写操作必须带 token），而不是在这里加启发式校验。
#[specta::specta]
#[tauri::command]
pub fn known_hosts_verify(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::verify(&state.0, &host_key, &fingerprint))
}

#[specta::specta]
#[tauri::command]
pub fn known_hosts_mark_changed(
    state: State<'_, VaultState>,
    host_key: String,
    fingerprint: String,
) -> CmdResult<ottr_vault::KnownHost> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::mark_changed(&state.0, &host_key, &fingerprint))
}

/// 删除 = 忘记该端点（B9 管理页，Task 6 Phase 3）：行消失后下次连接重走
/// TOFU（首见 pending）。返回是否有行被删（幂等面）。
#[specta::specta]
#[tauri::command]
pub fn known_hosts_delete(state: State<'_, VaultState>, host_key: String) -> CmdResult<bool> {
    ensure_unlocked(&state.0)?;
    cmd(KnownHosts::delete(&state.0, &host_key))
}

/// known_hosts 文件不存在时的错误码前缀（前端据此展示「未找到文件」提示，
/// 不把路径/文案硬编码进前端）。格式：`"<code>: <path>"`。
pub const KNOWN_HOSTS_FILE_NOT_FOUND: &str = "known_hosts_file_not_found";

/// known_hosts **路径不可用**时的错误码前缀（2026-11-02 审计整改）——
/// 相对路径 / 符号链接 / 非常规文件（目录、设备、FIFO、socket）。与
/// [`KNOWN_HOSTS_FILE_NOT_FOUND`] 同款前缀风格：前端据此区分「文件不存在」
/// （可提示换个路径）与「路径不可用」（提示必须是绝对路径的真实文件）。
/// 格式：`"<code>: <原因>"`。
pub const KNOWN_HOSTS_PATH_REJECTED: &str = "known_hosts_path_rejected";

/// 默认 known_hosts 路径：`~/.ssh/known_hosts`（HOME / USERPROFILE 均兼顾三端；
/// 与 `ssh_config::default_ssh_config_path` 同款兼容写法）。
fn default_known_hosts_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let home = PathBuf::from(home);
    if home.as_os_str().is_empty() {
        return None;
    }
    Some(home.join(".ssh").join("known_hosts"))
}

/// 导入路径准入判定（**纯函数**——判定逻辑与 IO 解耦，便于单测）。
///
/// * `link_meta`：**不跟随**符号链接的元数据（`symlink_metadata`）——判 symlink；
/// * `meta`：**跟随**链接后的元数据（`metadata`）——判常规文件。
///
/// 三条硬约束（2026-11-02 审计整改：原实现接受任意 path 并整文件读入 +
/// 逐条落库 = 「任意文件读 + 批量写信任锚」）：
/// 1. **绝对路径**——相对路径的解析基准是进程 CWD（GUI 应用的 CWD 不可预期），
///    「用户以为的文件」与实际读到的文件可能根本不是一个；
/// 2. **拒绝符号链接**——校验（stat）与使用（read）必须落在同一个 inode 上，
///    否则二者之间可被替换（TOCTOU：校验的是 A、读的是 B）；
/// 3. **常规文件**——目录 / 设备 / FIFO / socket 一律拒绝（读设备可能挂死，
///    读 FIFO 会等到对端出现 = 永久阻塞）。
///
/// 失败文案带 [`KNOWN_HOSTS_PATH_REJECTED`] 前缀（前端据此分流提示）。
pub(crate) fn validate_import_path(
    link_meta: &std::fs::Metadata,
    meta: &std::fs::Metadata,
    path: &Path,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "{KNOWN_HOSTS_PATH_REJECTED}: {} is not an absolute path",
            path.display()
        ));
    }
    if link_meta.file_type().is_symlink() {
        return Err(format!(
            "{KNOWN_HOSTS_PATH_REJECTED}: {} is a symbolic link",
            path.display()
        ));
    }
    if !meta.file_type().is_file() {
        return Err(format!(
            "{KNOWN_HOSTS_PATH_REJECTED}: {} is not a regular file",
            path.display()
        ));
    }
    Ok(())
}

/// 「文件不存在」的全零报告（用户没这个文件是常态——不报错，报「未找到」
/// 让前端展示；与既有 [`KNOWN_HOSTS_FILE_NOT_FOUND`] 语义一致）。
fn not_found_report(path: &Path) -> ottr_vault::KnownHostsImportReport {
    ottr_vault::KnownHostsImportReport {
        added: 0,
        skipped_duplicate: 0,
        skipped_conflict: 0,
        skipped_hashed: 0,
        skipped_other: 0,
        errors: vec![format!("{KNOWN_HOSTS_FILE_NOT_FOUND}: {}", path.display())],
    }
}

/// 导入本地 known_hosts（`path=None` → 默认路径 `~/.ssh/known_hosts`；
/// Windows 用 `%USERPROFILE%\.ssh\known_hosts`）。报告含 added /
/// skipped_duplicate / skipped_conflict / errors。
///
/// 语义（见 `ottr_vault::KnownHosts::import`）：导入走 **verify 语义**
/// （state=ok / verified=1）——否则首次连接照样弹 TOFU 确认框，导入白做；
/// 同端点已存在的**一律不覆盖**（相同指纹 = 跳过重复，不同指纹 = 跳过冲突）。
///
/// 文件不存在**不报错**（用户没这个文件是常态）：返回全零报告 + 一条说明性
/// errors 文案（[`KNOWN_HOSTS_FILE_NOT_FOUND`] 前缀），前端展示「未找到文件」。
#[specta::specta]
#[tauri::command]
pub async fn known_hosts_import(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> CmdResult<ottr_vault::KnownHostsImportReport> {
    ensure_unlocked(&state.0)?;
    let path = path
        .map(PathBuf::from)
        .or_else(default_known_hosts_path)
        .ok_or_else(|| "cannot resolve home directory".to_string())?;
    // `Arc<Vault>` 克隆出命令作用域（State 借用本身不能进 'static 闭包）。
    let vault = state.0.clone();
    tokio::task::spawn_blocking(move || import_known_hosts_sync(&vault, &path))
        .await
        .map_err(|e| format!("known_hosts import join: {e}"))?
}

/// 导入核心（**同步**；调用方负责放进 `spawn_blocking`——见命令壳）。
///
/// **不在 async 运行时线程上做阻塞 IO**（2026-11-02 审计整改）：文件读 +
/// 解析 + 逐条落库（每条都要抢 vault 连接锁）整段下 `spawn_blocking`——
///
/// Tauri 的 async 命令跑在 tokio 运行时线程上，阻塞 IO 占住它 = 其他 IPC
/// 排队（用户侧表现为「应用卡住」）。`Arc<Vault>` 是 `Send + Sync`（SQLite
/// 连接在 `Mutex` 里），与 `hostkey_audit::audit_round` 同款写法（落库也在
/// 阻塞池内——vault 的 `with_conn` 是「单连接串行访问」，不自己发明并发模型）。
///
/// 路径**不可用**（相对路径 / 符号链接 / 非常规文件）→ 直接报错
/// （[`KNOWN_HOSTS_PATH_REJECTED`] 前缀），不读不落库。
fn import_known_hosts_sync(
    vault: &ottr_vault::Vault,
    path: &Path,
) -> CmdResult<ottr_vault::KnownHostsImportReport> {
    // 路径准入（绝对 + 非符号链接 + 常规文件）——判定逻辑见
    // `validate_import_path`（纯函数，单测直驱）。
    let link_meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 用户没这个文件是常态——不报错，报「未找到」让前端展示。
            return Ok(not_found_report(path));
        }
        Err(e) => return Err(format!("stat {}: {e}", path.display())),
    };
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 校验与读取之间被删掉（TOCTOU）——按「未找到」处理，不硬报错。
            return Ok(not_found_report(path));
        }
        Err(e) => return Err(format!("stat {}: {e}", path.display())),
    };
    validate_import_path(&link_meta, &meta, path)?;
    // 大小上限：整文件读进内存 + 逐条落库，超大文件会把导入拖死
    // （每条都要抢 vault 连接锁）。8 MiB 足够放下任何真实 known_hosts。
    const MAX_KNOWN_HOSTS_BYTES: u64 = 8 * 1024 * 1024;
    if meta.len() > MAX_KNOWN_HOSTS_BYTES {
        return Err(format!(
            "{} is too large to import ({} bytes > {} bytes)",
            path.display(),
            meta.len(),
            MAX_KNOWN_HOSTS_BYTES
        ));
    }
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 用户没这个文件是常态——不报错，报「未找到」让前端展示。
            return Ok(not_found_report(path));
        }
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    // UTF-8 BOM：Windows 上被编辑器存过的 known_hosts 常带 BOM——不剥的话
    // 首行的 host 会带上 U+FEFF，落库锚变成 "\u{feff}host:22"，与运行时端点
    // 键永远不匹配（等于没导入）。
    let content = content.strip_prefix('\u{feff}').unwrap_or(&content);
    // 条目数上限（2026-11-02 审计整改）：字节上限之外再加一道——畸形/巨型
    // 文件能产出几十万条目，逐条落库足以把一次导入拖成分钟级。超限**报错**
    // （不静默截断，用户能改选文件）。
    let parsed = ottr_ssh::known_hosts::parse_known_hosts_file_limited(
        content,
        ottr_ssh::known_hosts::MAX_KNOWN_HOSTS_ENTRIES,
    )
    .map_err(|e| format!("{}: {e}", path.display()))?;
    // 择一（同端点多密钥型 → 优先 ed25519，OpenSSH 语义在 ottr-ssh 层）。
    let selected = ottr_ssh::known_hosts::select_by_endpoint(&parsed.entries);
    let import_entries: Vec<ottr_vault::KnownHostImportEntry> = selected
        .into_iter()
        .map(|s| ottr_vault::KnownHostImportEntry {
            host: s.host,
            port: s.port,
            fingerprint: s.fingerprint,
            candidates: s.candidates,
        })
        .collect();
    Ok(ottr_vault::KnownHosts::import(
        vault,
        &import_entries,
        parsed.skipped_hashed,
        parsed.skipped_other,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一个绝对路径下的常规文件（临时目录），返回 (路径, 元数据对)。
    fn regular_file(dir: &Path, name: &str) -> (PathBuf, std::fs::Metadata, std::fs::Metadata) {
        let path = dir.join(name);
        fs::write(&path, b"host ssh-ed25519 AAAA\n").unwrap();
        let link_meta = fs::symlink_metadata(&path).unwrap();
        let meta = fs::metadata(&path).unwrap();
        (path, link_meta, meta)
    }

    /// 造一个符号链接（Unix 优先；Windows 无开发者模式时跳过该用例）。
    fn make_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    /// 常规文件 → 放行（导入的正常路径）。
    #[test]
    fn validate_import_path_accepts_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, link_meta, meta) = regular_file(dir.path(), "known_hosts");
        assert_eq!(validate_import_path(&link_meta, &meta, &path), Ok(()));
    }

    /// 相对路径 → 拒绝（解析基准依赖进程 CWD，GUI 应用不可预期）。
    #[test]
    fn validate_import_path_rejects_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        let (path, link_meta, meta) = regular_file(dir.path(), "known_hosts");
        let relative = Path::new("known_hosts");
        let err = validate_import_path(&link_meta, &meta, relative).unwrap_err();
        assert!(
            err.starts_with(KNOWN_HOSTS_PATH_REJECTED),
            "错误必须带路径不可用错误码前缀：{err}"
        );
        assert!(err.contains("absolute"), "错误文案要说清原因：{err}");
        // 同一份元数据 + 绝对路径 → 放行（拒绝只因路径形态，与文件本身无关）。
        assert_eq!(validate_import_path(&link_meta, &meta, &path), Ok(()));
    }

    /// 符号链接 → 拒绝（校验与使用必须落在同一 inode，否则校验即被架空）。
    #[test]
    fn validate_import_path_rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let (target, _, _) = regular_file(dir.path(), "real_known_hosts");
        let link = dir.path().join("known_hosts_link");
        if !make_symlink(&target, &link) {
            // 无权限建链接的平台（Windows 非开发者模式）→ 跳过。
            return;
        }
        let link_meta = fs::symlink_metadata(&link).unwrap();
        let meta = fs::metadata(&link).unwrap();
        let err = validate_import_path(&link_meta, &meta, &link).unwrap_err();
        assert!(
            err.starts_with(KNOWN_HOSTS_PATH_REJECTED),
            "错误必须带路径不可用错误码前缀：{err}"
        );
        assert!(err.contains("symbolic link"), "错误文案要说清原因：{err}");
    }

    /// 目录 / 设备 / FIFO → 拒绝（`metadata.file_type().is_file()` 判定：
    /// 目录读会 EISDIR，设备可能挂死，FIFO 会等到对端出现 = 永久阻塞）。
    #[test]
    fn validate_import_path_rejects_non_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();
        let link_meta = fs::symlink_metadata(&sub).unwrap();
        let meta = fs::metadata(&sub).unwrap();
        let err = validate_import_path(&link_meta, &meta, &sub).unwrap_err();
        assert!(
            err.starts_with(KNOWN_HOSTS_PATH_REJECTED),
            "错误必须带路径不可用错误码前缀：{err}"
        );
        assert!(err.contains("regular file"), "错误文案要说清原因：{err}");
    }

    /// 「文件不存在」与「路径不可用」是两个错误码——前端据此分流提示。
    #[test]
    fn file_not_found_and_path_rejected_use_distinct_codes() {
        assert_ne!(KNOWN_HOSTS_FILE_NOT_FOUND, KNOWN_HOSTS_PATH_REJECTED);
        let report = not_found_report(Path::new("/tmp/does-not-exist/known_hosts"));
        assert_eq!(report.errors.len(), 1);
        assert!(
            report.errors[0].starts_with(KNOWN_HOSTS_FILE_NOT_FOUND),
            "未找到文件必须走「未找到」码：{:?}",
            report.errors
        );
        assert_eq!(report.added, 0);
    }
}
