// CSS 纪律守卫（评审 2026-10-10 整改的防复发层；沿 tokens.test/dialogScroll.test
// 的「对样式源做文本断言」口径，数字即规约）：
//   1. 引用必须有定义——任何 var(--x) 的 x 必须在 tokens.css 或分节样式中定义
//      （或带 fallback）。历史事故：--shadow-overlay/--fg 共 13 处引用零定义，
//      浮层投影静默失效数月无人知。
//   2. 动效时长/缓动只允许引用 motion token（--dur*/--ease*/--toast-ttl），
//      字面值黑名单——收敛后不允许新字面值回流。
//   3. 圆角只允许 radius token（+50% 圆 / 0 直角）。
//   4. 字号只允许 text token（+1em 继承 / 16px 的 :root rem 基准锚点）。
import { describe, expect, it } from "vitest";
import { allAppCss } from "./all-css";
import tokensCss from "../theme/tokens.css?raw";

function allSources(): string {
  // tokens.css 单独 ?raw 引入；分节经 allAppCss（index.css 除外）。
  return tokensCss + "\n" + allAppCss();
}

describe("CSS 纪律守卫（评审整改防复发）", () => {
  it("每个 var(--x) 引用都有定义（或带 fallback）——杜绝失效引用静默回潜", () => {
    const src = allSources();
    const defined = new Set<string>();
    for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    const offenders: string[] = [];
    for (const m of allAppCss().matchAll(/var\((--[\w-]+)(\s*,[^)]*)?\)/g)) {
      const [, name, fallback] = m;
      if (!defined.has(name) && !fallback) offenders.push(name);
    }
    expect(offenders, `未定义的令牌引用: ${[...new Set(offenders)].join(", ")}`).toEqual([]);
  });

  it("动效时长/缓动零字面值——transition/animation 只引用 motion token", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      if (!/^\s*(transition|animation)\s*:/.test(line)) continue;
      if (line.includes("0.01ms")) continue; // reduced-motion 全局兜底（00-base）
      if (/\d(\.\d+)?(ms|s)\b/.test(line)) offenders.push(line.trim());
    }
    expect(offenders, `动效字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("border-radius 只引用 radius token（50% 圆 / 0 直角除外）", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      const m = line.match(/^\s*border-radius:\s*([^;]+);/);
      if (!m) continue;
      const v = m[1].trim();
      if (v === "0" || v === "50%" || v.includes("var(--radius-")) continue;
      offenders.push(line.trim());
    }
    expect(offenders, `圆角字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("font-size 只引用 text token（1em 继承 / 16px rem 基准锚点除外）", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      const m = line.match(/^\s*font-size:\s*([^;]+);/);
      if (!m) continue;
      const v = m[1].trim();
      if (v === "1em" || v === "inherit" || v === "16px" || v.includes("var(--text-")) continue;
      offenders.push(line.trim());
    }
    expect(offenders, `字号字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("字阶七档与动效 token 存在（结构锚）", () => {
    for (const key of [
      "--text-2xs",
      "--text-xs",
      "--text-sm",
      "--text-base",
      "--text-md",
      "--text-lg",
      "--text-xl",
      "--dur-fast",
      "--dur",
      "--dur-slow",
      "--ease-out",
      "--ease-in",
      "--shadow-1",
      "--shadow-2",
      "--shadow-3",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--radius-pill",
      "--toast-ttl",
      "--z-ctx",
      "--z-ctx-menu",
      "--z-ctx-sub",
    ]) {
      expect(tokensCss.includes(`${key}:`), `tokens.css 缺 ${key}`).toBe(true);
    }
  });

  it("右键菜单 z 小栈已入刻度（99/100/101 字面值清零）", () => {
    expect(allAppCss()).not.toMatch(/z-index:\s*(99|100|101);/);
  });
});
