// 设置页「软件更新」按钮几何检查（2026-11-03）。
//
// 用户实锤「按钮都变形了」：更新检查失败时，reqwest 的原始报错是一整句
// 带 URL 的长串，在 flex 行里把「检查更新」按钮压到文字宽度不足 → 按钮
// 文字竖排成两行（截图里「检查 / 更新」两行）。
//
// 这里把它变成**可自动判定**的：对 8 个语言 × 错误态渲染，量测
//   1. 「检查更新」按钮的文字**行数**（用 Range 量文本矩形数）= 1；
//   2. 按钮不溢出自身（scrollHeight ≈ clientHeight）；
//   3. 错误文案不横向溢出所在行（长 URL 处断行，不外溢）；
//   4. 行内所有元素都在行容器矩形内（不越界）。
//
// 用法：node scripts/measure-update-button.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const LANGS = ["zh-CN", "zh-Hant", "lzh", "en-US", "ja", "ko", "es", "it"];

const server = await createServer({ server: { port: 1437 } });
await server.listen();

const browser = await chromium.launch({ headless: true });
const problems = [];

/** 量按钮文字行数（Range 的矩形数 = 渲染行数）+ 溢出情况。 */
const PROBE = () => {
  const out = { problems: [] };
  const btn = document.querySelector('[data-testid="update-check-button"]');
  if (!btn) {
    out.problems.push({ kind: "missing-button" });
    return out;
  }
  // 文字行数：Range 包住按钮全部内容，取 client rects 数量
  const range = document.createRange();
  range.selectNodeContents(btn);
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0 && r.width > 0);
  const lines = new Set(rects.map((r) => Math.round(r.top))).size;
  const br = btn.getBoundingClientRect();
  if (lines > 1) {
    out.problems.push({
      kind: "button-text-wrapped",
      lines,
      text: (btn.textContent ?? "").trim(),
      height: Math.round(br.height),
    });
  }
  if (btn.scrollHeight > btn.clientHeight + 1) {
    out.problems.push({
      kind: "button-overflow-y",
      scrollHeight: btn.scrollHeight,
      clientHeight: btn.clientHeight,
    });
  }
  // 错误文案不得横向溢出
  const err = document.querySelector('[data-testid="update-error"]');
  const row = btn.parentElement;
  const rr = row ? row.getBoundingClientRect() : null;
  if (err) {
    const er = err.getBoundingClientRect();
    if (err.scrollWidth > err.clientWidth + 1) {
      out.problems.push({
        kind: "error-text-overflow-x",
        scrollWidth: err.scrollWidth,
        clientWidth: err.clientWidth,
        text: (err.textContent ?? "").trim().slice(0, 60),
      });
    }
    // 越界判定用**行容器**右缘（不是按钮右缘——文案本就在按钮右侧）
    if (rr && er.right > rr.right + 1) {
      out.problems.push({
        kind: "error-outside-row",
        right: Math.round(er.right),
        rowRight: Math.round(rr.right),
      });
    }
  }
  // 行容器内的元素都不得越出行矩形
  if (row) {
    for (const el of row.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > rr.right + 1 || r.left < rr.left - 1) {
        out.problems.push({
          kind: "element-outside-row",
          sel: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""),
          left: Math.round(r.left),
          right: Math.round(r.right),
          rowLeft: Math.round(rr.left),
          rowRight: Math.round(rr.right),
        });
      }
    }
  }
  return out;
};

for (const lang of LANGS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:1437/dev-preview.html?shot=settings-update&lang=${lang}`);
  await page.waitForTimeout(700);
  const { problems: ps } = await page.evaluate(PROBE);
  for (const p of ps) problems.push({ lang, ...p });
  await page.close();
}

await browser.close();
await server.close();

if (problems.length === 0) {
  console.log(
    `UPDATE_BUTTON_OK（${LANGS.length} 语言：错误态下「检查更新」按钮文字单行、不溢出、错误文案不断链外溢）`,
  );
  process.exit(0);
}
console.log(`发现 ${problems.length} 处问题：`);
for (const p of problems.slice(0, 30)) {
  console.log(`  [${p.lang}] ${p.kind} ${JSON.stringify(p)}`);
}
process.exit(1);
