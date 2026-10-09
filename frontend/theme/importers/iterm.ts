// iterm.ts（Phase 2 Task 9，B2 主题生态）：iTerm2 配色文件（.itermcolors）解析。
//
// 格式：plist——XML 形态（DOMParser，浏览器/jsdom 内建）与二进制形态（bplist00
// 魔数，iTerm2 可选导出；BL-512 清偿，解析器见 ./bplist）。两路都归一到
// 「通道组件表」后走同一映射核——逻辑只此一份。不引第三方 plist 库——本格式
// 只有一个实际变体，几十行足够。
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
import { parseBplist } from "./bplist";

/** 解析产物：主题定义（id 由调用方分配——导入时生成 custom-<ts> 系）。 */
export type ParsedColorScheme = Omit<TerminalThemeDef, "id">;

/** 通道组件表（XML/bplist 两路共同产物）：小写通道名 → 小写分量键 → 0.0-1.0 值。 */
type ChannelMap = Map<string, Map<string, number>>;

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

/** 通道映射核（XML/bplist 共同下游）：通道表 → 主题定义。fg/bg 缺失即结构
 * 不对 → throw（与两路调用方同语义）。 */
function schemeFromChannels(channels: ChannelMap): ParsedColorScheme {
  const rgbOf = (name: string): string | null => {
    const comps = channels.get(name.toLowerCase());
    if (!comps) return null;
    const comp = (k: string): number | null => comps.get(k) ?? null;
    const r = comp("red component");
    const g = comp("green component");
    const b = comp("blue component");
    return r === null || g === null || b === null ? null : componentHex(r, g, b);
  };

  const theme: ITheme = {};

  ANSI_KEYS.forEach((key, idx) => {
    const hex = rgbOf(key);
    if (hex) theme[ANSI_FIELDS[idx]] = hex;
  });

  const named = (name: string): string | null => rgbOf(name);
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

/** XML dict 元素 → 通道组件表（key 与值按文档序成对；值是 dict 的展开一层分量，
 * 分量值 parseFloat 宽松解析——与原 XML 路径同口径）。 */
function channelsOfXmlDict(dict: Element): ChannelMap {
  const channels: ChannelMap = new Map();
  const children = Array.from(dict.children);
  for (let i = 0; i + 1 < children.length; i += 2) {
    if (children[i].tagName !== "key") continue;
    const name = (children[i].textContent ?? "").trim().toLowerCase();
    const el = children[i + 1];
    if (el.tagName !== "dict") continue;
    const comps = new Map<string, number>();
    const sub = Array.from(el.children);
    for (let j = 0; j + 1 < sub.length; j += 2) {
      if (sub[j].tagName !== "key") continue;
      const v = Number.parseFloat(sub[j + 1].textContent ?? "");
      if (Number.isFinite(v)) {
        comps.set((sub[j].textContent ?? "").trim().toLowerCase(), v);
      }
    }
    channels.set(name, comps);
  }
  return channels;
}

/** 解析 iTerm2 .itermcolors 文本（XML plist）。结构坏（XML 不可解析/无顶层
 * dict/缺 fg/bg）→ throw。 */
export function parseItermColors(text: string): ParsedColorScheme {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("not a valid plist (XML parse error)");
  }
  const top = doc.getElementsByTagName("dict")[0];
  if (!top) throw new Error("not a valid itermcolors (no top-level dict)");
  return schemeFromChannels(channelsOfXmlDict(top));
}

/** 解析二进制形态（bplist00；BL-512）。顶层非 dict / 缺 fg/bg → throw。 */
export function parseItermColorsBinary(bytes: Uint8Array): ParsedColorScheme {
  const top: unknown = parseBplist(bytes);
  if (
    !top ||
    typeof top !== "object" ||
    Array.isArray(top) ||
    (top as object) instanceof Date ||
    (top as object) instanceof Uint8Array
  ) {
    throw new Error("not a valid itermcolors (no top-level dict)");
  }
  const channels: ChannelMap = new Map();
  for (const [name, value] of Object.entries(top as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const comps = new Map<string, number>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        comps.set(k.trim().toLowerCase(), v);
      }
    }
    channels.set(name.trim().toLowerCase(), comps);
  }
  return schemeFromChannels(channels);
}
