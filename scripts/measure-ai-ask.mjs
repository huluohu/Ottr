// Ask Ottr 面板的几何量测（2026-11-03，批次四 P0）。
//
// 布局类验收**不允许只靠截图目检**（remote-device-testing 纪律）：注入
// getBoundingClientRect 量测脚本，断言关键几何关系：
//   1. 提问态的面板照旧整高右栏（顶 == 主区顶、底 == 主区底）；
//   2. 提问输入条在面板内、不越界（贴底）；
//   3. 面板标题不��工具行压住；
//   4. 窄窗（1024）下面板仍整高、不越界。
//
// 用法：node scripts/measure-ai-ask.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const server = await createServer({ server: { port: 1431 } });
await server.listen();

const browser = await chromium.launch({ headless: true });

async function measure(viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto("http://localhost:1431/dev-preview.html?shot=ai-ask");
  await page.waitForSelector('[data-testid="ai-panel"]', { timeout: 15000 });
  await page.waitForTimeout(400);
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
      panelHead: r(".ai-panel-head"),
      followupRow: r(".ai-followup-row"),
      followupInput: r('[data-testid="ai-followup-input"]'),
      toolbarRow: r(".term-toolbar-row"),
    };
  });
  await page.close();
  return geo;
}

const wide = await measure({ width: 1440, height: 860 });
const narrow = await measure({ width: 1024, height: 860 });

await browser.close();
await server.close();

console.log("wide:", JSON.stringify(wide, null, 2));
console.log("narrow:", JSON.stringify(narrow, null, 2));

const EPS = 1.5;
const checks = [
  ["面板整高：面板顶 == 主区顶", Math.abs(wide.panel.top - wide.mainArea.top) <= EPS],
  ["面板整高：面板底 == 主区底", Math.abs(wide.panel.bottom - wide.mainArea.bottom) <= EPS],
  [
    "面板在工具行之上（标题不被压住）：面板顶 < 工具行底",
    wide.panel.top < wide.toolbarRow.bottom - EPS,
  ],
  ["标题在面板内：面板头顶 >= 面板顶", wide.panelHead.top >= wide.panel.top - EPS],
  [
    "提问输入条在面板内（贴底不越界）",
    wide.followupRow != null && wide.followupRow.bottom <= wide.panel.bottom + EPS,
  ],
  [
    "提问输入框在面板内",
    wide.followupInput != null &&
      wide.followupInput.bottom <= wide.panel.bottom + EPS &&
      wide.followupInput.top >= wide.panel.top - EPS,
  ],
  ["窄窗(1024)：面板仍整高", Math.abs(narrow.panel.bottom - narrow.mainArea.bottom) <= EPS],
  [
    "窄窗(1024)：提问输入条仍在面板内",
    narrow.followupRow != null && narrow.followupRow.bottom <= narrow.panel.bottom + EPS,
  ],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? "ASK_PANEL_LAYOUT_OK" : "ASK_PANEL_LAYOUT_FAIL");
process.exit(ok ? 0 : 1);
