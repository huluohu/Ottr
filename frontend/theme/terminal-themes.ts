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

// ---------------------------------------------------------------------------
// 主题配套终端色板（theme-suite T2.3）：oled/amethyst/verdant/glass 四套。
// 纪律同上（16 色 + fg/bg/cursor/selection 全通道；tokens.test 终端色板组逐套
// 实算核对）：
//   * 暗底口径（oled/amethyst/glass）：14 槽 ≥4.5，black/brightBlack 豁免
//    （背景族——既有 dark 槽实算 1.11/2.03 本就不可达 4.5，只要求与底可区分）；
//   * 亮底口径（verdant，bg #F4F7F1 同 light 暖纸白档）：16 槽全 ≥4.5、光标 ≥3；
//   * glass 底为 rgba 半透明（xterm 背景支持 rgba，主题玻璃面透出），对比度按
//     合成参考桌面底 #1C2430 实算（与 tokens.test REF_DESKTOP 同一假设）。
// ---------------------------------------------------------------------------

/** 配套色板的四主题 id（= ThemeMode 新增四态；auto 解析键）。 */
export type ThemedTerminalPaletteId = "oled" | "amethyst" | "verdant" | "glass";

/** OLED：纯黑底（省电屏），ANSI 全亮档；fg=E5E7EB（简报钉死）。 */
export const oledTerminalTheme: ITheme = {
  foreground: "#e5e7eb",
  background: "#000000",
  cursor: "#5eead4",
  cursorAccent: "#000000",
  selectionBackground: "#5eead466",
  black: "#2a3038",
  red: "#ff6b6b",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#e879f9",
  cyan: "#22d3ee",
  white: "#c9ced6",
  brightBlack: "#565e6b",
  brightRed: "#ff9b9b",
  brightGreen: "#6ee7b7",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#67e8f9",
  brightWhite: "#f3f4f6",
};

/** Amethyst：紫调暗底（bg #16102E），ANSI 走紫邻色相；fg/accent 同界面令牌。 */
export const amethystTerminalTheme: ITheme = {
  foreground: "#e9e4f9",
  background: "#16102e",
  cursor: "#a78bfa",
  cursorAccent: "#16102e",
  selectionBackground: "#a78bfa66",
  black: "#241c40",
  red: "#e36f94",
  green: "#3fc98c",
  yellow: "#e8b45a",
  blue: "#8fa8f0",
  magenta: "#c084fc",
  cyan: "#56b6d9",
  white: "#c8c2de",
  brightBlack: "#564b7e",
  brightRed: "#ff8fac",
  brightGreen: "#6fe0ac",
  brightYellow: "#f6ce7e",
  brightBlue: "#b4c4f7",
  brightMagenta: "#d8b4fe",
  brightCyan: "#8ad5ec",
  brightWhite: "#efebfa",
};

/** Verdant：鼠尾草亮底（bg #F4F7F1 同界面令牌），LIGHT_ANSI 同款深档纪律
 *（亮底 bright 变体取深），green/yellow 系偏鼠尾草色相。 */
export const verdantTerminalTheme: ITheme = {
  foreground: "#1c2b22",
  background: "#f4f7f1",
  cursor: "#2f855a",
  cursorAccent: "#f4f7f1",
  selectionBackground: "#2f855a44",
  black: "#14201a",
  red: "#a8433b",
  green: "#256b49",
  yellow: "#8f4a09",
  blue: "#1a5f8e",
  magenta: "#8a4276",
  cyan: "#0c647c",
  white: "#4f6157",
  brightBlack: "#3d5749",
  brightRed: "#a83226",
  brightGreen: "#0b7a6c", /* 原档 #0c8073 对 #F4F7F1 4.46 不够，加深一档 4.84 */
  brightYellow: "#8a6006",
  brightBlue: "#1c6494",
  brightMagenta: "#8f3b80",
  brightCyan: "#0a5c74",
  brightWhite: "#33473c",
};

/** Glass：半透明底（rgba——xterm 背景支持），对比度按合成参考桌面底 #1C2430
 * 实算（tokens.test 同一假设）；冷调 ANSI，选中/光标走冰蓝。 */
export const glassTerminalTheme: ITheme = {
  foreground: "#e6edf3",
  background: "rgba(16, 20, 32, 0.62)", /* 合成 #1C2430 后 ≈ #151a26，各槽实算基于此 */
  cursor: "#93c5fd",
  cursorAccent: "#101420",
  selectionBackground: "rgba(125, 211, 252, 0.32)",
  black: "#222a3a",
  red: "#e3707e",
  green: "#3ecf8e",
  yellow: "#e5b567",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c4cbd8",
  brightBlack: "#4e5a70",
  brightRed: "#ff9aa5",
  brightGreen: "#73e0ac",
  brightYellow: "#f0c987",
  brightBlue: "#9fc0ff",
  brightMagenta: "#d2b8fc",
  brightCyan: "#a4e0f8",
  brightWhite: "#eceff5",
};

/** 主题 id → 配套终端色板（auto 解析表；terminalThemeStore 消费）。 */
export const themeTerminalThemes: Record<ThemedTerminalPaletteId, ITheme> = {
  oled: oledTerminalTheme,
  amethyst: amethystTerminalTheme,
  verdant: verdantTerminalTheme,
  glass: glassTerminalTheme,
};
