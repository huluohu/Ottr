//! trzsz 本地文件桥（Phase 2 Task 4，B10 下半；Fix round 1 I-1：会话级白名单）。
//!
//! 裁定（task-4 简报/协调者记录）：trzsz 协议栈用 npm `trzsz` 库（TrzszFilter，
//! 带内协议、xterm 集成成熟），**前端强制走它的 node 模式**——浏览器模式依赖
//! File System Access API（WKWebView 无 `showDirectoryPicker`，上传/下载皆不可
//! 用），node 模式要求宿主提供 callback 风格 fs。Tauri webview 无 Node 运行时，
//! 故由前端 fs 垫片（frontend/terminal/trzsz/fsShim.ts）把库的 fs 调用映射到本模块
//! 命令（invoke 桥），本模块是唯一 IO 落点。
//!
//! **路径管控（Fix round 1 I-1，评审方案 b）**：七命令全部收口在授权白名单——
//!   * 授权只来自用户动作：`trzsz_grant`（chooseSendFiles→File 授权、
//!     chooseSaveDirectory→Dir 授权、终端拖拽上传→File 授权）在登记时
//!     canonical 化；webview 侧没有第二条授权入口。
//!   * `TrzszGrants` 按 scope（前端会话 id）记账（登记即整组替换、会话关闭/
//!     传输收尾 `trzsz_revoke` 清理），校验对**全体 scope 的并集**——垫片是
//!     trzsz 模块级单例，fs 操作无法携带会话上下文（无 AsyncLocalStorage），
//!     跨会话并集是已接受的 MVP 限制（见 task-4-report Fix round 1 节）。
//!   * 校验对**生效路径**（effective_path）：存在则 canonicalize（吃掉 symlink
//!     与 `..`）；新文件归一词法 `..` 后用最近存在祖先 canonical 化拼尾段——
//!     恶意服务器文件名（`../`、绝对路径、符号链接）逃不出授权目录。
//!   * 目录前缀比对用 `Path::starts_with`（**按组件**比对，`/tmp/allowed-evil`
//!     不匹配 `/tmp/allowed`）；授权/生效两侧统一剥 Windows verbatim 前缀
//!     `\\?\`，避免 canonical 形态差导致误拒。
//!
//! 命令面（全部薄包装 std::fs，无 shell、无路径展开）：
//!   * stat / list / mkdir / remove：nodefs 校验面（checkPathsReadable 递归、
//!     getNewName 重名探测、doCreateDirectory 建目录）所需的最小读原语；
//!   * read(offset, len)：NodefsFileReader 顺序分块读（fd 偏移在前端 fd 表跟踪，
//!     本命令无状态、按绝对偏移读）；
//!   * write(truncate)：NodefsFileWriter 顺序写——`open(path,"w")` 在垫片只记
//!     fd，首次 write truncate=true（等价 node 的 open "w" 截断语义），后续
//!     append；单命令合并 create/truncate/append，免维持 Rust 侧 fd 表；
//!   * check("read"/"write")：fs.access(R_OK/W_OK) 等效判定——read=试开读；
//!     write 对目录=探针文件写入即删（真实权限判定，比 stat 位掩码诚实）。
//!
//! 测试：命令体走 `*_inner` 纯函数（tauri 命令是薄包装），tempfile 单测覆盖
//! 分页读边界 / 截断与追加 / check 三态 / mkdir 递归 / remove 递归；白名单面
//! 单测覆盖：授权内通过 / 白名单外拒绝 / `..` 逃逸 / 前缀混淆 / symlink 逃逸 /
//! 登记规范化 / revoke 清理（含跨 scope 并集语义）。
use std::collections::HashMap;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;

// ---------------------------------------------------------------------------
// 授权白名单（Fix round 1 I-1，评审方案 b）
// ---------------------------------------------------------------------------

/// 单条授权：Dir = 目录及全部后代；File = 精确文件（登记时已 canonical 化）。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Grant {
    Dir(PathBuf),
    File(PathBuf),
}

/// scope（前端会话 id）→ 授权集。登记整组替换；校验取全体 scope 并集。
/// 内部字段仅本模块触碰（命令体经 &State 借用）——不设 pub 字段。
#[derive(Default)]
pub struct TrzszGrants(Mutex<HashMap<String, Vec<Grant>>>);

/// Windows canonicalize 产生 verbatim 形态（`\\?\C:\...`），与词法归一路径
/// 形态不一致会误拒——两侧统一剥前缀（unix 无此形态，原样返回）。
fn to_compare_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// 词法归一：吃 `.`、回退 `..`（退到根外 → None）；保留前缀/根组件。
fn normalize_lexical(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            _ => out.push(comp.as_os_str()),
        }
    }
    Some(out)
}

