//! 视图命令域（2026-10-12 跨平台审计）：webview 缩放的键盘/面板入口。
//!
//! 缩放此前只有 macOS 视图菜单（⌘=/⌘-/⌘0，menu.rs Dispatch::Zoom*）一个
//! 触达口——Win/Linux 既无原生菜单也无等价键位，功能整体不可达。本命令把
//! 同一 `apply_zoom`（menu.rs，ZoomState 单一状态源 + clamp [0.5,3]）暴露给
//! 前端：Win/Linux Ctrl+=/Ctrl+-/Ctrl+0 与三端 ⌘K 面板经此进来，与 mac 菜单
//! 路径共享同一份当前倍率，不会分叉。

use tauri::AppHandle;

/// 缩放：`in` 放大一档（×1.1）/ `out` 缩小一档（÷1.1）/ `reset` 实际大小。
#[tauri::command]
pub(crate) fn view_zoom(app: AppHandle, op: String) -> Result<(), String> {
    match op.as_str() {
        "in" => crate::menu::apply_zoom(&app, Some(crate::menu::ZOOM_STEP)),
        "out" => crate::menu::apply_zoom(&app, Some(1.0 / crate::menu::ZOOM_STEP)),
        "reset" => crate::menu::apply_zoom(&app, None),
        other => return Err(format!("unknown zoom op: {other}")),
    }
    Ok(())
}
