// iterm.ts（Phase 2 Task 9，B2 主题生态）：iTerm2 配色文件（.itermcolors）解析。
//
// 格式：XML plist——顶层 <dict>，键 = 颜色通道名（"Ansi 0 Color"…"Ansi 15
// Color"、"Foreground Color"…），值 = 子 dict 的 Red/Green/Blue Component
// （0.0-1.0 实数，偶见 Alpha Component）。解析用 DOMParser（浏览器/jsdom 内建），
// 不引第三方 plist 库——本格式只有一个实际变体，几十行足够。
//
// 通道映射（iTerm2 → xterm ITheme）：
//   Ansi 0-7 → black/red/green/yellow/blue/magenta/cyan/white
//   Ansi 8-15 → brightBlack..brightWhite
//   Foreground Color → foreground；Background Color → background；
//   Cursor Color → cursor；Cursor Text Color → cursorAccent；
//   Selection Color → selectionBackground（缺则退 Selected Text Color）；
//   Bold Color → brightWhite（仅当 Ansi 15 缺席时补位）。
// 通道名匹配大小写不敏感（手改过的导出件常见 "ANSI 0 Color"）。
// 缺通道不强造（xterm 回落默认）；fg/bg 缺失即结构不对 → throw。
import type { ITheme } from "@xterm/xterm";
import { isDarkBackground, type TerminalThemeDef } from "../gallery";

/** 解析产物：主题定义（id 由调用方分配——导入时生成 custom-<ts> 系）。 */
export type ParsedColorScheme = Omit<TerminalThemeDef, "id">;

const ANSI_KEYS = [
  "ansi 0 color",
  "ansi 1 color",
  "ansi 2 color",
  "ansi 3 color",
  "ansi 4 color",
  "ansi 5 color",
  "ansi 6 color",
  "ansi 7 color",
  "ansi 8 color",
  "ansi 9 color",
  "ansi 10 color",
  "ansi 11 color",
  "ansi 12 color",
  "ansi 13 color",
  "ansi 14 color",
  "ansi 15 color",
] as const;

const ANSI_FIELDS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** 0.0-1.0 分量 → #rrggbb（round(c*255)；浮点误差 ≤0.5ulp 由 round 吸收）。 */
function componentHex(r: number, g: number, b: number): string {
  const to = (c: number): string =>
    Math.max(0, Math.min(255, Math.round(c * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** plist dict 节点 → 小写键 → 值元素 映射（key 与值按文档序成对出现）。 */
function dictPairs(dict: Element): Map<string, Element> {
  const pairs = new Map<string, Element>();
  const children = Array.from(dict.children);
  for (let i = 0; i + 1 < children.length; i += 2) {
    if (children[i].tagName === "key") {
      pairs.set((children[i].textContent ?? "").trim().toLowerCase(), children[i + 1]);
    }
  }
  return pairs;
}

/** 子 dict 里的 RGB 分量（缺任一通道 / 非数 → null）。 */
function rgbOf(dict: Element | undefined): string | null {
  if (!dict) return null;
  const pairs = dictPairs(dict);
  const comp = (name: string): number | null => {
    const el = pairs.get(name);
    if (!el) return null;
    const v = Number.parseFloat(el.textContent ?? "");
    return Number.isFinite(v) ? v : null;
  };
  const r = comp("red component");
  const g = comp("green component");
  const b = comp("blue component");
  return r === null || g === null || b === null ? null : componentHex(r, g, b);
}

/** 解析 iTerm2 .itermcolors 文本。结构坏（XML 不可解析/无顶层 dict/缺 fg/bg）→ throw。 */
export function parseItermColors(text: string): ParsedColorScheme {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("not a valid plist (XML parse error)");
  }
  const top = doc.getElementsByTagName("dict")[0];
  if (!top) throw new Error("not a valid itermcolors (no top-level dict)");

  const pairs = dictPairs(top);
  const theme: ITheme = {};

  ANSI_KEYS.forEach((key, idx) => {
    const hex = rgbOf(pairs.get(key));
    if (hex) theme[ANSI_FIELDS[idx]] = hex;
  });

  const named = (name: string): string | null => rgbOf(pairs.get(name.toLowerCase()));
  theme.foreground = named("Foreground Color") ?? undefined;
  theme.background = named("Background Color") ?? undefined;
  theme.cursor = named("Cursor Color") ?? undefined;
  theme.cursorAccent = named("Cursor Text Color") ?? undefined;
  theme.selectionBackground =
    named("Selection Color") ?? named("Selected Text Color") ?? undefined;
  if (!theme.brightWhite) {
    theme.brightWhite = named("Bold Color") ?? undefined;
  }

  if (!theme.background || !theme.foreground) {
    throw new Error("not a valid itermcolors (missing Foreground/Background Color)");
  }
  return { name: "iTerm2 Import", dark: isDarkBackground(theme.background), theme };
}
