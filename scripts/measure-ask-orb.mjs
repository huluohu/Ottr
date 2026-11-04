// Ask Ottr 悬浮球无头量测（2026-11-03 Ask Ottr Task 5 集成验证）。
//
// 载体：dev-preview.html?shot=ask-orb（frontend/dev/preview-main.tsx 种子：
// 已连接会话 + orbStore.enabled=true + 门就绪），真实 AskOttrOrb 组件挂
// 预览树，onAsk 落 window.__calls。量测纪律同 measure-ai-panel.mjs：布局类
// 断言只认 getBoundingClientRect / elementFromPoint 实测，不靠截图目检。
//
// 覆盖（plan Task 5「headless rendered tests」条目）：
//   A. 几何矩阵：1440x900 / 1024x768 / 720x480 × zh-CN / en-US / ja
//      —— 球在场（门全过）、44px 命中面、整球在视口内、中心命中测点
//         elementFromPoint 命中球本体（不被盖）、底部留 48px 终端输入安全垫、
//         不与 Toast 区叠（场景无 Toast → 栈不存在即过）、Tab 可聚焦且
//         :focus-visible 光圈可见、aria-label 按语言本地化。
//   B. 指针拖拽：按下→拖 60px+ →抬起：吸附最近边、落点进 localStorage
//      （ottr.askOrb.pos，仅边+分数）、拖后 click 被吞（onAsk 未调用）；
//      位移 <6px：视为点击（onAsk 调用一次）。
//   C. reduced-motion（emulateMedia reduce）：球仍在场、仍可点击。
//   D. 隐藏门 smoke：弹窗槽占用 → 球从无障碍树消失（卸载）；清槽 → 回归。
//
// 用法：node scripts/measure-ask-orb.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const server = await createServer({ server: { port: 1431 } });
await server.listen();

const browser = await chromium.launch({ headless: true });

/** 断言结果收集：{组名, 检查名, pass, 证据值}。 */
const results = [];
function record(group, name, pass, evidence) {
  results.push({ group, name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"} [${group}] ${name} :: ${evidence}`);
}

/** 球在场时的几何/语义快照。 */
async function orbSnapshot(page) {
  return page.evaluate(() => {
    const orb = document.querySelector('[data-testid="ask-ottr-orb"]');
    if (!orb) return { present: false };
    const b = orb.getBoundingClientRect();
    const shell = document.querySelector(".app-shell")?.getBoundingClientRect() ?? null;
    const toast = document.querySelector('[data-testid="toast-stack"]');
    const tb = toast?.getBoundingClientRect() ?? null;
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const cs = getComputedStyle(orb);
    const overlaps = (r1, r2) =>
      r1 != null && r2 != null &&
      r1.left < r2.right && r2.left < r1.right &&
      r1.top < r2.bottom && r2.top < r1.bottom;
    return {
      present: true,
      rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      shell: shell ? { left: shell.left, top: shell.top, right: shell.right, bottom: shell.bottom } : null,
      hitTag: hit ? (hit === orb ? "orb-self" : orb.contains(hit) ? "orb-descendant" : hit.tagName + "." + (hit.className ?? "")) : "null",
      toastPresent: toast != null,
      toastOverlap: overlaps(b, tb),
      ariaLabel: orb.getAttribute("aria-label"),
      tabIndex: orb.tabIndex,
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      disabled: orb.hasAttribute("disabled"),
    };
  });
}

const ORB_SIZE = 44;
const EPS = 1.0;

// ---------------------------------------------------------------------------
// A. 几何矩阵：3 视口 × 3 语言
// ---------------------------------------------------------------------------
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 720, height: 480 },
];
const LANGS = [
  { code: "zh-CN", label: "向 Ottr 提问" },
  { code: "en-US", label: "Ask Ottr" },
  { code: "ja", label: "Ottr に質問" },
];

