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

// ---------------------------------------------------------------------------
// Win11 贴靠（2026-10-13 用户目标「Snap Layouts 补课」）：自绘标题栏的
// 最大化按钮 hover 弹布局选择器（TitleBar），每个分区对应一个贴靠矩形。
// 定位基准 = 窗口所在显示器的 work_area（扣任务栏；tauri Monitor::work_area
// 跨平台一致）。矩形计算抽成纯函数 snap_rect 单测直驱。
// ---------------------------------------------------------------------------

use tauri::{Manager, PhysicalRect};

/// 贴靠布局：left/right = 竖排半屏；top/bottom = 横排半屏；tl/tr/bl/br = 四宫格。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapLayout {
    Left,
    Right,
    Top,
    Bottom,
    Tl,
    Tr,
    Bl,
    Br,
}

impl SnapLayout {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "left" => Self::Left,
            "right" => Self::Right,
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            "tl" => Self::Tl,
            "tr" => Self::Tr,
            "bl" => Self::Bl,
            "br" => Self::Br,
            _ => return None,
        })
    }
}

/// work_area（物理 px）+ 布局 → 目标矩形（同物理 px 坐标系）。半分宽高取
/// 整除——奇数像素的余 1 归右/下侧（与 Windows 贴靠的取整方向一致）。
pub fn snap_rect(work: &PhysicalRect<i32, u32>, layout: SnapLayout) -> PhysicalRect<i32, u32> {
    use SnapLayout::*;
    let (x, y) = (work.position.x, work.position.y);
    let (w, h) = (work.size.width, work.size.height);
    let half_w = w / 2;
    let half_h = h / 2;
    let (x, y, w, h) = match layout {
        Left => (x, y, half_w, h),
        Right => (x + half_w as i32, y, w - half_w, h),
        Top => (x, y, w, half_h),
        Bottom => (x, y + half_h as i32, w, h - half_h),
        Tl => (x, y, half_w, half_h),
        Tr => (x + half_w as i32, y, w - half_w, half_h),
        Bl => (x, y + half_h as i32, half_w, h - half_h),
        Br => (x + half_w as i32, y + half_h as i32, w - half_w, h - half_h),
    };
    PhysicalRect {
        position: tauri::PhysicalPosition::new(x, y),
        size: tauri::PhysicalSize::new(w, h),
    }
}

/// 贴靠主窗到当前显示器 work_area 的指定分区；已最大化先还原（最大化态
/// set_position 会被还原几何吞掉）。
#[tauri::command]
pub fn window_snap(app: tauri::AppHandle, layout: String) -> Result<(), String> {
    let layout =
        SnapLayout::parse(&layout).ok_or_else(|| format!("unknown snap layout: {layout}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // 窗口中心落在哪块显示器 → 该显示器的 work_area（跨屏拖过的场景对）
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .into_iter()
        .find(|m| {
            let mp = m.position();
            let ms = m.size();
            cx >= mp.x && cx < mp.x + ms.width as i32 && cy >= mp.y && cy < mp.y + ms.height as i32
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "no monitor for window".to_string())?;

    let rect = snap_rect(monitor.work_area(), layout);

    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
    }
    window
        .set_position(tauri::PhysicalPosition::new(
            rect.position.x,
            rect.position.y,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(rect.size.width, rect.size.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::PhysicalRect;

    /// 1920×1080 work_area at (0,0)（主屏典型）。
    fn work() -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(1920, 1080),
        }
    }

    fn rect_of(r: &PhysicalRect<i32, u32>) -> (i32, i32, u32, u32) {
        (r.position.x, r.position.y, r.size.width, r.size.height)
    }

    #[test]
    fn halves_cover_work_area_exactly() {
        let w = work();
        let l = snap_rect(&w, SnapLayout::Left);
        let r = snap_rect(&w, SnapLayout::Right);
        assert_eq!(rect_of(&l), (0, 0, 960, 1080));
        assert_eq!(rect_of(&r), (960, 0, 960, 1080));
        // 两半拼回整面（奇数宽余 1 归右侧，拼接无缝）
        assert_eq!(l.size.width + r.size.width, w.size.width);
        let t = snap_rect(&w, SnapLayout::Top);
        let b = snap_rect(&w, SnapLayout::Bottom);
        assert_eq!(rect_of(&t), (0, 0, 1920, 540));
        assert_eq!(rect_of(&b), (0, 540, 1920, 540));
    }

    #[test]
    fn quarters_split_and_tiling_is_lossless() {
        let w = work();
        let tl = snap_rect(&w, SnapLayout::Tl);
        let tr = snap_rect(&w, SnapLayout::Tr);
        let bl = snap_rect(&w, SnapLayout::Bl);
        let br = snap_rect(&w, SnapLayout::Br);
        assert_eq!(rect_of(&tl), (0, 0, 960, 540));
        assert_eq!(rect_of(&tr), (960, 0, 960, 540));
        assert_eq!(rect_of(&bl), (0, 540, 960, 540));
        assert_eq!(rect_of(&br), (960, 540, 960, 540));
        assert_eq!(tl.size.width + tr.size.width, w.size.width);
        assert_eq!(tl.size.height + bl.size.height, w.size.height);
    }

    #[test]
    fn work_area_offset_is_respected_secondary_monitor() {
        // 副屏在 (1920, 0)：贴靠矩形整体平移
        let w = PhysicalRect {
            position: tauri::PhysicalPosition::new(1920, 0),
            size: tauri::PhysicalSize::new(1280, 800),
        };
        assert_eq!(
            rect_of(&snap_rect(&w, SnapLayout::Left)),
            (1920, 0, 640, 800)
        );
        assert_eq!(
            rect_of(&snap_rect(&w, SnapLayout::Br)),
            (2560, 400, 640, 400)
        );
    }

    #[test]
    fn parse_known_and_unknown() {
        assert_eq!(SnapLayout::parse("left"), Some(SnapLayout::Left));
        assert_eq!(SnapLayout::parse("br"), Some(SnapLayout::Br));
        assert_eq!(SnapLayout::parse("nope"), None);
    }
}
