// tokens 对比度回归测试（Fix round 2，控制方裁定 T8 报告 §3.3/§7-4）：
// 语义键 --color-accent-text / --color-on-accent / --color-on-danger 的取值
// 必须在全部主题的全部实际落面上 ≥4.5:1（WCAG AA 正文），App.css 的文字场景
// 消费点必须迁到 accent-text / on-* 键。纯文本解析 + WCAG 相对亮度计算，
// 防「改回去不红」——数字即规约。CSS 经 Vite ?raw 读入（不引 node 模块）。
// theme-suite T2：data-theme 块改造为**发现全部块**（原硬编码 ：root/dark 两块
// ——多主题三套新增后逐块过同一阈值）；终端新色板按既有纪律全 16 色核对。
import { describe, expect, it } from "vitest";
import tokensCss from "./tokens.css?raw";
import { allAppCss } from "../styles/all-css";
import {
  lightTerminalTheme,
  darkTerminalTheme,
  themeTerminalThemes,
} from "./terminal-themes";
import { isDarkBackground } from "./gallery";
import type { ITheme } from "@xterm/xterm";

// --- WCAG 2.x 相对亮度 / 对比度 ---------------------------------------------

function luminance(hex: string): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => f(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

/** color-mix(in srgb, fg p%, bg) 的等价合成（不透明形态，既有口径）。 */
function mix(fg: string, bg: string, p: number): string {
  const f = fg.replace("#", "");
  const g = bg.replace("#", "");
  return (
    "#" +
    [0, 2, 4]
      .map((i) =>
        Math.round(
          parseInt(f.slice(i, i + 2), 16) * (p / 100) +
            parseInt(g.slice(i, i + 2), 16) * (1 - p / 100),
        ),
      )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

// --- 颜色管线（theme-suite T2/T3）：rgba 令牌 → 参考底合成 → 不透明 hex ------
// 玻璃等半透明令牌无法直接算对比度——先在假定桌面底上合成（tokens.css 注释
// 同源参考底），合成后走同一 WCAG 口径；不透明令牌合成即自身，全主题统一管线。

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function toRgba(v: string): Rgba {
  const m = v.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  const h = v.replace("#", "").toLowerCase();
  expect(h, `非 hex/rgba 色: ${v}`).toMatch(/^[0-9a-f]{6}$/);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}

function toHex(c: Rgba): string {
  return "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** straight-alpha over 合成。 */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

/** color-mix(in srgb, fg p%, bg) 的 RGBA 形态（premultiplied 直插值；对不透明
 * 输入与上方 mix() 同结果）。 */
function mixRgba(fg: Rgba, bg: Rgba, p: number): Rgba {
  const t = p / 100;
  return {
    r: fg.r * t + bg.r * (1 - t),
    g: fg.g * t + bg.g * (1 - t),
    b: fg.b * t + bg.b * (1 - t),
    a: fg.a * t + bg.a * (1 - t),
  };
}

/** 半透明令牌的合成参考桌面底（假定用户深色壁纸 #1C2430；tokens.css glass
 * 块注释同一假设）。 */
const REF_DESKTOP: Rgba = toRgba("#1c2430");

/** 任意令牌值 → 参考底合成后的不透明 hex（不透明即自身）。 */
function flatten(v: string): string {
  const c = toRgba(v);
  return toHex(c.a >= 1 ? c : over(c, REF_DESKTOP));
}

// --- tokens.css 解析（:root = 亮色块；[data-theme="…"] = 具名主题块） ----------

function parseBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start, `tokens.css 缺 ${selector} 块`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

function resolve(
  map: Map<string, string>,
  name: string,
  base: Map<string, string> = light,
): string {
  let v = map.get(name) ?? base.get(name);
  expect(v, `缺语义键 ${name}`).toBeTruthy();
  const ref = v!.match(/^var\((--[\w-]+)\)$/);
  if (ref) {
    // 主题块引用品牌种子（定义在 :root）→ 回落 base 查
    v = map.get(ref[1]) ?? base.get(ref[1]);
    expect(v, `语义键 ${name} 引用的 ${ref[1]} 不存在`).toBeTruthy();
  }
  return v!.replace(/^#/, "#").toLowerCase();
}

const light = parseBlock(tokensCss, ":root");

/** 发现全部具名主题块（theme-suite T2）：tokens.css 里每个
 * [data-theme="…"] 选择器一主题，新块入册即受全部阈值组约束。
 * color-scheme 无 -- 前缀（parseBlock 只收自定义属性），块体单抓。 */
function discoverThemeBlocks(): { id: string; map: Map<string, string>; scheme: string }[] {
  const ids = [...tokensCss.matchAll(/\[data-theme="([\w-]+)"\]/g)].map((m) => m[1]);
  expect(ids.length, "data-theme 块发现为空").toBeGreaterThan(0);
  return [...new Set(ids)].map((id) => {
    const start = tokensCss.indexOf(`[data-theme="${id}"]`);
    const open = tokensCss.indexOf("{", start);
    const body = tokensCss.slice(open, tokensCss.indexOf("}", open));
    const scheme = body.match(/color-scheme:\s*(light|dark)/);
    expect(scheme, `主题块 ${id} 缺 color-scheme 声明`).toBeTruthy();
    return { id, map: parseBlock(tokensCss, `[data-theme="${id}"]`), scheme: scheme![1] };
  });
}

const themeBlocks = discoverThemeBlocks();

// App.css 派生面（与 :root 定义同式）：raised = fg6%/bg，overlay = fg10%/bg。
// 层叠口径：bg 先合成到参考桌面底（REF_DESKTOP），surface/派生面再叠其上——
// 与真实渲染层序一致（surface 永远盖在窗口 bg 上）。
function surfaces(t: Map<string, string>): Record<string, string> {
  const bg = over(toRgba(resolve(t, "--color-bg")), REF_DESKTOP);
  const fg = toRgba(resolve(t, "--color-fg"));
  return {
    bg: toHex(bg),
    raised: toHex(mixRgba(fg, bg, 6)),
    overlay: toHex(mixRgba(fg, bg, 10)),
    surface: toHex(over(toRgba(resolve(t, "--color-surface")), bg)),
  };
}

describe.each([
  ["亮色", light] as const,
  ...themeBlocks.map((b) => [b.id, b.map] as const),
])("语义键对比度（%s）", (_label, t) => {
  const s = surfaces(t);
  const accentText = flatten(resolve(t, "--color-accent-text"));
  const onAccent = flatten(resolve(t, "--color-on-accent"));
  const onDanger = flatten(resolve(t, "--color-on-danger"));

  it("accent-text 作文字色：bg / raised / overlay 全部 ≥4.5（fix 2 前：亮 2.33）", () => {
    for (const [name, surf] of Object.entries(s)) {
      const ratio = contrast(accentText, surf);
      expect(ratio, `accent-text on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("on-accent（主按钮实底上的文字）≥4.5（fix 2 前：亮 2.33）", () => {
    const ratio = contrast(onAccent, flatten(resolve(t, "--color-accent")));
    expect(ratio, `on-accent on accent = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it("on-danger（danger 实底上的按钮文字）≥4.5（fix 2 前：暗 2.79）", () => {
    const ratio = contrast(onDanger, flatten(resolve(t, "--color-danger")));
    expect(ratio, `on-danger on danger = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("App.css 消费点纪律（文字场景迁移）", () => {
  it("不再有 color: var(--color-accent) 文字消费（全部迁 accent-text）", () => {
    // 行首锚定 color: 声明本身（border-color/background-color 不在此列，留作非文字 accent）
    expect(/^\s*color:\s*var\(--color-accent\);/m.test(allAppCss())).toBe(false);
  });

  it("实底按钮文字走 on-* 语义键（btn-accent / btn-danger）", () => {
    const btnAccent = allAppCss().slice(allAppCss().indexOf(".btn-accent {"), allAppCss().indexOf("}", allAppCss().indexOf(".btn-accent {")));
    expect(btnAccent).toContain("color: var(--color-on-accent)");
    const btnDanger = allAppCss().slice(allAppCss().indexOf(".btn-danger {"), allAppCss().indexOf("}", allAppCss().indexOf(".btn-danger {")));
    expect(btnDanger).toContain("color: var(--color-on-danger)");
  });

  // 产品就绪批次 T1（亮色全量实算 /tmp/pr-t1/audit-pr.mjs 新发现）：kh-* 键历史
  // 徽标/危险动作消费幽灵键 --color-success-text/--color-danger-text（tokens.css
  // 无定义），硬编码回退 #2e7d32/#c62828 实渲染——亮色 overlay 上 3.93/4.30 <4.5，
  // 且暗色主题回退亮色系值更不可读。清偿：迁校准语义键（--color-success teal-800
  // / --color-danger #b42318，两主题四面 ≥4.5 由上组断言钉死），幽灵键禁用。
  it("kh-* 状态徽标/危险动作消费校准语义键（幽灵 --color-*-text 回退禁用）", () => {
    // 幽灵键（tokens.css 无定义）带回退值 = 回退值实渲染，全库禁用
    expect(/var\(--color-(success|danger)-text\b/.test(allAppCss())).toBe(false);
    const khOk = allAppCss().slice(allAppCss().indexOf(".kh-badge-ok {"), allAppCss().indexOf("}", allAppCss().indexOf(".kh-badge-ok {")));
    expect(khOk).toContain("color: var(--color-success)");
    const khChanged = allAppCss().slice(allAppCss().indexOf(".kh-badge-changed {"), allAppCss().indexOf("}", allAppCss().indexOf(".kh-badge-changed {")));
    expect(khChanged).toContain("color: var(--color-danger)");
    const khActions = allAppCss().slice(allAppCss().indexOf(".kh-actions .kh-danger {"), allAppCss().indexOf("}", allAppCss().indexOf(".kh-actions .kh-danger {")));
    expect(khActions).toContain("color: var(--color-danger)");
  });
});

// --- 亮色专项校准（ui-batch3 T1，UI 审计 A3 清偿；沿 fix 2 制式：实算数字即规约） ---
// 校准前缺口（全量实算 /tmp/ui3-t1/audit.mjs，WCAG 2.x）：
//   danger/warning/success 作文字 on overlay = 3.70/3.85/4.19（<4.5）
//   fg-muted(60%) on raised/overlay = 4.07/3.75（<4.5）
//   accent 作指示边框 vs bg = 2.33（<3，1.4.11 非文本）
//   终端亮色 bright 六槽（red/green/yellow/blue/magenta/cyan）= 3.04/2.33/2.01/3.33/2.60/2.23

/** 从 color-mix(in srgb, var(--x) N%, transparent) 声明取 fg 引用与百分比。 */
function parseFgMix(v: string | undefined): { ref: string; pct: number } {
  expect(v, "--fg-muted 缺失").toBeTruthy();
  const m = v!.match(/color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+)%/);
  expect(m, `fg-muted 定义非预期形态: ${v}`).toBeTruthy();
  return { ref: m![1], pct: Number(m![2]) };
}

/** resolve 只解一层 var()；别名链（accent-border → accent → 品牌种子）在此解到底。 */
function deepResolve(t: Map<string, string>, name: string): string {
  let v = resolve(t, name);
  for (let i = 0; i < 3 && v.startsWith("var("); i++) {
    v = resolve(t, v.slice(4, -1));
  }
  return v;
}

describe("亮色专项校准（ui-batch3 T1，审计 A3）", () => {
  const s = surfaces(light);

  it("danger/warning/success 作文字：bg/raised/overlay/surface 全 ≥4.5（校准前 overlay 3.70/3.85/4.19）", () => {
    for (const key of ["--color-danger", "--color-warning", "--color-success"] as const) {
      const v = resolve(light, key);
      for (const [name, surf] of Object.entries(s)) {
        const ratio = contrast(v, surf);
        expect(ratio, `${key} on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("accent-border 指示边框键：bg/raised/overlay/surface 全 ≥3（校准前 accent 边框 2.33）", () => {
    const v = resolve(light, "--color-accent-border");
    for (const [name, surf] of Object.entries(s)) {
      const ratio = contrast(v, surf);
      expect(ratio, `accent-border vs ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("暗色 accent-border 别名 accent（teal-300，暗色已达标不动）", () => {
    const dark = themeBlocks.find((b) => b.id === "dark")!.map;
    expect(deepResolve(dark, "--color-accent-border")).toBe(deepResolve(dark, "--color-accent"));
  });

  it("亮色 fg-muted 合成：bg/raised/overlay/surface 全 ≥4.5（校准前 overlay 3.75）", () => {
    const { ref, pct } = parseFgMix(light.get("--fg-muted"));
    const fg = resolve(light, ref);
    for (const [name, surf] of Object.entries(s)) {
      const ratio = contrast(mix(fg, surf, pct), surf);
      expect(ratio, `fg-muted on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("暗色 fg-muted 保持 60%（暗色视觉零变化）", () => {
    const dark = themeBlocks.find((b) => b.id === "dark")!.map;
    expect(parseFgMix(dark.get("--fg-muted")).pct).toBe(60);
  });

  it("实底 on-danger 白字随校准加深仍 ≥4.5（#b42318 上 6.57）", () => {
    const ratio = contrast(resolve(light, "--color-on-danger"), resolve(light, "--color-danger"));
    expect(ratio, `on-danger on danger = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it("亮色终端 ANSI 前景槽全 ≥4.5、光标 ≥3（校准前 bright 六槽 2.01–3.33）", () => {
    const bg = lightTerminalTheme.background!;
    for (const [ch, v] of Object.entries(lightTerminalTheme)) {
      if (ch === "selectionBackground" || ch === "cursorAccent" || ch === "background") continue;
      const req = ch === "cursor" ? 3 : 4.5;
      const ratio = contrast(v as string, bg);
      expect(ratio, `terminal light ${ch} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(req);
    }
  });
});

// --- 新主题块全键校准（theme-suite T2）：多主题新块逐块过全键阈值 --------------
// 实算口径 WCAG 2.x（/tmp/theme-suite-t2/audit.mjs，数字写 tokens.css 各块注释）：
//   oled     accent-text 14.20/13.05/12.11  danger 7.54/6.93/6.43/6.89
//            warning 9.78/8.99/8.34/8.94    success 11.28/10.37/9.62/10.31
//            fg-muted(60%) 6.14/5.65/5.24/5.61  on-accent 12.07  on-danger 6.41
//   amethyst accent-text 6.72/5.90/5.34     danger 6.57/5.76/5.21/5.49
//            warning 8.52/7.47/6.76/7.12    success 9.83/8.62/7.80/8.21
//            fg-muted(60%) 5.90/5.18/4.68/4.93  on-accent 6.56  on-danger 6.41
//   verdant  accent-text 6.22/5.58/5.16/6.73  danger 6.08/5.45/5.05/6.57
//            warning 6.56/5.88/5.44/7.09    success 6.22/5.58/5.16/6.73
//            fg-muted(72%) 5.72/5.13/4.75/6.19  on-accent 4.54  on-danger 6.57
// 既有两块不在本组：亮色受「亮色专项校准」组同键约束；暗色按历史口径钉死
//（danger 文字 on overlay 4.09 / fg-muted 60% on overlay 4.48——「原值原式，
// 视觉零变化」纪律不回改），暗色受上方「语义键对比度」全块组约束。
const NEW_THEME_BLOCKS = themeBlocks.filter((b) => b.id !== "dark");

describe.each(NEW_THEME_BLOCKS.map((b) => [b.id, b.map, b.scheme] as const))(
  "新主题块全键校准（%s，theme-suite T2）",
  (_id, t, scheme) => {
    const s = surfaces(t);

    it("danger/warning/success 作文字：bg/raised/overlay/surface 全 ≥4.5", () => {
      for (const key of ["--color-danger", "--color-warning", "--color-success"] as const) {
        const v = flatten(resolve(t, key));
        for (const [name, surf] of Object.entries(s)) {
          const ratio = contrast(v, surf);
          expect(ratio, `${key} on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it("accent-border 指示边框键：bg/raised/overlay/surface 全 ≥3（1.4.11 非文本）", () => {
      const v = flatten(deepResolve(t, "--color-accent-border"));
      for (const [name, surf] of Object.entries(s)) {
        const ratio = contrast(v, surf);
        expect(ratio, `accent-border vs ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });

    it("fg-muted 合成：bg/raised/overlay/surface 全 ≥4.5", () => {
      const { ref, pct } = parseFgMix(t.get("--fg-muted"));
      // color-mix(fg p%, transparent) 的 premultiplied 结果 = fg 带 alpha p/100
      //（向 transparent 混合不改 RGB）；合成到各落面上算可读性。
      const fg = toRgba(flatten(resolve(t, ref)));
      const muted: Rgba = { ...fg, a: (fg.a * pct) / 100 };
      for (const [name, surf] of Object.entries(s)) {
        const flattened = toHex(over(muted, toRgba(surf)));
        const ratio = contrast(flattened, surf);
        expect(ratio, `fg-muted on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("color-scheme 与块内 --color-bg 明暗一致（二级解析的 CSS 面）", () => {
      const bgLum = luminance(flatten(resolve(t, "--color-bg")));
      if (scheme === "dark") expect(bgLum).toBeLessThan(0.5);
      else expect(bgLum).toBeGreaterThanOrEqual(0.5);
    });
  },
);

// --- Glass 主题（theme-suite T3）：真透明/毛玻璃令牌的 alpha 合成校准 ----------
// 假设（与上方 REF_DESKTOP、terminal glass 色板注释同一前提）：玻璃面后的桌面
// 为深色壁纸 #1C2430。半透明令牌先合成再实算：
//   glass bg rgba(18,13,32,0.86) → 合成 #131022（lum 0.006，暗底系）
//   accent-text 6.86/6.04/5.45/5.45  danger 6.70/5.90/5.32/5.32
//   warning 8.69/7.65/6.91/6.91      success 10.03/8.83/7.97/7.97
//   fg-muted(60%) 5.97/5.26/4.74/4.74  on-accent 6.56  on-danger 6.41
//   Linux 兜底 alpha 0.94 → 合成 #130e21（近实底，无系统模糊面下保可读）
describe("Glass 主题 alpha 合成（theme-suite T3）", () => {
  const glass = themeBlocks.find((b) => b.id === "glass");
  it("data-theme=glass 块在册且 bg 为半透明 rgba（真透明面）", () => {
    expect(glass, "tokens.css 缺 glass 块").toBeTruthy();
    const raw = glass!.map.get("--color-bg")!;
    const c = toRgba(raw);
    expect(c.a).toBeGreaterThan(0);
    expect(c.a).toBeLessThan(1);
  });

  it("bg 合成到参考桌面底 #1C2430 后 = #131022（暗底，二级解析=dark 的实感）", () => {
    const glassMap = glass!.map;
    expect(flatten(resolve(glassMap, "--color-bg"))).toBe("#131022");
    // color-scheme: dark 与合成底明暗一致
    expect(glass!.scheme).toBe("dark");
  });

  it("Linux 兜底（无系统模糊面）：alpha 提到 0.94，合成仍为暗底", () => {
    // CSS 侧 [data-theme="glass"][data-platform="linux"] 的覆写值——这里按同一
    // 数学核对其合成结果（tokens.css 注释同源）。
    const c = over(toRgba("rgba(18, 13, 32, 0.94)"), REF_DESKTOP);
    expect(toHex(c)).toBe("#130e21");
    expect(luminance(toHex(c))).toBeLessThan(0.5);
  });
});

// --- 终端色板对比度（theme-suite T2）：六套全核对 -----------------------------
// 亮底口径（既有 light 纪律，tokens.test 亮色 ANSI 组同式）：16 槽 + fg 全 ≥4.5、
//   光标 ≥3（verdant 按 bg #F4F7F1 亮底走此口径）；
// 暗色口径：black/brightBlack 豁免（背景族——既有 dark 槽实算 1.11/2.03，本就
//   不可达 4.5；只要求与底可区分 >1.02），其余 14 槽 + fg ≥4.5、光标 ≥3。
// glass 半透明底：rgba 先合成到参考桌面底 #1C2430（REF_DESKTOP 同一假设）再算。

const TERMINAL_PALETTES: { id: string; theme: ITheme }[] = [
  { id: "light", theme: lightTerminalTheme },
  { id: "dark", theme: darkTerminalTheme },
  { id: "oled", theme: themeTerminalThemes.oled },
  { id: "amethyst", theme: themeTerminalThemes.amethyst },
  { id: "verdant", theme: themeTerminalThemes.verdant },
  { id: "glass", theme: themeTerminalThemes.glass },
];

describe.each(TERMINAL_PALETTES.map((p) => [p.id, p.theme] as const))(
  "终端色板对比度（%s，theme-suite T2）",
  (id, theme) => {
    const darkBg = isDarkBackground(flatten(theme.background!));
    const bg = flatten(theme.background!);

    it(`${darkBg ? "暗色口径（black 族豁免）" : "亮色口径"}：前景槽 ≥4.5、光标 ≥3、fg ≥4.5`, () => {
      for (const [ch, v] of Object.entries(theme)) {
        if (ch === "selectionBackground" || ch === "cursorAccent" || ch === "background") continue;
        const isBlackFamily = ch === "black" || ch === "brightBlack";
        const ratio = contrast(flatten(v as string), bg);
        if (darkBg && isBlackFamily) {
          expect(ratio, `terminal ${id} ${ch} 与底不可区分 = ${ratio.toFixed(2)}`).toBeGreaterThan(1.02);
        } else {
          const req = ch === "cursor" ? 3 : 4.5;
          expect(ratio, `terminal ${id} ${ch} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(req);
        }
      }
    });

    it("glass 色板底为半透明 rgba（主题玻璃面透出；其余套不透明）", () => {
      if (id === "glass") {
        expect(theme.background).toMatch(/^rgba\(/);
        expect(toRgba(theme.background!).a).toBeLessThan(1);
      } else {
        expect(theme.background).toMatch(/^#/);
      }
    });
  },
);