for (const vp of VIEWPORTS) {
  for (const lang of LANGS) {
    const group = `A:${vp.width}x${vp.height}/${lang.code}`;
    const page = await browser.newPage({ viewport: vp });
    await page.goto(
      `http://localhost:1431/dev-preview.html?shot=ask-orb&lang=${lang.code}`,
    );
    let snap;
    try {
      await page.waitForSelector('[data-testid="ask-ottr-orb"]', { timeout: 15000 });
      await page.waitForTimeout(400);
      snap = await orbSnapshot(page);
    } catch (e) {
      record(group, "球在场（门全过）", false, `waitForSelector 超时: ${String(e).slice(0, 120)}`);
      await page.close();
      continue;
    }

    record(
      group, "球在场（门全过）", snap.present,
      snap.present ? `rect=${JSON.stringify(snap.rect)}` : "无 [data-testid=ask-ottr-orb]",
    );
    if (!snap.present) { await page.close(); continue; }

    const areaOk =
      Math.abs(snap.rect.width - ORB_SIZE) <= EPS && Math.abs(snap.rect.height - ORB_SIZE) <= EPS;
    record(
      group, "44px 命中面", areaOk,
      `${snap.rect.width}x${snap.rect.height}`,
    );

    const insideOk =
      snap.rect.left >= -EPS && snap.rect.top >= -EPS &&
      snap.rect.right <= snap.viewport.w + EPS && snap.rect.bottom <= snap.viewport.h + EPS;
    record(
      group, "整球在视口内", insideOk,
      `orb=[${snap.rect.left.toFixed(1)},${snap.rect.top.toFixed(1)},${snap.rect.right.toFixed(1)},${snap.rect.bottom.toFixed(1)}] viewport=${snap.viewport.w}x${snap.viewport.h}`,
    );

    const hitOk = snap.hitTag === "orb-self" || snap.hitTag === "orb-descendant";
    record(group, "中心命中测点不被遮挡", hitOk, `elementFromPoint=${snap.hitTag}`);

    // 终端输入安全垫：球底 ≤ app-shell 底 - 48（ORB_BOTTOM_RESERVE；球贴边
    // 极限时也不压终端输入行）。
    const reserveOk =
      snap.shell == null || snap.rect.bottom <= snap.shell.bottom - 48 + EPS;
    record(
      group, "底部 48px 安全垫（不压终端输入区）", reserveOk,
      snap.shell ? `orb.bottom=${snap.rect.bottom.toFixed(1)} shell.bottom=${snap.shell.bottom.toFixed(1)}` : "无 app-shell",
    );

    const toastOk = !snap.toastPresent || !snap.toastOverlap;
    record(
      group, "不与 Toast 区叠", toastOk,
      snap.toastPresent ? (snap.toastOverlap ? "相交" : "不相交") : "场景无 Toast（toast-stack 不存在；Toast 在场让位由组件门单测钉住）",
    );

    // 键盘可达 + :focus-visible 光圈可见：球是文档**最后**一个可聚焦元素
    // （App 挂载序最末），正向 Tab 在进入终端后会被 xterm 吞掉（终端语义：
    // Tab 是 shell 输入，非缺陷）——反向 Shift+Tab 从 body 环绕即一步落球。
    let focused = false;
    let steps = 0;
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Shift+Tab");
      steps = i + 1;
      const isOrb = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") === "ask-ottr-orb",
      );
      if (isOrb) { focused = true; break; }
    }
    const focusSnap = focused ? await orbSnapshot(page) : null;
    const outlineVisible =
      focused && focusSnap.outlineStyle === "solid" && parseFloat(focusSnap.outlineWidth) >= 2;
    record(
      group, "键盘可达（Shift+Tab 环绕落球）", focused,
      focused ? `${steps} 步落球 activeElement=orb` : "6 步 Shift+Tab 未达球",
    );
    record(
      group, "focus-visible 光圈可见（outline ≥2px solid）", outlineVisible,
      focused ? `outline=${focusSnap.outlineStyle}/${focusSnap.outlineWidth}` : "未聚焦",
    );
    // 键盘激活：聚焦态按 Enter 触发 onAsk（真键击 = 受信事件，有默认点击行为）。
    if (focused) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      const asks = await page.evaluate(
        () => window.__calls.filter(([c]) => c === "orb-ask").length,
      );
      record(group, "聚焦态 Enter 激活 onAsk", asks === 1, `orb-ask 调用=${asks}`);
    }

    record(
      group, "aria-label 本地化", snap.ariaLabel === lang.label,
      `aria-label="${snap.ariaLabel}" 期望="${lang.label}"`,
    );

    await page.close();
  }
}

