// 对话框滚动语义守卫（BL-526 / T5 披露清偿，product-ready T6）：
// 模态对话框（SyncDialog pull 面 / 锁定屏卡片等）内容高于视口时必须可滚、
// 底部按钮可达。App.css 是唯一样式源——沿 tokens.test 的 grep 模式做存在性
// 守卫（数字即规约）：
//   1. .dialog 共享规则 = max-height + overflow-y:auto（86vh 上限 + 内滚，
//      P1 起既有语义，防回归移除）；
//   2. .overlay 兜底滚动（对话框万一超出视口时 overlay 自滚，防困死）；
//   3. .dialog 滚动条可见化（::-webkit-scrollbar 常显细滚动条——macOS overlay
//      滚动条静止不可见，600px 矮窗下「内容被裁」无任何可滚提示，T5 走查
//      03 号截图的缺陷本体）；
//   4. SyncDialog / LockScreen 容器必须挂 .dialog 类（挂上才承接 1-3 的语义，
//      防类名漂移静默掉守卫）。
import { describe, expect, it } from "vitest";
import { allAppCss } from "./styles/all-css";
import syncDialogTsx from "./sync/SyncDialog.tsx?raw";
import lockScreenTsx from "./security/LockScreen.tsx?raw";

/** 抽出选择器块（`.selector { ... }`）——花括号配平取整块。 */
function ruleOf(css: string, selectorPrefix: string): string | null {
  const idx = css.indexOf(selectorPrefix);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(idx, i + 1);
    }
  }
  return null;
}

describe("对话框滚动语义守卫（BL-526 + T5 披露）", () => {
  it(".dialog 共享规则带 max-height 上限 + overflow-y:auto（既有语义防回归）", () => {
    const rule = ruleOf(allAppCss(), ".dialog,");
    expect(rule).not.toBeNull();
    expect(rule).toContain("max-height:");
    expect(rule).toContain("overflow-y: auto");
  });

  it(".overlay 兜底 overflow-y:auto（内容超出视口时 overlay 自滚，不困死）", () => {
    const rule = ruleOf(allAppCss(), ".overlay {");
    expect(rule).not.toBeNull();
    expect(rule).toContain("overflow-y: auto");
  });

  it(".overlay 滚动条视觉隐藏（兜底面不得与 .dialog 内滚条并排成双条——2026-10-05 用户反馈；滚轮滚动能力保留）", () => {
    const rule = ruleOf(allAppCss(), ".overlay {");
    expect(rule).toContain("scrollbar-width: none");
    const webkitRule = ruleOf(allAppCss(), ".overlay::-webkit-scrollbar");
    expect(webkitRule).not.toBeNull();
    expect(webkitRule).toContain("display: none");
  });

  it(".dialog 滚动条可见化（::-webkit-scrollbar 常显——macOS 静止期 overlay 滚动条不可见即「被裁」假象）", () => {
    expect(allAppCss()).toMatch(/\.dialog::-webkit-scrollbar[^{]*\{/);
    expect(allAppCss()).toMatch(/\.dialog::-webkit-scrollbar-thumb[^{]*\{/);
  });

  it("滚动条 thumb 走语义令牌 --border-subtle（终审备注：防裸色值回潜——thumb 在亮/暗主题都必须可辨且随主题联动）", () => {
    const rule = ruleOf(allAppCss(), ".dialog::-webkit-scrollbar-thumb");
    expect(rule).not.toBeNull();
    expect(rule).toContain("background: var(--border-subtle)");
    // thumb 块内禁十六进制字面量（语义令牌纪律，沿 tokens.test 消费点口径）
    expect(rule).toMatch(/background:\s*var\(--/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("嵌套滚动容器同享 6px 规格 + 设置分区面板右内边距（2026-10-14 用户反馈：原生宽滚动条盖住设置页内容右缘）", () => {
    const css = allAppCss();
    const barRule = ruleOf(css, ".dialog::-webkit-scrollbar,");
    expect(barRule).toContain(".settings-panes::-webkit-scrollbar");
    // 2026-10-17：工具弹框体退役，宽幅视图壳 .workspace-view 接棒滚动规格
    expect(barRule).toContain(".workspace-view::-webkit-scrollbar");
    const thumbRule = ruleOf(css, ".dialog::-webkit-scrollbar-thumb,");
    expect(thumbRule).toContain(".settings-panes::-webkit-scrollbar-thumb");
    expect(thumbRule).toContain(".workspace-view::-webkit-scrollbar-thumb");
    const panes = ruleOf(css, ".settings-panes {");
    expect(panes).toContain("overflow-y: auto");
    expect(panes).toContain("padding-right: var(--space-4)");
  });

  it("SyncDialog / LockScreen 容器挂 .dialog 类（承接滚动语义，防类名漂移）", () => {
    // 2026-10-23：SyncDialog 脱离 settings-dialog 620px 大框，挂 .dialog.sync-dialog
    expect(syncDialogTsx).toContain("dialog sync-dialog");
    expect(lockScreenTsx).toContain('"dialog lock-card"');
  });
});
