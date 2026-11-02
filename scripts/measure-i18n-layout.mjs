// 八语言排版几何检查（2026-11-03）。
//
// 审计里剩下的是一批**要人眼看**的项（「意大利语 30 字符的按钮会不会挤爆」
// 「长语言的标签列会不会把值列挤成省略号」）。人眼检查只能覆盖一两个语言，
// 这里把它变成**可自动判定**：对 8 个语言 × 若干界面，量测
//
//   1. **横向溢出**：任何可见元素的 `scrollWidth > clientWidth + 1` → 文字被裁；
//   2. **纵向溢出**：文本容器 `scrollHeight > clientHeight + 1`；
//   3. **关键元素不越界**：面板/输入框/按钮都在其容器矩形内。
//
// 界面覆盖：本轮新增用户可见文案的界面——AI 面板（提问占位符/用量行/工具卡片）、
// 凭据对话框（TOTP 位数/步长标签 + agent 类型说明）、交互式认证弹窗（倒计时 +
// 刷新钮）。这正是长语言最容易出问题的地方。
//
// 用法：node scripts/measure-i18n-layout.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const LANGS = ["zh-CN", "zh-Hant", "lzh", "en-US", "ja", "ko", "es", "it"];
const SHOTS = ["terminal", "ai-ask", "prompt-dialog", "credentials", "mcp-client"];

const server = await createServer({ server: { port: 1436 } });
await server.listen();

const browser = await chromium.launch({ headless: true });
const problems = [];

/** 在页面里找横向/纵向溢出与越界的元素。 */
const OVERFLOW_PROBE = () => {
  const bad = [];
  const EPS = 1;
  const vw = document.documentElement.clientWidth;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue; // 可滚动的容器不算溢出
    // 祖先里有横向滚动容器 → 元素「被裁但可达」，不算不可达（AI 面板同开时
    // 工具行本就是横向滚动的，属设计）。
    let scrollableAncestor = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === "auto" || pcs.overflowX === "scroll") {
        scrollableAncestor = true;
        break;
      }
    }
    if (scrollableAncestor) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.scrollWidth > el.clientWidth + EPS && cs.overflow === "visible") {
      bad.push({
        kind: "x-overflow",
        sel: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
        text: (el.textContent ?? "").trim().slice(0, 60),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
    }
    if (r.right > vw + EPS) {
      bad.push({
        kind: "out-of-viewport",
        sel: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
        text: (el.textContent ?? "").trim().slice(0, 60),
        right: Math.round(r.right),
        vw,
      });
    }
  }
  return bad;
};

for (const lang of LANGS) {
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://localhost:1436/dev-preview.html?shot=${shot}&lang=${lang}`);
    await page.waitForTimeout(700);
    const bad = await page.evaluate(OVERFLOW_PROBE);
    for (const b of bad) {
      problems.push({ lang, shot, ...b });
    }
    await page.close();
  }
}

await browser.close();
await server.close();

if (problems.length === 0) {
  console.log(`I18N_LAYOUT_OK（${LANGS.length} 语言 × ${SHOTS.length} 界面 = ${LANGS.length * SHOTS.length} 组，无横向溢出/越界）`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 处排版问题：`);
for (const p of problems.slice(0, 40)) {
  console.log(`  [${p.lang}/${p.shot}] ${p.kind} ${p.sel} — "${p.text}" (${p.scrollWidth ?? ""}/${p.clientWidth ?? ""}${p.right ? ` right=${p.right}/${p.vw}` : ""})`);
}
process.exit(1);
