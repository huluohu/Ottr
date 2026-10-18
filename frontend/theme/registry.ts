// theme/registry.ts（2026-10-18 主题注册表单源化）：界面主题的单一事实表——
// id + 明暗归属（+序）。此前主题 id 清单在 5 处重复（THEME_IDS/THEME_CYCLE/
// THEME_CHOICES/⌘K 外观组/Rust 镜像），新增主题漏插其一即「清單漂移」bug
// （forest 曾在三处被漏、THEME_IDS 漏插致松涛无法持久化）。此后：
//   * 前端一切清单 = 本表派生（THEME_IDS = THEMES.map(id)）；
//   * 亮暗二级解析（resolveMode）按 scheme 派生，不再手写 switch；
//   * Rust 侧 menu.rs THEME_IDS 为跨语言独立单源（镜像测试钉死同步），
//     子菜单 Check 节点由它循环生成；
//   * i18n 键 settings.themes.<id> 与 theme.set.<id> 动作字面量随 id 规约。
// 序 = 设置网格/快切菜单/原生菜单的展示序：「跟随系统」恒首位，其余按
// 水域家族光量降序（2026-10-18 续编：亮族 sepia 排 verdant 后；暗族 ember/
// forest 排 oled 后、amethyst/glass 仍殿后）。
import type { ThemeMode } from "./ThemeContext";

export type ThemeScheme = "light" | "dark";

export interface ThemeDef {
  id: ThemeMode;
  /** 明暗归属（二级解析的唯一事实；system 档不在本表——跟随系统动态解析）。 */
  scheme: ThemeScheme;
}

/** 具体（非 system）主题注册表，序 = 展示序。新增主题只改本表 + tokens.css
 * 块 + i18n 两键（+可选终端色板），其余消费面全部派生。 */
export const THEMES: readonly ThemeDef[] = [
  { id: "light", scheme: "light" }, // 浅滩
  { id: "verdant", scheme: "light" }, // 溪岸
  { id: "sepia", scheme: "light" }, // 沙洲
  { id: "dark", scheme: "dark" }, // 深河
  { id: "oled", scheme: "dark" }, // 深渊
  { id: "ember", scheme: "dark" }, // 河灯
  { id: "forest", scheme: "dark" }, // 松涛
  { id: "amethyst", scheme: "dark" }, // 夜光河
  { id: "glass", scheme: "dark" }, // 雨窗
];

/** 具体主题 id（非 system）。 */
export type ConcreteThemeId = (typeof THEMES)[number]["id"];

/** 展示序全集（system 首位 + 注册表序）——快切菜单/设置网格/⌘K 外观组/
 * 原生菜单共用的唯一清单。 */
export const THEME_ORDER: readonly ThemeMode[] = ["system", ...THEMES.map((t) => t.id)];

/** id → 明暗（注册表查表；未知 id（理论不可达）按暗收敛——遮罩优于裸奔）。 */
export function themeSchemeOf(id: ThemeMode): ThemeScheme | "system" {
  if (id === "system") return "system";
  return THEMES.find((t) => t.id === id)?.scheme ?? "dark";
}
