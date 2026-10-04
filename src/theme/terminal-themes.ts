// terminal-themes.ts（A10，Task 1 产出；Task 5/6/8 消费）：
// xterm.js ITheme 亮/暗两套。ANSI 16 色按 brand/brand.md 映射：
//   normal 色取品牌同色系低饱和值（red→#D97066 系、green→teal 系、
//   yellow→amber 系、blue→水色系），bright 取同色相高饱和值；
//   fg=--ottr-cream-100 偏暖白、bg=--ottr-water-900（暗色）。
// 品牌色未覆盖的通道（magenta/cyan/白系）取相邻色相的低饱和值保持整体协调。
// 生产环境主机红色边框（B11）复用 brightRed（brand.md 备注）。
import type { ITheme } from "@xterm/xterm";

/** 亮色 ANSI：亮底（暖纸白）上取深值保证可读；bright 取品牌本色。
 * ui-batch3 T1（审计 A3）校准：bright 六色原取暗色高饱和值直接换算，作
 * 前景对 #faf7f1 仅 2.01–3.33（brightRed/brightGreen/brightYellow/brightBlue/
 * brightMagenta/brightCyan）——沿本文件 brightWhite 既有先例（亮底主题
 * bright 变体为可读性让位，One Light 惯例）全部改深档同色相，≥4.5：
 * #c0392b 5.09 / #0c8073 4.51 / #a16207 4.60 / #2273a8 4.81 / #a8458f 5.02 /
 * #0a6880 5.94（与各自 normal 槽仍可区分）。 */
const LIGHT_ANSI = {
  black: "#0f172a", // ink-900
  red: "#b34a42",
  green: "#0f766e", // teal-700
  yellow: "#b45309", // amber-700
  blue: "#1d6fa5", // 水色系深
  magenta: "#9d4e82",
  cyan: "#0e7490",
  white: "#5a6b70",
  brightBlack: "#46626b",
  brightRed: "#c0392b", // A3 校准（原 #d97066 3.04）
  brightGreen: "#0c8073", // A3 校准（原 teal-500 2.33）
  brightYellow: "#a16207", // A3 校准（原 amber-500 2.01）
  brightBlue: "#2273a8", // A3 校准（原 #2b8fcc 3.33）
  brightMagenta: "#a8458f", // A3 校准（原 #c586c0 2.60）
  brightCyan: "#0a6880", // A3 校准（原 #22b8cd 2.23）
  brightWhite: "#3d5560", // 亮底主题 brightWhite 取深色（One Light 惯例），保证作为前景可读
} as const;

/** 暗色 ANSI：water-900 底上 normal 低饱和、bright 同色相高饱和（brand.md 规则）。 */
const DARK_ANSI = {
  black: "#08222a",
  red: "#d97066",
  green: "#14b8a6",
  yellow: "#f59e0b",
  blue: "#56a8c8",
  magenta: "#c586c0",
  cyan: "#4fc4cf",
  white: "#c8d6d9",
  brightBlack: "#3a5a63",
  brightRed: "#ff9187",
  brightGreen: "#5eead4", // teal-300
  brightYellow: "#fbbf24", // amber-400
  brightBlue: "#8ccbe4",
  brightMagenta: "#e5a4dc",
  brightCyan: "#7fdce4",
  brightWhite: "#f6e7d4", // cream-100
} as const;

/** 暗色（默认）：fg=cream-100 偏暖白，bg=water-900（brand.md 终端默认主题映射）。 */
export const darkTerminalTheme: ITheme = {
  foreground: "#f6e7d4",
  background: "#0b2b33",
  cursor: "#5eead4", // teal-300
  cursorAccent: "#0b2b33",
  selectionBackground: "#14b8a666", // teal-500 @40%
  ...DARK_ANSI,
};

/** 亮色：bg=暖纸白（tokens.css --color-bg 同源），fg=ink-900。 */
export const lightTerminalTheme: ITheme = {
  foreground: "#0f172a",
  background: "#faf7f1",
  cursor: "#0f766e", // teal-700
  cursorAccent: "#faf7f1",
  selectionBackground: "#0f766e44",
  ...LIGHT_ANSI,
};

/** 简报接口：terminalThemes: { light, dark }。键 = ResolvedTheme。 */
export const terminalThemes: Record<"light" | "dark", ITheme> = {
  light: lightTerminalTheme,
  dark: darkTerminalTheme,
};
