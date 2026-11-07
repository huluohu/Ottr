//! 窗口状态记忆（2026-11-07 用户需求）：记住上次的窗口尺寸/位置/最大化，
//! 下次启动恢复（上次最大化 → 下次自动最大化）。
//!
//! 落盘选型：**data_root()/window-state.json**（机器本地文件），**不进 vault**：
//! 窗口几何是机器属性（多屏/分辨率因设备而异），随 vault 同步会把 A 屏的
//! 几何带到 B 屏；且窗口在启动瞬间创建，早于 vault 解锁——创建路径不能
//! 依赖 vault。`remember_size` 开关默认 **开**（桌面应用的普遍预期）。
//!
//! 时序：启动 setup 中 `apply_on_launch` 恢复（在既有「配置尺寸对屏收缩」
//! 之后——记忆值覆盖配置默认）；`persist` 在 CloseRequested 与
//! RunEvent::ExitRequested 各存一次（关窗到托盘的隐藏路径前者覆盖，托盘
//! 退出后者覆盖）；remember off 时不追踪几何（`current` 原样返回已存值）。
//!
//! 单位：几何用**物理像素**（inner_size/outer_position 采集，PhysicalSize/
//! PhysicalPosition 恢复）——同屏启动/恢复对称；换屏后若越界，用户拖回即可
//! （X11/Wayland/Win32 对越界窗口的处理是平台行为，不在此假装智能）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// 窗口状态文件名（data_root 下）。
pub const WINDOW_STATE_FILE: &str = "window-state.json";

/// 窗口状态（window-state.json 的内容形态）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    /// 设置开关（设置 → 通用 → 启动「记住上次的窗口尺寸」）。默认开。
    #[serde(default = "default_true")]
    pub remember_size: bool,
    /// 上次是否最大化（恢复时优先于几何）。
    #[serde(default)]
    pub maximized: bool,
    /// 上次窗口外框原点 X（物理 px；最大化时不采集）。
    #[serde(default)]
    pub x: Option<f64>,
    /// 上次窗口外框原点 Y（物理 px）。
    #[serde(default)]
    pub y: Option<f64>,
    /// 上次窗口内容区宽（物理 px）。
    #[serde(default)]
    pub width: Option<f64>,
    /// 上次窗口内容区高（物理 px）。
    #[serde(default)]
    pub height: Option<f64>,
}

fn default_true() -> bool {
    true
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            remember_size: true,
            maximized: false,
            x: None,
            y: None,
            width: None,
            height: None,
        }
    }
}

/// 读取（文件缺失/损坏 → 默认值：默认开、无几何——损坏文件不至于让窗口
/// 状态永久失效）。
pub fn read_from(path: &std::path::Path) -> WindowState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 写入（父目录自动创建）。
pub fn write_to(path: &std::path::Path, state: &WindowState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::data_root(app)?.join(WINDOW_STATE_FILE))
}

/// 前端读开关（设置 → 通用 → 启动）。
#[tauri::command]
pub fn window_state_get(app: tauri::AppHandle) -> Result<WindowState, String> {
    Ok(read_from(&state_path(&app)?))
}

/// 前端切开关（保留几何字段，只翻 remember_size）。
#[tauri::command]
pub fn window_state_set_remember(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = state_path(&app)?;
    let mut st = read_from(&path);
    st.remember_size = enabled;
    write_to(&path, &st)
}

/// 从主窗采集当前几何并落盘（remember off = 不追踪，已存值原样保留）。
pub fn persist(window: &tauri::WebviewWindow) {
    eprintln!("[window-state] persist called");
    let Ok(path) = state_path(window.app_handle()) else {
        eprintln!("[window-state] persist: no path");
        return;
    };
    let mut st = read_from(&path);
    if !st.remember_size {
        return;
    }
    st.maximized = window.is_maximized().unwrap_or(false);
    match window.outer_position() {
        Ok(p) => {
            st.x = Some(p.x as f64);
            st.y = Some(p.y as f64);
        }
        Err(e) => eprintln!("[window-state] outer_position error: {e}"),
    }
    match window.inner_size() {
        Ok(s) => {
            st.width = Some(s.width as f64);
            st.height = Some(s.height as f64);
        }
        Err(e) => eprintln!("[window-state] inner_size error: {e}"),
    }
    let _ = write_to(&path, &st);
}

/// 启动恢复（setup 调用；remember off = 不动，保持 tauri.conf 默认）。
pub fn apply_on_launch(window: &tauri::WebviewWindow) {
    let Ok(path) = state_path(window.app_handle()) else {
        return;
    };
    let st = read_from(&path);
    if !st.remember_size {
        return;
    }
    if st.maximized {
        let _ = window.maximize();
        return;
    }
    if let (Some(w), Some(h)) = (st.width, st.height) {
        let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    }
    if let (Some(x), Some(y)) = (st.x, st.y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str) -> std::path::PathBuf {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(name);
        std::mem::forget(dir); // 测试进程内存续期内目录有效（断言后随进程回收）
        path
    }

    #[test]
    fn missing_file_defaults_to_enabled_without_geometry() {
        let path = tmp_file("missing.json");
        let st = read_from(&path);
        assert!(st.remember_size);
        assert!(!st.maximized);
        assert_eq!(st.width, None);
    }

    #[test]
    fn round_trip_preserves_geometry_and_flag() {
        let path = tmp_file("state.json");
        let st = WindowState {
            remember_size: true,
            maximized: false,
            x: Some(11.0),
            y: Some(22.0),
            width: Some(1280.0),
            height: Some(832.0),
        };
        write_to(&path, &st).expect("write");
        let back = read_from(&path);
        assert_eq!(back, st);
    }

    #[test]
    fn set_remember_false_keeps_geometry_for_reenable() {
        let path = tmp_file("toggle.json");
        let st = WindowState {
            remember_size: true,
            maximized: true,
            ..Default::default()
        };
        write_to(&path, &st).expect("write");
        let mut off = read_from(&path);
        off.remember_size = false;
        write_to(&path, &off).expect("write");
        let back = read_from(&path);
        assert!(!back.remember_size);
        assert!(back.maximized, "关开关不丢已记忆的几何");
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let path = tmp_file("corrupt.json");
        std::fs::write(&path, "{ not json").expect("write");
        let st = read_from(&path);
        assert!(st.remember_size);
        assert_eq!(st.width, None);
    }
}
