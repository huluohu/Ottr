// gallery.ts（Phase 2 Task 9，B2 主题生态）：内置终端配色画廊 + 自定义主题类型。
//
// 模型：终端配色与**界面明暗**（ThemeContext light/dark）解耦——
//   * selectionId = "auto"（缺省）：跟随界面解析结果取 terminalThemes[resolved]
//     （T1 语义原样，见 terminal-themes.ts）；
//   * selectionId = 内置画廊 id 或自定义 id：无论界面明暗，终端固定用该配色。
// 自定义主题（iTerm2/Windows Terminal 导入）持久化 vault settings 键
// `ui.terminalTheme`（明文面，{ selection, custom } 一体 JSON；读写见
// terminalThemeStore.ts）。品牌双主题不在此重复定义——引用 terminal-themes.ts
// 单一事实源，保证「auto 的 dark」与画廊里的「Ottr Dark」永不漂移。
//
// ANSI 16 色纪律：内置画廊每套都是完整 16 色 + fg/bg/cursor/selection 通道
// （gallery.test.ts 逐套核对，缺通道测试必红）——xterm 对缺省通道回落默认值，
// 半套配色在亮暗切换时会露出系统默认色，宁可在这里写全。
import type { ITheme } from "@xterm/xterm";
import { darkTerminalTheme, lightTerminalTheme } from "./terminal-themes";

/** 终端配色主题定义（内置画廊与自定义导入共用形态）。 */
export interface TerminalThemeDef {
  /** 稳定 id：内置 = 常量；自定义 = `custom-<ts>-<n>`（terminalThemeStore 生成）。 */
  id: string;
  /** 展示名。配色名（Dracula/Solarized…）是专有名词，**不作 i18n**。 */
  name: string;
  /** 配色自身明暗（按背景亮度判定；auto 提示与 UI 徽标用）。 */
  dark: boolean;
  theme: ITheme;
}

/** 背景色相对亮度 → 明暗判定（WCAG 亮度，阈值 0.5；导入器同口径）。 */
export function isDarkBackground(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return true;
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((i) => f(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** Dracula（官方 dracula.itermcolors 全 16 色）。 */
const dracula: ITheme = {
  foreground: "#f8f8f2",
  background: "#282a36",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

/** Nord（官方 nord.itermcolors 全 16 色；bright 系 9-14 与 normal 同值是官方原样）。 */
const nord: ITheme = {
  foreground: "#eceff4",
  background: "#2e3440",
  cursor: "#d8dee9",
  cursorAccent: "#2e3440",
  selectionBackground: "#434c5e",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#88c0d0",
  brightWhite: "#eceff4",
};

/** Solarized Dark（Windows Terminal 官方 scheme 全 16 色：bright 9-13 = 色相扩展档）。 */
const solarizedDark: ITheme = {
  foreground: "#839496",
  background: "#002b36",
  cursor: "#93a1a1",
  cursorAccent: "#002b36",
  selectionBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

/** Solarized Light（同源亮色版：black/white 互换 base2/base3，bright 尾 = base3/03）。 */
const solarizedLight: ITheme = {
  foreground: "#657b83",
  background: "#fdf6e3",
  cursor: "#657b83",
  cursorAccent: "#fdf6e3",
  selectionBackground: "#eee8d5",
  black: "#eee8d5",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#073642",
  brightBlack: "#fdf6e3",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#002b36",
};

/** One Dark（Atom One Dark 终端口径全 16 色）。 */
const oneDark: ITheme = {
  foreground: "#abb2bf",
  background: "#282c34",
  cursor: "#528bff",
  cursorAccent: "#282c34",
  selectionBackground: "#3e4451",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

/** GitHub Light（Primer GitHub Light 终端 ANSI 全 16 色）。 */
const githubLight: ITheme = {
  foreground: "#24292f",
  background: "#ffffff",
  cursor: "#24292f",
  cursorAccent: "#ffffff",
  selectionBackground: "#0366d644",
  black: "#24292e",
  red: "#d73a49",
  green: "#28a745",
  yellow: "#dbab09",
  blue: "#0366d6",
  magenta: "#b392f0",
  cyan: "#1b7c83",
  white: "#6a737d",
  brightBlack: "#959da5",
  brightRed: "#cb2431",
  brightGreen: "#22863a",
  brightYellow: "#b08800",
  brightBlue: "#005cc5",
  brightMagenta: "#5a32a3",
  brightCyan: "#3192aa",
  brightWhite: "#d1d5da",
};

/** auto 选择键（跟随界面亮暗，见文件头模型）。 */
export const AUTO_TERMINAL_THEME_ID = "auto";

/** 内置画廊（简报 8 套：品牌双主题 + Dracula/Nord/Solarized 系 + One Dark/GitHub Light）。 */
export const TERMINAL_THEME_GALLERY: TerminalThemeDef[] = [
  { id: "ottr-light", name: "Ottr Light", dark: false, theme: lightTerminalTheme },
  { id: "ottr-dark", name: "Ottr Dark", dark: true, theme: darkTerminalTheme },
  { id: "dracula", name: "Dracula", dark: true, theme: dracula },
  { id: "nord", name: "Nord", dark: true, theme: nord },
  { id: "solarized-dark", name: "Solarized Dark", dark: true, theme: solarizedDark },
  { id: "solarized-light", name: "Solarized Light", dark: false, theme: solarizedLight },
  { id: "one-dark", name: "One Dark", dark: true, theme: oneDark },
  { id: "github-light", name: "GitHub Light", dark: false, theme: githubLight },
];

/** id → 内置主题定义（自定义不在内；查自定义走 store.custom）。 */
export function findGalleryTheme(id: string): TerminalThemeDef | undefined {
  return TERMINAL_THEME_GALLERY.find((t) => t.id === id);
}
