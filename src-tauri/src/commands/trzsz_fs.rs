//! trzsz 本地文件桥（Phase 2 Task 4，B10 下半）。
//!
//! 裁定（task-4 简报/协调者记录）：trzsz 协议栈用 npm `trzsz` 库（TrzszFilter，
//! 带内协议、xterm 集成成熟），**前端强制走它的 node 模式**——浏览器模式依赖
//! File System Access API（WKWebView 无 `showDirectoryPicker`，上传/下载皆不可
//! 用），node 模式要求宿主提供 callback 风格 fs。Tauri webview 无 Node 运行时，
//! 故由前端 fs 垫片（src/terminal/trzsz/fsShim.ts）把库的 fs 调用映射到本模块
//! 命令（invoke 桥），本模块是唯一 IO 落点。
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
//! 分页读边界 / 截断与追加 / check 三态 / mkdir 递归 / remove 递归。
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::Path;

use base64::Engine as _;

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

#[tauri::command]
pub async fn trzsz_fs_stat(path: String) -> TrzszFsStat {
    stat_inner(&path)
}

#[tauri::command]
pub async fn trzsz_fs_read(path: String, offset: u64, len: u32) -> Result<String, String> {
    // 单块上限 1MiB（nodefs 分块由协议 chunk 决定，远小于此；防御性钳制）
    read_inner(&path, offset, len.min(1024 * 1024))
}

#[tauri::command]
pub async fn trzsz_fs_write(path: String, data: String, truncate: bool) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("decode: {e}"))?;
    write_inner(&path, &bytes, truncate)
}

#[tauri::command]
pub async fn trzsz_fs_list(path: String) -> Result<Vec<String>, String> {
    list_inner(&path)
}

#[tauri::command]
pub async fn trzsz_fs_mkdir(path: String) -> Result<(), String> {
    mkdir_inner(&path)
}

#[tauri::command]
pub async fn trzsz_fs_remove(path: String, recursive: bool) -> Result<(), String> {
    remove_inner(&path, recursive)
}

#[tauri::command]
pub async fn trzsz_fs_check(path: String, mode: String) -> bool {
    check_inner(&path, &mode)
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
        assert!(base64::engine::general_purpose::STANDARD
            .decode(empty)
            .unwrap()
            .is_empty());
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
}
