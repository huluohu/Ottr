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
  it("遮罩本体带 backdrop-filter（含 -webkit- 前缀面）", () => {
    const rule = css.slice(css.indexOf(".lock-screen {\n  backdrop-filter"));
    expect(rule.length).toBeGreaterThan(0);
    expect(rule.slice(0, 300)).toContain("backdrop-filter: blur(");
    expect(rule.slice(0, 300)).toContain("-webkit-backdrop-filter: blur(");
  });

  it("内容层 data-locked 虚化 + 指针禁用（backdrop 失效保底）", () => {
    expect(css).toContain('.app-body[data-locked="true"]');
    const rule = css.slice(css.indexOf('.app-body[data-locked="true"]'));
    expect(rule.slice(0, 200)).toContain("filter: blur(");
    expect(rule.slice(0, 300)).toContain("pointer-events: none");
    // 解锁回程：filter 过渡在 .app-body 基类上（模糊随属性撤销消退）
    expect(css).toContain(".app-body {\n  transition: filter ");
  });
});