/// 生效路径：存在 → canonicalize（吃 symlink/`..`）；否则词法归一 + 最近存在
/// 祖先 canonical 化拼尾段（新文件场景，父目录 symlink 逃逸同样被吃掉）。
fn effective_path(raw: &str) -> Result<PathBuf, String> {
    let p = Path::new(raw);
    if let Ok(c) = fs::canonicalize(p) {
        return Ok(to_compare_path(c));
    }
    let norm =
        normalize_lexical(p).ok_or_else(|| format!("path escapes filesystem root: {raw}"))?;
    let mut anc = norm.clone();
    loop {
        if let Ok(c) = fs::canonicalize(&anc) {
            let tail = norm
                .strip_prefix(&anc)
                .map_err(|_| format!("path normalize failed: {raw}"))?;
            return Ok(to_compare_path(c).join(tail));
        }
        if !anc.pop() {
            // 无任何存在祖先（理论不可达：根必存在）→ 词法形态兜底
            return Ok(to_compare_path(norm));
        }
    }
}

/// 并集校验：生效路径落在任一授权 Dir 内（组件级前缀）或等于任一授权 File。
fn grants_allow(grants: &HashMap<String, Vec<Grant>>, effective: &Path) -> bool {
    grants.values().flatten().any(|g| match g {
        Grant::Dir(d) => effective.starts_with(d),
        Grant::File(f) => effective == f,
    })
}

/// 七命令统一入口：解析生效路径 → 白名单校验；未授权给显式错误（不静默）。
fn ensure_granted(grants: &TrzszGrants, raw: &str) -> Result<PathBuf, String> {
    let map = grants.0.lock().map_err(|_| "grant store poisoned")?;
    let effective = effective_path(raw)?;
    if grants_allow(&map, &effective) {
        Ok(effective)
    } else {
        Err(format!(
            "path not granted for trzsz transfer: {raw} — choose it via the trzsz dialog first"
        ))
    }
}

/// 登记授权（scope 整组替换）：effective_path 解析（存在 → canonical 吃
/// symlink/`..`；残缺 → 词法归一 + 存在祖先），kind = "dir" | "file"。
/// 授权入口只有本命令（对话框/拖拽登记），webview 无第二条授权通道。
fn grant_inner(
    grants: &TrzszGrants,
    scope: &str,
    paths: &[String],
    kind: &str,
) -> Result<(), String> {
    if scope.is_empty() {
        return Err("grant scope is required".into());
    }
    let grant = match kind {
        "dir" => Grant::Dir,
        "file" => Grant::File,
        _ => return Err(format!("unknown grant kind: {kind}")),
    };
    let mut list = Vec::with_capacity(paths.len());
    for raw in paths {
        list.push(grant(effective_path(raw)?));
    }
    let mut map = grants.0.lock().map_err(|_| "grant store poisoned")?;
    map.insert(scope.to_string(), list);
    Ok(())
}

/// 撤销 scope 的全部授权（传输收尾 / 会话关闭；未知 scope 幂等）。
fn revoke_inner(grants: &TrzszGrants, scope: &str) -> Result<(), String> {
    let mut map = grants.0.lock().map_err(|_| "grant store poisoned")?;
    map.remove(scope);
    Ok(())
}

// ---------------------------------------------------------------------------
// fs 原语（*_inner 纯函数；命令 = 白名单校验 + inner）
// ---------------------------------------------------------------------------

/// stat 结果（nodefs 只消费 isDirectory/isFile/size；exists 供 access(F_OK)；
/// canonical 供 fs.realpath（目录递归的软链环防护）——canonicalize 失败回落原路径）。
#[derive(serde::Serialize)]
pub struct TrzszFsStat {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub canonical: String,
}

fn stat_inner(path: &str) -> TrzszFsStat {
    match fs::metadata(path) {
        Ok(m) => TrzszFsStat {
            exists: true,
            is_dir: m.is_dir(),
            is_file: m.is_file(),
            size: m.len(),
            canonical: fs::canonicalize(path)
                .unwrap_or_else(|_| Path::new(path).to_path_buf())
                .to_string_lossy()
                .into_owned(),
        },
        Err(_) => TrzszFsStat {
            exists: false,
            is_dir: false,
            is_file: false,
            size: 0,
            canonical: path.to_string(),
        },
    }
}

