// 主窗毛玻璃/透明效果（theme-suite T3）：
//   * macOS：window-vibrancy apply_vibrancy（NSVisualEffectView，HudWindow 材质）
//   * Windows：window-vibrancy apply_acrylic（深紫调染色面）
//   * Linux/其他：无系统模糊面（WebKitGTK）→ 跳过；CSS 侧
//     [data-theme="glass"][data-platform="linux"] 把 bg alpha 提到 ≈0.94 兜底。
//
// 效果**常开**（裁定）：非 Glass 主题画满不透明背景，效果不可见——不做按主题
// 开关窗口效果，主题层只决定 CSS 可见性（窗口透明在 tauri.conf.json 静态开）。
//
// 选型（T3 报告）：window-vibrancy 0.8 = tauri 2.12 的既有传递依赖（本文件只把
// 它升格为直接依赖，锁文件零新增 crate，供应链面最小）。注意：计划文案中的
// `apply_under_window_blending` 在 0.5.0 起已从该 crate 移除，实际可用 API 即
// apply_vibrancy / apply_acrylic（以 crate 实际文档为准调整）。
//
// 可测面：平台分支函数化（platform_effect 纯函数 + 单测钉死 cfg 对应）；
// apply_window_vibrancy 的视觉效果本身无法单测，留验收真窗走查。

/// 平台效果支（编译期 cfg 定型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VibrancyEffect {
    /// macOS NSVisualEffectView（apply_vibrancy）
    Vibrancy,
    /// Windows acrylic（apply_acrylic）
    Acrylic,
    /// 无系统模糊面（Linux 等）——CSS 兜底
    None,
}

impl VibrancyEffect {
    /// 日志/诊断名（setup 期 eprintln 用）。
    pub fn label(self) -> &'static str {
        match self {
            VibrancyEffect::Vibrancy => "vibrancy",
            VibrancyEffect::Acrylic => "acrylic",
            VibrancyEffect::None => "none",
        }
    }
}

/// 当前编译目标的效果支（纯函数；cfg! 编译期常量，分支在所有目标上同型编译）。
pub fn platform_effect() -> VibrancyEffect {
    if cfg!(target_os = "macos") {
        VibrancyEffect::Vibrancy
    } else if cfg!(target_os = "windows") {
        VibrancyEffect::Acrylic
    } else {
        VibrancyEffect::None
    }
}

/// Windows acrylic 染色（RGBA 元组，window-vibrancy::Color）：深紫调近 Glass
/// bg 合成色 #131022，alpha 0.6 常开——Glass 主题下面板半透明叠出毛玻璃，
/// 非 Glass 主题画满不透明背景盖住它（效果常开、CSS 决定可见性）。
#[cfg(target_os = "windows")]
pub fn acrylic_tint() -> window_vibrancy::Color {
    (18, 13, 32, 153)
}

/// 对主窗施加平台毛玻璃效果（theme-suite T3）。失败只报错不 panic——毛玻璃
/// 属增强面，效果缺失（老系统/compositor 不支持）时 Glass 仍有 alpha 兜底可读。
pub fn apply_window_vibrancy(win: &tauri::WebviewWindow) -> Result<VibrancyEffect, String> {
    let effect = platform_effect();
    let result = match effect {
        VibrancyEffect::Vibrancy => window_vibrancy::apply_vibrancy(
            win,
            window_vibrancy::NSVisualEffectMaterial::HudWindow,
            Some(window_vibrancy::NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
        .map_err(|e| format!("apply_vibrancy failed: {e}")),
        VibrancyEffect::Acrylic => {
            #[cfg(target_os = "windows")]
            {
                window_vibrancy::apply_acrylic(win, Some(acrylic_tint()))
                    .map_err(|e| format!("apply_acrylic failed: {e}"))
            }
            #[cfg(not(target_os = "windows"))]
            {
                // 不可达（platform_effect 已按 cfg 分派）；类型对齐用
                Err("acrylic unsupported on this target".to_string())
            }
        }
        VibrancyEffect::None => Ok(()), // Linux：无系统模糊面，跳过（CSS 兜底）
    };
    result.map(|()| effect)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 平台分支与编译目标一一对应（cfg(target_os) 函数化的纯函数面）。
    #[test]
    fn platform_effect_matches_compile_target() {
        let effect = platform_effect();
        #[cfg(target_os = "macos")]
        assert_eq!(effect, VibrancyEffect::Vibrancy);
        #[cfg(target_os = "windows")]
        assert_eq!(effect, VibrancyEffect::Acrylic);
        #[cfg(target_os = "linux")]
        assert_eq!(effect, VibrancyEffect::None);
        let _ = effect; // 其余目标（iOS/Android）不设断言，仅要求可求值
    }

    /// 效果支枚举的日志/诊断名稳定（eprintln 面，防手滑改坏可读性）。
    #[test]
    fn effect_label_is_stable() {
        assert_eq!(VibrancyEffect::Vibrancy.label(), "vibrancy");
        assert_eq!(VibrancyEffect::Acrylic.label(), "acrylic");
        assert_eq!(VibrancyEffect::None.label(), "none");
    }
}
