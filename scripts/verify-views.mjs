#!/usr/bin/env node
// 全视图布局守卫（2026-11-10 用户要求「真实有效的方案」第 1 道防线）。
//
// 背景：v1.7.5 之前用户实报「切文件/进程/监控都是半屏 + 面板标题压标签栏 +
// 工具行切换钮点不动」——根因是面板被渲染在包裹容器之外，让位规则静默失效。
// 这类几何回归 jsdom 单测测不到（无布局引擎），CI 全绿、真机看走眼（v1.7.4
// 发版前的监控视图截图就是坏的，被当成了正常空态）。本脚本把「逐视图布局
// 走查」机械化：真实浏览器（Playwright 无头 chromium，dev-preview 的
// ?view=/?shot= 种子态，与 README 配图同一套基建）里逐视图断言几何关系：
//   * 视图切换钮可见且**可点**（elementFromPoint 中心命中钮自身——遮挡/推出
//     视口即红，直接钉死 z 层级与宽度这族）
//   * 终端行让位必须折叠（data-yield=true → 高度≈0）
//   * 活动面板铺满容器、不压工具行（半屏即红）
//   * 库级视图壳铺满主区
//   * 无横向溢出
//   * 设置模态盖住顶栏（z 刻度错序即红）
// 任何一条不满足 → 非零退出并列出每条失败。
//
// 用法：
//   node scripts/verify-views.mjs                # 自起 vite（1420）→ 跑完即关
//   OTTR_VIEWS_URL=http://localhost:1420 node scripts/verify-views.mjs
//   node scripts/verify-views.mjs --out verify/views   # 截图输出目录
//
// 截图落在 --out（默认 verify/views，gitignore）：作为人工复核证据留存；
// 与上一发布版的同名截图并排对比，任何肉眼可见的差异都该能被上面某条几何
// 断言解释——解释不了的就是新问题。
import { createRequire } from "node:module";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** 视图清单：kind 决定断言集。session = 会话级（工具行切换器）；library =
 *  库级宽幅视图；modal = 模态对话框。 */
const VIEWS = [
  { name: "terminal", kind: "session", url: "?view=terminal" },
  { name: "files", kind: "session", url: "?view=files" },
  { name: "processes", kind: "session", url: "?view=processes" },
  { name: "monitor", kind: "session", url: "?view=monitor" },
  { name: "plugins", kind: "session", url: "?view=plugins" },
  // AI 面板在场（右栏挤压终端列的最恶劣形态；38vw 时代切换钮被推出视口的场景）
  { name: "ai-panel", kind: "session", url: "?shot=ai-panel" },
  // AI 面板「正在回答」形态（2026-11-12 用户报障「消息显示逻辑一会上面一会
  // 下面」）：停止/思考中必须排在对话流**下方**，且对话变长时贴底可见。
  { name: "ai-panel-running", kind: "ai-live", url: "?shot=ai-panel-running" },
  { name: "overview", kind: "library", url: "?view=overview" },
  { name: "batch", kind: "library", url: "?view=batch" },
  { name: "cron", kind: "library", url: "?view=cron" },
  { name: "notifications", kind: "library", url: "?view=notifications" },
  { name: "forwards", kind: "library", url: "?view=forwards" },
  { name: "jumpchains", kind: "library", url: "?view=jumpchains" },
  // 模态遮罩必须盖住顶栏（z 刻度：--z-overlay > --z-topbar）
  { name: "settings", kind: "modal", url: "?settings=general" },
];

const BASE_URL = process.env.OTTR_VIEWS_URL ?? "";
const OUT_DIR = path.resolve(process.cwd(), arg("out") ?? "verify/views");
const VIEWPORT = { width: 1280, height: 896 };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** playwright 解析顺序（与 capture-screenshots 同款）：仓库依赖 →
 *  PLAYWRIGHT_PATH → npx 缓存里的最近一份。 */
function resolvePlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  candidates.push(path.resolve(process.cwd(), "node_modules/playwright"));
  const npxCache = path.join(process.env.HOME ?? "", ".npm/_npx");
  if (existsSync(npxCache)) {
    for (const dir of readdirSync(npxCache)) {
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

/** 自起 vite（除非外部给了 OTTR_VIEWS_URL）。返回 { url, close }。 */
async function ensureServer() {
  if (BASE_URL) return { url: BASE_URL, close: () => {} };
  const port = 1420;
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: false,
  });
  // 就绪轮询（vite 冷启动 ~1s；strictPort 冲突即失败，不静默换口）
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(url);
      if (res.ok) return { url, close: () => child.kill("SIGTERM") };
    } catch {
      /* 未就绪继续等 */
    }
  }
  child.kill("SIGTERM");
  throw new Error("vite dev server 未能启动（60×500ms 内未就绪）");
}

/** 各 kind 的几何断言（在页面里 evaluate）。返回失败清单（空 = 过）。 */
const CHECKS = {
  session: () => {
    const failures = [];
    const fmt = (r) =>
      `(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}×${Math.round(r.height)}`;
    // 1) 视图切换钮：可见 + 中心点真命中钮自身（被遮挡/推出视口即红）
    const btns = [...document.querySelectorAll('button[data-testid^="view-"]')];
    if (btns.length === 0) failures.push("工具行没有任何视图切换钮（切换器丢失）");
    for (const b of btns) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        failures.push(`切换钮 ${b.dataset.testid} 尺寸为 0`);
        continue;
      }
      if (r.right < 0 || r.left > window.innerWidth || r.bottom < 0 || r.top > window.innerHeight) {
        failures.push(`切换钮 ${b.dataset.testid} 在视口外 ${fmt(r)}`);
        continue;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === b || b.contains(hit))) {
        const desc = hit
          ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0] || "(无类)"}`
          : "null";
        failures.push(`切换钮 ${b.dataset.testid} 中心点被 ${desc} 挡住（点击落不到钮上）`);
      }
    }
    // 2) 让位折叠：data-yield=true 的终端行必须 ≈0 高（不折叠 = 面板被均分半屏）
    const row = document.querySelector('.term-main-row[data-yield="true"]');
    if (row) {
      const h = row.getBoundingClientRect().height;
      if (h > 12) failures.push(`终端行让位未折叠（高 ${Math.round(h)}px）→ 面板被均分成半屏`);
    }
    // 3) 活动面板：高度对比**整个主区**（健康 ≈90%：主区减页签行/工具行；
    //    50/50 均分的半屏态 ≈50%）。基准用主区而不是面板自己的父容器——
    //    面板被挪出包裹层时，它在旧槽位里照样「自洽」，只有对主区的占比
    //    才暴露半屏（2026-11-10 files 视图漏报的教训）。
    const mainArea = document.querySelector(".main-area");
    const toolbar = document.querySelector(".term-toolbar-row");
    const panelSel = [".file-panel", ".proc-panel", ".workspace-view"].find((s) =>
      document.querySelector(s),
    );
    if (mainArea && toolbar && panelSel) {
      const panel = document.querySelector(panelSel);
      const pb = panel.getBoundingClientRect();
      const mb = mainArea.getBoundingClientRect();
      const tb = toolbar.getBoundingClientRect();
      if (pb.top < tb.bottom - 2) {
        failures.push(
          `面板顶部 ${Math.round(pb.top)} 压过工具行底部 ${Math.round(tb.bottom)}（层级错位）`,
        );
      }
      const ratio = pb.height / mb.height;
      if (ratio < 0.7) {
        failures.push(
          `面板高度只占主区 ${Math.round(ratio * 100)}%（应 ≈90%，下半屏被均分）`,
        );
      }
      if (pb.bottom < mb.bottom - 8) {
        failures.push(`面板距主区底部还差 ${Math.round(mb.bottom - pb.bottom)}px → 未铺满`);
      }
    }
    // 4) 横向溢出
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      failures.push(
        `横向溢出：内容宽 ${document.documentElement.scrollWidth} > 视口 ${window.innerWidth}`,
      );
    }
    return failures;
  },

  library: () => {
    const failures = [];
    const shell =
      document.querySelector(".workspace-view") ?? document.querySelector(".main-view");
    const container =
      document.querySelector(".main-area-body") ?? document.querySelector(".main-area");
    if (!shell || !container) {
      failures.push("视图壳或容器缺失（.workspace-view/.main-view/.main-area-body）");
      return failures;
    }
    const sb = shell.getBoundingClientRect();
    const cb = container.getBoundingClientRect();
    const ratio = sb.height / cb.height;
    if (ratio < 0.5) {
      failures.push(`视图壳高度只占主区 ${Math.round(ratio * 100)}% → 半屏`);
    }
    if (sb.bottom < cb.bottom - 24) {
      failures.push(`视图壳距主区底部还差 ${Math.round(cb.bottom - sb.bottom)}px → 未铺满`);
    }
    // 横向铺满（2026-11-12 补）：此前只查高度——而「卡片窄条」回归
    // （.workspace-view 缺 flex:1 → 收缩到内容宽）是**横向**问题，高度断言
    // 恒绿。右缘与底缘同口径查（壳是容器子项、内边距在 border-box 内）。
    if (sb.right < cb.right - 24) {
      failures.push(
        `视图壳距主区右缘还差 ${Math.round(cb.right - sb.right)}px → 横向未铺满（窄条回归）`,
      );
    }
    if (sb.left > cb.left + 24) {
      failures.push(
        `视图壳左缘比主区左缘缩进 ${Math.round(sb.left - cb.left)}px → 横向未铺满（窄条回归）`,
      );
    }
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      failures.push(
        `横向溢出：内容宽 ${document.documentElement.scrollWidth} > 视口 ${window.innerWidth}`,
      );
    }

    // ── 2026-11-12 补强（用户质疑「这四个页面的布局和显示真的没问题吗」）：
    // 库级视图（定时任务/通知中心/端口转发/跳板链）此前只断言「壳铺满」——
    // 壳内的排版（页头压内容、按钮互相压盖、元素越界被裁、隐形按钮仍吃
    // 点击、相邻条目粘连、长列表撑高页面而非容器内滚）全部没人管。截图目检
    // 也看不出「两个元素重叠 2px」这类问题，故改为机器判定。
    const rectOf = (el) => {
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.left),
        y: Math.round(b.top),
        w: Math.round(b.width),
        h: Math.round(b.height),
        right: Math.round(b.right),
        bottom: Math.round(b.bottom),
      };
    };
    const overlaps = (a, b) =>
      a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
    const clsOf = (el) => String(el.className || "").split(" ")[0] || el.tagName.toLowerCase();
    const chainOf = (el) => {
      const out = [];
      let p = el.parentElement;
      let d = 0;
      while (p && d < 8) {
        out.push(clsOf(p));
        p = p.parentElement;
        d += 1;
      }
      return out;
    };

    // 1) 页头与内容区不得重叠（页头压住列表/表单）
    const head = document.querySelector(".wv-head");
    const body = document.querySelector(".wv-body");
    if (head && body && overlaps(rectOf(head), rectOf(body))) {
      failures.push("页头与内容区重叠（页头压住下方内容）");
    }

    // 2) 交互元素：两两不得相交（祖先-后代包含 = 正常）；不得越出壳右缘；
    //    opacity:0 的隐形元素不得仍可命中。
    const controls = [];
    for (const el of document.querySelectorAll(
      "button, input, select, textarea, a[href], [role=checkbox], [role=button]",
    )) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const label = (
        el.textContent ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        ""
      )
        .trim()
        .slice(0, 24);
      const rec = { ...rectOf(el), label, chain: chainOf(el), invisible: cs.opacity === "0" };
      controls.push(rec);
      if (rec.invisible) {
        failures.push(`隐形但可命中：「${label}」(${rec.x},${rec.y},${rec.w}×${rec.h})`);
      }
      if (rec.right > sb.right + 1) {
        failures.push(`交互元素越出壳右缘 ${rec.right - sb.right}px：「${label}」`);
      }
    }
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i];
        const b = controls[j];
        if (!overlaps(a, b)) continue;
        const aInB = b.chain.some((c) => a.chain.includes(c));
        const bInA = a.chain.some((c) => b.chain.includes(c));
        if (aInB || bInA) continue; // 祖先-后代包含 = 正常
        failures.push(
          `交互元素重叠：「${a.label}」(${a.x},${a.y},${a.w}×${a.h}) × 「${b.label}」(${b.x},${b.y},${b.w}×${b.h})`,
        );
      }
    }

    // 3) 相邻条目不得重叠/粘连（同一父容器内的兄弟行）
    const groups = new Map();
    // 去重：多个选择器可能命中同一元素（CronPanel 复用 .forward-row 类名）
    // ——同一元素记两次会被当「相邻条目重叠」的假阳性。
    const seenRow = new Set();
    for (const sel of [
      ".notify-item",
      ".forward-row",
      ".pf-row",
      ".jump-row",
      ".jump-item",
      ".cron-row",
      ".cron-item",
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        if (seenRow.has(el)) continue;
        seenRow.add(el);
        const b = el.getBoundingClientRect();
        if (b.height === 0) continue;
        const pe = el.parentElement;
        const key = pe
          ? `${clsOf(pe)}@${Math.round(pe.getBoundingClientRect().x)}`
          : "-";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ cls: sel, ...rectOf(el) });
      }
    }
    for (const [key, list] of groups) {
      const sorted = [...list].sort((a, b) => a.y - b.y);
      for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1].y - sorted[i].bottom;
        if (gap < 0) {
          failures.push(
            `相邻条目重叠[${key}]：${sorted[i].cls} 底 ${sorted[i].bottom} > 下一条顶 ${sorted[i + 1].y}`,
          );
        } else if (gap < 2) {
          failures.push(
            `相邻条目视觉粘连（间距 ${gap}px）[${key}]：${sorted[i].cls} → ${sorted[i + 1].cls}`,
          );
        }
      }
    }

    // 4) 长列表必须在容器内滚动，不能把整个页面撑高（页面级滚动条出现在
    //    主区外 = 体验错位）。文档高度不得超出视口。
    if (document.documentElement.scrollHeight > window.innerHeight + 1) {
      failures.push(
        `页面被内容撑高（文档 ${document.documentElement.scrollHeight} > 视口 ${window.innerHeight}）→ 列表未在容器内滚动`,
      );
    }

    // 4b) 空态必须在其面板内垂直居中（2026-11-12 通知中心实证：空态挂在
    //     面板顶部，下方几百像素全空——量测偏差 219px）。偏差上限取面板
    //     高度的 15%（面板自身 padding/页头造成的小偏移不算问题）。
    {
      const panel = document.querySelector(
        ".notify-panel, .forward-list, .jump-list, .cron-list, .dock-entity",
      );
      if (panel) {
        const pb = panel.getBoundingClientRect();
        const empty = [...panel.querySelectorAll("*")]
          .filter((el) => {
            const t = (el.textContent || "").trim();
            return (
              /^(暂无|尚无|没有|还没有)/.test(t) &&
              t.length < 30 &&
              el.children.length <= 2
            );
          })
          .pop();
        if (empty) {
          const eb = empty.getBoundingClientRect();
          const off = Math.round(
            (eb.top + eb.bottom) / 2 - (pb.top + pb.bottom) / 2,
          );
          const limit = Math.max(24, Math.round(pb.height * 0.15));
          if (Math.abs(off) > limit) {
            failures.push(
              `空态未垂直居中（偏离面板中心 ${off}px，上限 ${limit}px）`,
            );
          }
        }
      }
    }
    // 4c) 死规则守卫（2026-11-12 实证）：.notify-empty-guide 的 CSS 规则一直
    //     存在，但 JSX 上的 div 只挂了 data-testid、没挂 className → 规则
    //     **从未生效**（空态因此一直不居中）。这类问题几何断言看不见（元素
    //     在、只是没样式），故用「面板存在时其关键子选择器必须有元素命中」
    //     来兜：命中不了 = 对应 CSS 规则是死规则。
    const DEAD_RULE_PROBES = [
      [".notify-panel", ".notify-empty-guide, .notify-list"],
      [".forward-list", ".forward-row, .forward-empty"],
      [".jump-list", ".jump-row, .jump-empty"],
    ];
    for (const [panelSel, childSel] of DEAD_RULE_PROBES) {
      if (!document.querySelector(panelSel)) continue;
      if (!document.querySelector(childSel)) {
        failures.push(
          `死规则嫌疑：${panelSel} 存在但 ${childSel} 无元素命中（对应 CSS 规则可能从未生效）`,
        );
      }
    }
    // 5) **有可见框的元素不得被无框元素压入**（2026-11-12 通知中心实证）：
    //    投递失败行（无框 div）与「重发」按钮（另一个 button，自带底色边框、
    //    字号比所在行大）压在条目卡片（有框 button）上——视觉上像第二张卡片
    //    粘在条目下面，且按钮向上溢出卡片 2px。这条规则不关心「卡片在哪
    //    一层」，只看**框与框的压盖关系**，所以任何结构调整都逃不掉。
    const hasVisibleBox = (el) => {
      const cs = getComputedStyle(el);
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const bs = cs.borderTopStyle;
      const bg = cs.backgroundColor;
      const hasBorder = bw > 0 && bs !== "none" && bs !== "hidden";
      const hasBg =
        bg !== "transparent" && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg);
      return hasBorder || hasBg;
    };
    const boxed = [];
    const plain = [];
    for (const el of document.querySelectorAll(
      ".workspace-view button, .workspace-view li, .workspace-view div, .workspace-view span",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      (hasVisibleBox(el) ? boxed : plain).push({ el, r });
    }
    for (const box of boxed) {
      for (const p of plain) {
        if (box.el.contains(p.el) || p.el.contains(box.el)) continue; // 父子包含 = 正常
        // 只在同一「条目/卡片」语境内判定（否则外层容器与任意元素相交是常态）
        const li = box.el.closest("li") ?? p.el.closest("li");
        if (!li || li !== (p.el.closest("li") ?? li)) continue;
        if (!overlaps(box.r, p.r)) continue;
        const label = (p.el.textContent || "").trim().slice(0, 16);
        failures.push(
          `无框元素压进有框元素 ${Math.round(p.r.bottom - box.r.bottom)}px：「${label || p.el.tagName}」`,
        );
      }
    }
    return failures;
  },

  modal: () => {
    const failures = [];
    const dlg = document.querySelector(".settings-dialog");
    if (!dlg) {
      failures.push("设置对话框未渲染");
      return failures;
    }
    const r = dlg.getBoundingClientRect();
    if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) {
      failures.push(
        `对话框超出视口 ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
    }
    // 遮罩必须盖住顶栏：视口顶部中心命中的最顶层元素应位于 .overlay 之内
    const probe = document.elementFromPoint(window.innerWidth / 2, 12);
    if (!probe || !probe.closest(".overlay")) {
      const desc = probe
        ? `${probe.tagName.toLowerCase()}.${String(probe.className).split(" ")[0] || "(无类)"}`
        : "null";
      failures.push(`模态未盖住顶栏（顶部中心命中的是 ${desc}）→ 模态开着时顶栏仍可点`);
    }
    return failures;
  },

  // 「正在回答」形态的 AI 面板（2026-11-12 用户报障「消息显示逻辑一会上面
  // 一会下面」的守卫）：停止/思考中/错误必须排在**对话流下方、输入区上方**
  // ——一个固定位置；对话变长时新内容贴底可见（旧版既没有滚动跟随，也没
  // 有把活的状态固定在下方）。
  "ai-live": () => {
    const failures = [];
    const thread = document.querySelector(".ai-thread");
    const band = document.querySelector(".ai-live-band");
    const modeRow = document.querySelector(".ai-input-mode-row");
    const stop = document.querySelector('[data-testid="ai-stop"]');
    const thinking = document.querySelector('[data-testid="ai-thinking"]');
    if (!thread) {
      failures.push("对话流缺失（.ai-thread）");
      return failures;
    }
    if (!band) {
      failures.push("活的状态带缺失（.ai-live-band）——停止/思考中没落在对话下方");
      return failures;
    }
    const tr = thread.getBoundingClientRect();
    const br = band.getBoundingClientRect();
    if (br.top < tr.bottom - 2) {
      failures.push(
        `活的状态带压在对话流上（对话底 ${Math.round(tr.bottom)} / 状态带顶 ${Math.round(br.top)}）`,
      );
    }
    if (modeRow) {
      const mr = modeRow.getBoundingClientRect();
      if (br.bottom > mr.top + 2) {
        failures.push(
          `活的状态带压到输入区（状态带底 ${Math.round(br.bottom)} / 输入区顶 ${Math.round(mr.top)}）`,
        );
      }
    }
    if (!stop) {
      failures.push("运行中却没有停止按钮");
    } else {
      const sr = stop.getBoundingClientRect();
      if (sr.width === 0 || sr.height === 0) {
        failures.push("停止按钮尺寸为 0（不可见）");
      } else {
        const hit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
        if (!hit || !(hit === stop || stop.contains(hit))) {
          failures.push("停止按钮点不到（被别的元素挡住）");
        }
      }
      if (sr.bottom > window.innerHeight + 1) {
        failures.push("停止按钮在视口外（对话一长就够不着）");
      }
    }
    if (thinking && !band.contains(thinking)) {
      failures.push("「思考中」不在活的状态带里（又回到面板顶部了）");
    }
    // 滚动跟随：对话超出可视高度时，内容应贴底（否则新回复落在折线以下，
    // 界面上看着「什么都没发生」）。
    const overflow = thread.scrollHeight - thread.clientHeight;
    if (overflow > 4) {
      const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      if (gap > 4) {
        failures.push(`对话流没有贴底（距底 ${Math.round(gap)}px）——新消息可能落在折线以下`);
      }
    }
    return failures;
  },
};