/// 绝对偏移分页读（base64 出；不足 len 读到 EOF 为止）。
fn read_inner(path: &str, offset: u64, len: u32) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {path}: {e}"))?;
    let mut buf = vec![0u8; len as usize];
    let mut read = 0;
    while read < buf.len() {
        match f.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("read {path}: {e}")),
        }
    }
    buf.truncate(read);
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// 顺序写：truncate=true → create+truncate+write；否则 append。
/// 命令无状态、每次调用重开文件——追加必须走 O_APPEND（append(true)），
/// 否则会从 0 覆盖（单测 write_truncates_then_appends 钉住该语义）。
fn write_inner(path: &str, data: &[u8], truncate: bool) -> Result<(), String> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(truncate)
        .append(!truncate)
        .open(path)
        .map_err(|e| format!("open {path}: {e}"))?;
    f.write_all(data).map_err(|e| format!("write {path}: {e}"))
}

fn list_inner(path: &str) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = fs::read_dir(path)
        .map_err(|e| format!("readdir {path}: {e}"))?
        .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
        .collect();
    names.sort();
    Ok(names)
}

fn mkdir_inner(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {path}: {e}"))
}

fn remove_inner(path: &str, recursive: bool) -> Result<(), String> {
    let p = Path::new(path);
    let result = if p.is_dir() && recursive {
        fs::remove_dir_all(p)
    } else if p.is_dir() {
        fs::remove_dir(p)
    } else {
        fs::remove_file(p)
    };
    result.map_err(|e| format!("remove {path}: {e}"))
}

