// AI 诊断面板布局量测（2026-11-02 用户反馈「顶部被遮盖」）。
//
// 布局类修复**不允许只靠截图目检**（remote-device-testing 纪律）：注入
// getBoundingClientRect 量测脚本，断言关键几何关系：
//   1. 面板顶边 ≤ 主区顶边（面板整高，标题不被上方工具行压住）；
//   2. 面板顶边 < 工具行底边 - 容差（面板顶在工具行**之上**，不是之下）；
//   3. 面板底边 = 主区底边（整高到窗口底部）；
//   4. 面板左边界 ≥ 工具行右边界（工具行不横跨面板列）。
//
// 用法：node scripts/measure-ai-panel.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const server = await createServer({ server: { port: 1430 } });
await server.listen();

const browser = await chromium.launch({ headless: true });

async function measure(mode, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`http://localhost:1430/dev-preview.html?shot=${mode}`);
  await page.waitForSelector('[data-testid="main-area"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  const geo = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        width: b.width,
        height: b.height,
      };
    };
    return {
      panel: r('[data-testid="ai-panel"]'),
      mainArea: r('[data-testid="main-area"]'),
      body: r(".main-area-body"),
      termRow: r(".term-main-row"),
      holder: r('[data-testid="term-holder"]'),
      toolbarRow: r(".term-toolbar-row"),
      badge: r('[data-testid="ai-exit-code"]'),
      panelHead: r(".ai-panel-head"),
    };
  });
  await page.close();
  return geo;
}

const withPanel = await measure("ai-panel", { width: 1440, height: 860 });
const withoutPanel = await measure("terminal", { width: 1440, height: 860 });
const narrow = await measure("ai-panel", { width: 1024, height: 860 });

await browser.close();
await server.close();

console.log("with-panel:", JSON.stringify(withPanel, null, 2));

const EPS = 1.5;
const checks = [
  // --- 有面板：面板整高右栏，标题与徽章不被工具行压住 ---
  ["面板整高：面板顶 == 主区顶", Math.abs(withPanel.panel.top - withPanel.mainArea.top) <= EPS],
  [
    "面板在工具行之上：面板顶 < 工具行底",
    withPanel.panel.top < withPanel.toolbarRow.bottom - EPS,
  ],
  [
    "面板整高：面板底 == 主区底",
    Math.abs(withPanel.panel.bottom - withPanel.mainArea.bottom) <= EPS,
  ],
  [
    "工具行不横跨面板列：工具行右 <= 面板左",
    withPanel.toolbarRow.right <= withPanel.panel.left + EPS,
  ],
  [
    "标题在面板内（未被裁切）：面板头顶 >= 面板顶",
    withPanel.panelHead.top >= withPanel.panel.top - EPS,
  ],
  [
    "退出码徽章在面板内：徽章顶 >= 面板顶",
    withPanel.badge.top >= withPanel.panel.top - EPS,
  ],
  // --- 无面板：左列不得塌陷（内容区必须占满主区高度）---
  [
    "无面板：内容区未塌陷（term-main-row 高度 ≈ 主区高度）",
    withoutPanel.termRow.height > withoutPanel.mainArea.height * 0.8,
  ],
  [
    "无面板：左列铺满主区宽",
    Math.abs(withoutPanel.body.right - withoutPanel.mainArea.right) <= EPS,
  ],
  // --- 窄窗：面板仍整高且不越界 ---
  [
    "窄窗(1024)：面板整高不塌",
    Math.abs(narrow.panel.bottom - narrow.mainArea.bottom) <= EPS,
  ],
  [
    "窄窗(1024)：工具行不越面板列",
    narrow.toolbarRow.right <= narrow.panel.left + EPS,
  ],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? "PANEL_LAYOUT_OK" : "PANEL_LAYOUT_FAIL");
process.exit(ok ? 0 : 1);