async function main() {
  const { chromium } = resolvePlaywright();
  const server = await ensureServer();
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  const results = [];
  let hadPageError = false;
  page.on("pageerror", (e) => {
    hadPageError = true;
    process.stderr.write(`[pageerror] ${String(e.message)}\n`);
  });

  try {
    for (const view of VIEWS) {
      // 库级视图跑两轮（2026-11-12 补强）：空态（?empty=1）与有内容态。
      // 空态看不出列表密度下的排版问题，有内容态看不出空态的按钮悬空问题。
      const modes =
        view.kind === "library" ? ["data", "empty"] : ["data"];
      for (const mode of modes) {
        const query = mode === "empty" ? "&empty=1" : "";
        const url = `${server.url}/dev-preview.html${view.url}${query}&lang=zh-CN`;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__shotReady__ === true, null, {
          timeout: 20000,
        });
        await page.waitForTimeout(500); // 字体/布局落定
        const failures = await page.evaluate(CHECKS[view.kind]);
        const tag0 = mode === "empty" ? "空态" : "有数据";
        failures.push(...failures.map((f) => `${tag0}: ${f}`));
        // AI 面板在场的窄窗复测（2026-11-10 审计：38vw 口径在默认窗宽 1280 下
        // 不触发，窗口收窄后视图切换钮被推出可视区）：900px 宽重跑一遍会话断言。
        // 库级视图同样窄窗复测（长文本/多列在窄窗下的挤压）。
        if (view.kind === "session" || view.kind === "library" || view.kind === "ai-live") {
          await page.setViewportSize({ width: 900, height: 720 });
          await page.waitForTimeout(400);
          const narrow = await page.evaluate(CHECKS[view.kind]);
          failures.push(...narrow.map((f) => `窄窗(900px): ${f}`));
          await page.setViewportSize(VIEWPORT);
          await page.waitForTimeout(300);
        }
        const shot = path.join(OUT_DIR, `${view.name}${mode === "empty" ? "-empty" : ""}.png`);
        await page.screenshot({ path: shot });
        results.push({ view: `${view.name}/${mode}`, failures, shot });
        const tag = failures.length === 0 ? "PASS" : "FAIL";
        process.stdout.write(`${tag}  ${view.name}/${mode}\n`);
        for (const f of failures) process.stdout.write(`      ✗ ${f}\n`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const bad = results.filter((r) => r.failures.length > 0);
  process.stdout.write(
    `\n${results.length - bad.length}/${results.length} 视图通过；截图在 ${OUT_DIR}\n`,
  );
  if (bad.length > 0 || hadPageError) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