/// access 等效判定："read" = 试开读；"write" = 目录探针写（即删）/ 文件试开追加。
/// 探针名带进程 id + 纳秒防撞；失败按不可写处理（探针自清，常规目录无残留）。
fn check_inner(path: &str, mode: &str) -> bool {
    let p = Path::new(path);
    match mode {
        "read" => fs::File::open(p).is_ok(),
        "write" => {
            if p.is_dir() {
                let probe = p.join(format!(
                    ".ottr-wprobe-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ));
                match fs::File::create(&probe) {
                    Ok(_) => {
                        drop(fs::remove_file(&probe));
                        true
                    }
                    Err(_) => false,
                }
            } else {
                fs::OpenOptions::new().append(true).open(p).is_ok()
            }
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// tauri 命令（七 fs 命令全部过白名单；grant/revoke 是授权生命周期面）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn trzsz_grant(
    grants: tauri::State<'_, TrzszGrants>,
    scope: String,
    paths: Vec<String>,
    kind: String,
) -> Result<(), String> {
    grant_inner(&grants, &scope, &paths, &kind)
}

#[tauri::command]
pub async fn trzsz_revoke(
    grants: tauri::State<'_, TrzszGrants>,
    scope: String,
) -> Result<(), String> {
    revoke_inner(&grants, &scope)
}

#[tauri::command]
pub async fn trzsz_fs_stat(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
) -> Result<TrzszFsStat, String> {
    ensure_granted(&grants, &path)?;
    Ok(stat_inner(&path))
}

#[tauri::command]
pub async fn trzsz_fs_read(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
    offset: u64,
    len: u32,
) -> Result<String, String> {
    ensure_granted(&grants, &path)?;
    // 单块上限 1MiB（nodefs 分块由协议 chunk 决定，远小于此；防御性钳制）
    read_inner(&path, offset, len.min(1024 * 1024))
}

#[tauri::command]
pub async fn trzsz_fs_write(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
    data: String,
    truncate: bool,
) -> Result<(), String> {
    ensure_granted(&grants, &path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("decode: {e}"))?;
    write_inner(&path, &bytes, truncate)
}

#[tauri::command]
pub async fn trzsz_fs_list(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
) -> Result<Vec<String>, String> {
    ensure_granted(&grants, &path)?;
    list_inner(&path)
}

#[tauri::command]
pub async fn trzsz_fs_mkdir(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
) -> Result<(), String> {
    ensure_granted(&grants, &path)?;
    mkdir_inner(&path)
}

#[tauri::command]
pub async fn trzsz_fs_remove(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    ensure_granted(&grants, &path)?;
    remove_inner(&path, recursive)
}

#[tauri::command]
pub async fn trzsz_fs_check(
    grants: tauri::State<'_, TrzszGrants>,
    path: String,
    mode: String,
) -> Result<bool, String> {
    // 未授权 ≡ access 拒绝（nodefs 侧同一错误通道）；tauri 异步带引用命令须返 Result
    Ok(match ensure_granted(&grants, &path) {
        Ok(_) => check_inner(&path, &mode),
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_reports_missing_dir_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = stat_inner(&dir.path().join("nope").to_string_lossy());
        assert!(!missing.exists);
        let file = dir.path().join("f.txt");
        fs::write(&file, b"hello").unwrap();
        let st = stat_inner(&file.to_string_lossy());
        assert!(st.exists && st.is_file && !st.is_dir && st.size == 5);
        let st = stat_inner(&dir.path().to_string_lossy());
        assert!(st.exists && st.is_dir && !st.is_file);
    }

    #[test]
    fn read_pages_at_offset_and_stops_at_eof() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bin");
        fs::write(&file, vec![0u8, 1, 2, 3, 4]).unwrap();
        use base64::Engine as _;
        let p = file.to_string_lossy();
        let head = read_inner(&p, 0, 3).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(head)
                .unwrap(),
            vec![0, 1, 2]
        );
        let tail = read_inner(&p, 3, 100).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(tail)
                .unwrap(),
            vec![3, 4]
        );
        // 越界偏移 → 空串（EOF）
        let empty = read_inner(&p, 99, 10).unwrap();
        assert!(
            base64::engine::general_purpose::STANDARD
                .decode(empty)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn write_truncates_then_appends() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out");
        let p = file.to_string_lossy().to_string();
        write_inner(&p, b"abcdef", true).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"abcdef");
        // truncate=true 再写 → 覆盖（node open "w" 语义）
        write_inner(&p, b"xy", true).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"xy");
        write_inner(&p, b"zw", false).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"xyzw");
    }

    #[test]
    fn list_mkdir_remove_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a/b/c");
        mkdir_inner(&nested.to_string_lossy()).unwrap();
        assert!(nested.is_dir());
        fs::write(nested.join("z.txt"), b"").unwrap();
        fs::write(nested.join("y.txt"), b"").unwrap();
        let names = list_inner(&nested.to_string_lossy()).unwrap();
        assert_eq!(names, vec!["y.txt", "z.txt"]);
        remove_inner(&dir.path().join("a").to_string_lossy(), true).unwrap();
        assert!(!dir.path().join("a").exists());
    }

    #[test]
    fn check_read_and_write_modes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        fs::write(&file, b"data").unwrap();
        let p = file.to_string_lossy();
        assert!(check_inner(&p, "read"));
        assert!(check_inner(&p, "write")); // 文件：试开追加
        assert!(check_inner(&dir.path().to_string_lossy(), "write")); // 目录：探针
        assert!(!check_inner(&p, "bogus"));
        assert!(!check_inner(
            &dir.path().join("gone").to_string_lossy(),
            "read"
        ));
        // 探针无残留
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".ottr-wprobe"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn write_errors_on_missing_dir_and_remove_errors_are_typed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("no/dir").to_string_lossy().to_string();
        assert!(write_inner(&p, b"x", true).is_err());
        assert!(remove_inner(&dir.path().join("gone").to_string_lossy(), false).is_err());
        // 非空目录 remove(recursive=false) 报错
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("f"), b"").unwrap();
        assert!(remove_inner(&sub.to_string_lossy(), false).is_err());
    }

    // -- 白名单（Fix round 1 I-1） ------------------------------------------

    /// 组装：登记 scope 授权（canonical 化走生产路径 grant_inner）。
    fn granted(grants: &TrzszGrants, scope: &str, raw: &Path, kind: &str) {
        grant_inner(grants, scope, &[raw.to_string_lossy().into_owned()], kind).unwrap();
    }

    #[test]
    fn whitelist_dir_file_and_prefix_confusion() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        fs::create_dir(&allowed).unwrap();
        let allowed_file = allowed.join("f.txt");
        fs::write(&allowed_file, b"x").unwrap();
        // 前缀混淆目录：allowed-evil 与 allowed 仅差一个后缀字符
        let evil = dir.path().join("allowed-evil");
        fs::create_dir(&evil).unwrap();
        fs::write(evil.join("steal.txt"), b"s").unwrap();

        granted(&grants, "s1", &allowed_file, "file");

        // File 授权：精确路径过；同目录其他文件未授权（File 授权不放大）
        let f = allowed_file.to_string_lossy().into_owned();
        assert!(ensure_granted(&grants, &f).is_ok());
        let sibling = allowed.join("other.txt").to_string_lossy().into_owned();
        assert!(ensure_granted(&grants, &sibling).is_err());

        // 追加 Dir 授权：目录自身与后代过（File 精确 + Dir 后代两级并存）
        granted(&grants, "s1", &allowed, "dir");
        assert!(ensure_granted(&grants, &allowed.to_string_lossy()).is_ok());
        assert!(ensure_granted(&grants, &sibling).is_ok());
        assert!(ensure_granted(&grants, &allowed.join("deep/new.bin").to_string_lossy()).is_ok());
        // 前缀混淆：/allowed-evil 不是 /allowed 的后代（组件级比对）
        assert!(ensure_granted(&grants, &evil.join("steal.txt").to_string_lossy()).is_err());
        assert!(ensure_granted(&grants, &evil.to_string_lossy()).is_err());
        // 白名单外（上级目录）
        assert!(
            ensure_granted(&grants, &dir.path().join("outside.txt").to_string_lossy()).is_err()
        );
    }

    #[test]
    fn dotdot_escape_rejected_and_inner_dotdot_normalized() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        fs::create_dir(&allowed).unwrap();
        granted(&grants, "s1", &allowed, "dir");

        // `..` 逃逸：/allowed/../evil 生效在授权目录外
        let escape = format!("{}/../evil", allowed.to_string_lossy());
        assert!(ensure_granted(&grants, &escape).is_err());
        // 帐内 `..` 折叠后仍在授权目录内 → 过
        let inner = allowed.join("sub/../f.txt").to_string_lossy().into_owned();
        assert!(ensure_granted(&grants, &inner).is_ok());
        // 退到根外 → 显式错误
        assert!(ensure_granted(&grants, "/../../etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        fs::create_dir(&allowed).unwrap();
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, b"s3cret").unwrap();
        std::os::unix::fs::symlink(&secret, allowed.join("innocent")).unwrap();
        granted(&grants, "s1", &allowed, "dir");
        // 经授权目录内的 symlink 读外部文件 → canonicalize 解析到授权外 → 拒绝
        let via_link = allowed.join("innocent").to_string_lossy().into_owned();
        assert!(ensure_granted(&grants, &via_link).is_err());
    }

    #[test]
    fn grant_canonicalizes_and_revoke_cleans_per_scope() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        fs::create_dir(&allowed).unwrap();
        // 登记走词法脏路径 → grant_inner canonical 化（/x/./sub/.. ≡ /x）
        let dirty = format!("{}/./sub/..", allowed.to_string_lossy());
        grant_inner(&grants, "s1", &[dirty], "dir").unwrap();
        assert!(ensure_granted(&grants, &allowed.join("f").to_string_lossy()).is_ok());

        // 其他 scope 授权不受影响（并集语义）：s2 登记后 revoke s1，s2 仍可用
        let dir2 = tempfile::tempdir().unwrap();
        granted(&grants, "s2", dir2.path(), "dir");
        let p2 = dir2.path().join("f").to_string_lossy().into_owned();
        assert!(ensure_granted(&grants, &p2).is_ok());

        revoke_inner(&grants, "s1").unwrap();
        assert!(ensure_granted(&grants, &allowed.join("f").to_string_lossy()).is_err());
        assert!(ensure_granted(&grants, &p2).is_ok()); // s2 不被波及
        // 幂等：重复 revoke 不报错
        revoke_inner(&grants, "s1").unwrap();

        // 空 scope / 未知 kind 显式报错
        assert!(
            grant_inner(
                &grants,
                "",
                &[allowed.to_string_lossy().into_owned()],
                "dir"
            )
            .is_err()
        );
        assert!(
            grant_inner(
                &grants,
                "s3",
                &[allowed.to_string_lossy().into_owned()],
                "abs"
            )
            .is_err()
        );
    }

    #[test]
    fn unregistered_scope_denies_everything() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f").to_string_lossy().into_owned();
        fs::write(&p, b"x").unwrap();
        assert!(ensure_granted(&grants, &p).is_err());
        assert!(!check_command_style_denied(&grants, &p));
    }

    /// check 命令的「未授权 ≡ 拒绝」通道（与命令体同逻辑）。
    fn check_command_style_denied(grants: &TrzszGrants, path: &str) -> bool {
        match ensure_granted(grants, path) {
            Ok(_) => check_inner(path, "read"),
            Err(_) => false,
        }
    }

    #[test]
    fn new_file_under_granted_dir_resolves_via_existing_ancestor() {
        let grants = TrzszGrants::default();
        let dir = tempfile::tempdir().unwrap();
        let allowed = dir.path().join("allowed");
        fs::create_dir(&allowed).unwrap();
        granted(&grants, "s1", &allowed, "dir");
        // 尚不存在的新文件：canonicalize 失败 → 词法归一 + 存在祖先（=授权目录）
        let fresh = allowed.join("deep/new.bin").to_string_lossy().into_owned();
        let eff = ensure_granted(&grants, &fresh).unwrap();
        assert!(eff.starts_with(fs::canonicalize(&allowed).unwrap()));
    }
}