// ---------------------------------------------------------------------------
// A2. i18n 全 8 语言：球在场 + aria-label 与 i18n 资源逐字一致（几何矩阵已由
//     A 的 3 语言覆盖；此处只补语言面）。
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ALL_LANGS = ["en-US", "zh-CN", "zh-Hant", "ja", "ko", "es", "it", "lzh"];
for (const code of ALL_LANGS) {
  const group = `A2:i18n/${code}`;
  const expected = JSON.parse(
    readFileSync(join(repoRoot, "frontend/i18n", `${code}.json`), "utf8"),
  ).ai.orbLabel;
  const page = await browser.newPage({ viewport: VIEWPORTS[0] });
  let snap = { present: false };
  try {
    await page.goto(`http://localhost:1431/dev-preview.html?shot=ask-orb&lang=${code}`);
    await page.waitForSelector('[data-testid="ask-ottr-orb"]', { timeout: 15000 });
    await page.waitForTimeout(300);
    snap = await orbSnapshot(page);
  } catch {
    snap = { present: false };
  }
  record(
    group, "球在场（i18n 资源加载不破场景）", snap.present,
    snap.present ? `rect=${snap.rect.width}x${snap.rect.height}` : "球未挂载",
  );
  record(
    group, "aria-label 与 i18n 资源逐字一致",
    snap.present && snap.ariaLabel === expected,
    `aria-label="${snap.ariaLabel}" 资源值="${expected}"`,
  );
  await page.close();
}

// ---------------------------------------------------------------------------
// B. 指针拖拽 / 点击吞咽 / 轻点
// ---------------------------------------------------------------------------
{
  const group = "B:drag@1440x900/en-US";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:1431/dev-preview.html?shot=ask-orb&lang=en-US");
  await page.waitForSelector('[data-testid="ask-ottr-orb"]', { timeout: 15000 });
  await page.waitForTimeout(400);

  const before = await orbSnapshot(page);
  const startX = before.rect.left + ORB_SIZE / 2;
  const startY = before.rect.top + ORB_SIZE / 2;

  // 拖拽：向左横跨全窗（位移 >> 6px 阈值），分步移动让 pointermove 链发生。
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 12;
  const targetX = 60; // 落点靠近左缘（startX≈1408）
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + ((targetX - startX) * i) / steps, startY, { steps: 2 });
  }
  // 拖拽中态：球应带 dragging class（实时跟手）。
  const draggingClass = await page.evaluate(
    () => document.querySelector('[data-testid="ask-ottr-orb"]')?.className ?? "",
  );
  await page.mouse.up();
  await page.waitForTimeout(150); // click 派发 + React 落库

  const after = await orbSnapshot(page);
  const stored = await page.evaluate(() => localStorage.getItem("ottr.askOrb.pos"));
  let storedPos = null;
  try { storedPos = JSON.parse(stored ?? "null"); } catch { /* 垃圾存档按 null */ }
  const askCalls = await page.evaluate(
    () => window.__calls.filter(([c]) => c === "orb-ask").length,
  );

  record(
    group, "拖拽中带 dragging 态", String(draggingClass).includes("dragging"),
    `className="${draggingClass}"`,
  );
  const snappedLeft =
    after.present && Math.abs(after.rect.left - (after.shell?.left ?? 0) - 8) <= EPS;
  record(
    group, "吸附最近边（左缘 margin=8）", snappedLeft,
    after.present ? `orb.left=${after.rect.left.toFixed(1)} shell.left=${after.shell?.left.toFixed(1)}` : "球消失",
  );
  const storedOk = storedPos != null && storedPos.edge === "left" &&
    typeof storedPos.fraction === "number" && storedPos.fraction >= 0 && storedPos.fraction <= 1;
  record(
    group, "落点持久化 localStorage（边+分数）", storedOk,
    `ottr.askOrb.pos=${stored}`,
  );
  record(
    group, "拖拽抬起吞 click（onAsk 未调用）", askCalls === 0,
    `orb-ask 调用次数=${askCalls}`,
  );

  // 轻点：位移 < 6px（阈值 6）→ 视为点击，onAsk 恰一次。
  const clickBefore = await orbSnapshot(page);
  await page.mouse.move(clickBefore.rect.left + ORB_SIZE / 2, clickBefore.rect.top + ORB_SIZE / 2);
  await page.mouse.down();
  await page.mouse.move(clickBefore.rect.left + ORB_SIZE / 2 + 3, clickBefore.rect.top + ORB_SIZE / 2, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const askCalls2 = await page.evaluate(
    () => window.__calls.filter(([c]) => c === "orb-ask").length,
  );
  record(
    group, "位移 <6px 视为点击（onAsk 恰一次）", askCalls2 === 1,
    `累计 orb-ask 调用=${askCalls2}（拖拽后基线 0）`,
  );

  await page.close();
}

