// tokens 对比度回归测试（Fix round 2，控制方裁定 T8 报告 §3.3/§7-4）：
// 语义键 --color-accent-text / --color-on-accent / --color-on-danger 的取值
// 必须在两主题的全部实际落面上 ≥4.5:1（WCAG AA 正文），App.css 的文字场景
// 消费点必须迁到 accent-text / on-* 键。纯文本解析 + WCAG 相对亮度计算，
// 防「改回去不红」——数字即规约。CSS 经 Vite ?raw 读入（不引 node 模块）。
import { describe, expect, it } from "vitest";
import tokensCss from "./tokens.css?raw";
import appCss from "../App.css?raw";

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

/** color-mix(in srgb, fg p%, bg) 的等价合成。 */
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

// --- tokens.css 解析（:root = 亮色块，[data-theme="dark"] = 暗色块） ----------

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
    // 暗色块引用品牌种子（定义在 :root）→ 回落 base 查
    v = map.get(ref[1]) ?? base.get(ref[1]);
    expect(v, `语义键 ${name} 引用的 ${ref[1]} 不存在`).toBeTruthy();
  }
  return v!.replace(/^#/, "#").toLowerCase();
}

const light = parseBlock(tokensCss, ":root");
const dark = parseBlock(tokensCss, '[data-theme="dark"]');

// App.css 派生面（与 :root 定义同式）：raised = fg6%/bg，overlay = fg10%/bg
function surfaces(t: Map<string, string>): Record<string, string> {
  const bg = resolve(t, "--color-bg");
  const fg = resolve(t, "--color-fg");
  return { bg, raised: mix(fg, bg, 6), overlay: mix(fg, bg, 10) };
}

describe.each([
  ["亮色", light] as const,
  ["暗色", dark] as const,
])("语义键对比度（%s）", (_label, t) => {
  const s = surfaces(t);
  const accentText = resolve(t, "--color-accent-text");
  const onAccent = resolve(t, "--color-on-accent");
  const onDanger = resolve(t, "--color-on-danger");

  it("accent-text 作文字色：bg / raised / overlay 全部 ≥4.5（fix 2 前：亮 2.33）", () => {
    for (const [name, surf] of Object.entries(s)) {
      const ratio = contrast(accentText, surf);
      expect(ratio, `accent-text on ${name} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("on-accent（主按钮实底上的文字）≥4.5（fix 2 前：亮 2.33）", () => {
    const ratio = contrast(onAccent, resolve(t, "--color-accent"));
    expect(ratio, `on-accent on accent = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it("on-danger（danger 实底上的按钮文字）≥4.5（fix 2 前：暗 2.79）", () => {
    const ratio = contrast(onDanger, resolve(t, "--color-danger"));
    expect(ratio, `on-danger on danger = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("App.css 消费点纪律（文字场景迁移）", () => {
  it("不再有 color: var(--color-accent) 文字消费（全部迁 accent-text）", () => {
    // 行首锚定 color: 声明本身（border-color/background-color 不在此列，留作非文字 accent）
    expect(/^\s*color:\s*var\(--color-accent\);/m.test(appCss)).toBe(false);
  });

  it("实底按钮文字走 on-* 语义键（btn-accent / btn-danger）", () => {
    const btnAccent = appCss.slice(appCss.indexOf(".btn-accent {"), appCss.indexOf("}", appCss.indexOf(".btn-accent {")));
    expect(btnAccent).toContain("color: var(--color-on-accent)");
    const btnDanger = appCss.slice(appCss.indexOf(".btn-danger {"), appCss.indexOf("}", appCss.indexOf(".btn-danger {")));
    expect(btnDanger).toContain("color: var(--color-on-danger)");
  });
});
