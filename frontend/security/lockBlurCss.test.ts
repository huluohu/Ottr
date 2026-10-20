// 锁屏背景虚化 CSS 契约守卫（2026-10-19 用户三次反馈「锁屏时背景应虚化」）。
//
// 隐私要求：锁屏遮罩之后的应用内容不可读。双保险实现（16-lock-security.css）：
//   1. .lock-screen 遮罩本体 backdrop-filter（毛玻璃；-webkit- 前缀覆盖
//      WKWebView）；
//   2. .app-body[data-locked="true"] 内容层 filter blur（兄弟层，不破坏遮罩
//      fixed 定位；backdrop-filter 不支持的平台也保底）。
// 本守卫钉死两条规则不回退（grep 式文本扫描，沿 term-veil-css 先例）；虚化的
// 视觉几何（半径观感/过渡曲线）靠真窗截图与真机验收兜底。
import { describe, expect, it } from "vitest";
import { allAppCss } from "../styles/all-css";

const css = allAppCss();

describe("锁屏背景虚化 CSS 契约（隐私防窥守卫）", () => {
  it("遮罩本体带毛玻璃 backdrop-filter（含 -webkit- 前缀面）", () => {
    const idx = css.indexOf(".lock-screen {\n  background: color-mix");
    expect(idx).toBeGreaterThanOrEqual(0);
    const rule = css.slice(idx, idx + 420);
    expect(rule).toContain("backdrop-filter: blur(");
    expect(rule).toContain("-webkit-backdrop-filter: blur(");
    // 毛玻璃口径：高模糊 + 提饱和（不是单纯变暗）
    expect(rule).toContain("saturate(");
  });

  it("霜面存在（深色下纯模糊=黑玻璃，需白色薄雾才读得出磨砂）", () => {
    const idx = css.indexOf(".lock-screen::before");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(css.slice(idx, idx + 300)).toContain("linear-gradient(");
    expect(css.slice(idx, idx + 300)).toContain("color-mix(");
  });

  it("卡片是第二层玻璃；内容层仅兜底时重糊", () => {
    // 卡片：半透明 + 自身 backdrop blur
    const cardIdx = css.indexOf(".lock-screen .lock-card {");
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(css.slice(cardIdx, cardIdx + 420)).toContain("backdrop-filter: blur(");
    expect(css.slice(cardIdx, cardIdx + 420)).toContain("color-mix(");
    // 内容层：默认只禁指针；重糊放在 @supports not(backdrop-filter) 兜底里
    const bodyIdx = css.indexOf('.app-body[data-locked="true"]');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(css.slice(bodyIdx, bodyIdx + 200)).toContain("pointer-events: none");
    const supportsIdx = css.indexOf("@supports not ((backdrop-filter");
    expect(supportsIdx).toBeGreaterThanOrEqual(0);
    expect(css.slice(supportsIdx, supportsIdx + 300)).toContain("filter: blur(");
  });
});