// ---------------------------------------------------------------------------
// C. reduced-motion：球仍在场、仍可点击
// ---------------------------------------------------------------------------
{
  const group = "C:reduced-motion";
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("http://localhost:1431/dev-preview.html?shot=ask-orb&lang=en-US");
  await page.waitForSelector('[data-testid="ask-ottr-orb"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  const snap = await orbSnapshot(page);
  record(group, "reduce 下球仍在场", snap.present, `present=${snap.present}`);
  if (snap.present) {
    const c = await page.evaluate(() => {
      const r = document
        .querySelector('[data-testid="ask-ottr-orb"]')
        .getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(150);
    const asks = await page.evaluate(
      () => window.__calls.filter(([c]) => c === "orb-ask").length,
    );
    record(group, "reduce 下点击仍触发 onAsk", asks === 1, `orb-ask 调用=${asks}`);
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// D. 隐藏门 smoke：弹窗在场 → 球卸载（无障碍树无该按钮）
// ---------------------------------------------------------------------------
{
  const group = "D:hidden-gates";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:1431/dev-preview.html?shot=ask-orb&lang=en-US");
  await page.waitForSelector('[data-testid="ask-ottr-orb"]', { timeout: 15000 });
  record(group, "门前球在场", true, "waitForSelector 命中");

  await page.evaluate(() => window.__orbGates__.setModal("settings"));
  await page.waitForTimeout(100);
  const hidden = await page.evaluate(() => ({
    orb: document.querySelector('[data-testid="ask-ottr-orb"]'),
    anyOrbClass: document.querySelectorAll(".ask-orb").length,
    // 说明：term-toolbar 的 ask-ottr 工具钮（ai.askEntry）是同一动作的另一
    // 入口（plan Task 4 有意保留），同名 aria-label 不属于「球」。
    toolbarEntry: document.querySelectorAll('[data-testid="ask-ottr"]').length,
  }));
  record(
    group, "弹窗在场 → 球从无障碍树消失（卸载）",
    hidden.orb == null && hidden.anyOrbClass === 0,
    `orb=${hidden.orb == null ? "null" : "在"} .ask-orb 节点=${hidden.anyOrbClass}（term-toolbar ask-ottr 入口=${hidden.toolbarEntry}，非球）`,
  );

  await page.evaluate(() => window.__orbGates__.setModal(null));
  await page.waitForTimeout(100);
  const back = await page.evaluate(
    () => document.querySelector('[data-testid="ask-ottr-orb"]') != null,
  );
  record(group, "弹窗清槽 → 球回归", back, `present=${back}`);

  await page.close();
}

await browser.close();
await server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n== ORB VERIFY SUMMARY: ${results.length - failed.length}/${results.length} checks passed ==`);
if (failed.length > 0) {
  console.log("FAILED CHECKS:");
  for (const f of failed) console.log(`  [${f.group}] ${f.name} :: ${f.evidence}`);
  process.exit(1);
}
process.exit(0);
