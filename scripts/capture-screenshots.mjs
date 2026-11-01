#!/usr/bin/env node
// README 配图批量拍摄（2026-11-01 用户需求「每一种语言的 readme 里的截图，都要
// 切换到对应语言后截图」）：README 有六种语言，配图此前六份共用同一批简中界面
// 截图。本脚本按语言 × 画面批量出图，落到 docs/screenshots/<locale>/<shot>.png。
//
// 画面状态由 frontend/dev/preview-main.tsx 的 ?shot=<name>&lang=<locale> 模式
// 种子（真实组件 + 真实样式，不是画出来的假图）；本脚本只负责开无头浏览器、
// 等就绪信号、截图。
//
// 用法：
//   npm run dev                 # 另开一个终端：vite dev server（端口 1420）
//   node scripts/capture-screenshots.mjs
//   node scripts/capture-screenshots.mjs --locale ja --shot terminal
//
// 依赖：playwright（chromium）。未装时用 PLAYWRIGHT_PATH 指向一份 playwright
// 的 node_modules 目录，或 npm i -D playwright 后直接跑。
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** 六种 README 语言 → 界面语言 id（App 界面语言与 README 语言一一对应）。 */
const LOCALES = ["en-US", "zh-CN", "ja", "ko", "es", "it"];
/** 六张 README 配图（画面名 → 输出文件名）。 */
const SHOTS = [
  ["home", "home-welcome"],
  ["terminal", "main-dark"],
  ["palette", "palette"],
  ["cron", "cron"],
  ["overview", "overview"],
  ["credentials", "credentials"],
];
const BASE_URL = process.env.OTTR_SHOT_URL ?? "http://localhost:1420";
const OUT_DIR = path.resolve(process.cwd(), "docs/screenshots");
const VIEWPORT = { width: 1280, height: 896 };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** playwright 解析顺序：仓库依赖 → PLAYWRIGHT_PATH → npx 缓存里的最近一份。 */
function resolvePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  candidates.push(path.resolve(process.cwd(), "node_modules/playwright"));
  const npxCache = path.join(process.env.HOME ?? "", ".npm/_npx");
  if (existsSync(npxCache)) {
    for (const dir of require("node:fs").readdirSync(npxCache)) {
      candidates.push(path.join(npxCache, dir, "node_modules/playwright"));
    }
  }
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    "playwright 未找到：请 npm i -D playwright，或用 PLAYWRIGHT_PATH=<playwright 的 node_modules 目录> 指定。",
  );
}

async function main() {
  const onlyLocale = arg("locale");
  const onlyShot = arg("shot");
  const locales = onlyLocale ? [onlyLocale] : LOCALES;
  const shots = onlyShot ? SHOTS.filter(([s]) => s === onlyShot) : SHOTS;
  if (shots.length === 0) throw new Error(`未知画面：${onlyShot}`);

  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch();
  const errors = [];

  for (const locale of locales) {
    const dir = path.join(OUT_DIR, locale);
    await mkdir(dir, { recursive: true });
    // 每种语言一个 context：locale 决定 Intl/日期格式（界面对齐该语言）。
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale,
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`[${locale}] ${String(e.message)}`));
    for (const [shot, file] of shots) {
      const url = `${BASE_URL}/dev-preview.html?shot=${shot}&lang=${encodeURIComponent(locale)}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__shotReady__ === true, null, { timeout: 20000 });
      // 字体/布局落定后再拍（终端回显是逐帧写的，等一拍）
      await page.waitForTimeout(700);
      const out = path.join(dir, `${file}.png`);
      await page.screenshot({ path: out });
      const kb = Math.round((await import("node:fs")).statSync(out).size / 1024);
      process.stdout.write(`${locale}/${file}.png (${kb} KB)\n`);
    }
    await context.close();
  }

  await browser.close();
  if (errors.length) {
    await writeFile(path.join(OUT_DIR, ".shot-errors.log"), errors.join("\n"));
    process.stderr.write(`页面报错 ${errors.length} 条 → docs/screenshots/.shot-errors.log\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
