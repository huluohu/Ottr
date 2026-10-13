//! 数据目录解析（2026-10-13 Windows 便携版）：全应用唯一的「数据根」出口。
//!
//! 默认（安装版）：Tauri `app_data_dir()`——macOS
//! ~/Library/Application Support/<identifier>/，Windows %APPDATA%\<identifier>/，
//! Linux ~/.local/share/<identifier>/。
//!
//! 便携版：exe 同目录存在 `portable.flag` 标记文件时，数据根 = exe 同目录的
//! `data/`——配置/密码库/录制/定时任务输出全部落在文件夹内，整包复制即试用、
//! 删包即卸载，不写注册表外的系统位置（WebView2 运行时为系统组件除外）。
//!
//! 判定按 current_exe 定位、OnceLock 缓存（进程生命周期内 exe 位置不变）；
//! 纯函数（marker_path/portable_data_dir/is_portable_dir）单独导出供测试。

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// 便携模式标记文件名（exe 同目录；空文件即可，内容不读）。
pub const PORTABLE_MARKER: &str = "portable.flag";
/// 便携模式数据目录名（exe 同目录下）。
pub const PORTABLE_DATA_DIR: &str = "data";

/// exe 所在目录（解析失败 = None → 永远走安装版路径，不误入便携）。
fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(|p| p.to_path_buf())
}

fn portable_cached() -> bool {
    static PORTABLE: OnceLock<bool> = OnceLock::new();
    *PORTABLE.get_or_init(|| exe_dir().is_some_and(|d| is_portable_dir(&d)))
}

/// 便携模式判定（进程级缓存；前端经 `app_portable` 命令消费同一结果）。
pub fn is_portable() -> bool {
    portable_cached()
}

/// 标记文件完整路径（`<exe 目录>/portable.flag`）。
pub fn marker_path(exe_dir: &std::path::Path) -> PathBuf {
    exe_dir.join(PORTABLE_MARKER)
}

/// 便携数据根（`<exe 目录>/data`）。
pub fn portable_data_dir(exe_dir: &std::path::Path) -> PathBuf {
    exe_dir.join(PORTABLE_DATA_DIR)
}

/// 目录内是否有便携标记（纯函数，测试可直接对临时目录断言）。
pub fn is_portable_dir(exe_dir: &std::path::Path) -> bool {
    marker_path(exe_dir).is_file()
}

/// 数据根唯一出口：便携 = exe 旁 `data/`（自动创建），安装版 = app_data_dir。
/// 全部持久化落盘面（vault/录制/cron 输出/MCP socket/导出兜底）一律经本函数，
/// 禁止再直接调 `app.path().app_data_dir()`（便携版会漏进 %APPDATA%）。
pub fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if portable_cached() {
        let dir = exe_dir()
            .map(|d| portable_data_dir(&d))
            .ok_or_else(|| "resolve exe dir: current_exe unavailable".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        return Ok(dir);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))
}

/// 前端查询便携模式（设置→关于据此隐藏「检查更新」；toast 编排同源拦截）。
/// 便携版无安装器/无 updater 签名件——自动更新对它没有意义，更新 = 从
/// Release 下载新便携包替换 exe（data/ 原地保留）。
#[tauri::command]
pub(crate) fn app_portable() -> bool {
    is_portable()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ottr-paths-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dir_without_marker_is_not_portable() {
        let dir = temp_root("no-marker");
        assert!(!is_portable_dir(&dir));
    }

    #[test]
    fn marker_file_means_portable_but_dir_does_not() {
        let dir = temp_root("with-marker");
        std::fs::write(marker_path(&dir), b"").unwrap();
        assert!(is_portable_dir(&dir));
        // 标记必须是文件：同名目录不算（防呆——误建目录不应静默切换数据面）
        let dir2 = temp_root("marker-is-dir");
        std::fs::create_dir_all(marker_path(&dir2)).unwrap();
        assert!(!is_portable_dir(&dir2));
    }

    #[test]
    fn portable_data_dir_is_exe_sibling_data() {
        let dir = temp_root("data-dir");
        assert_eq!(portable_data_dir(&dir), dir.join("data"));
        assert_eq!(marker_path(&dir), dir.join(PORTABLE_MARKER));
    }
}
