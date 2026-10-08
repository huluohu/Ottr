// terminalThemeStore.ts（Phase 2 Task 9，B2 主题生态）：终端配色选择的持久化面。
//
// 真源 = vault settings 键 `ui.terminalTheme`（明文面，锁定可读——设置页在
// 锁定态也要能换配色）：
//     { "selection": "auto" | 主题 id, "custom": TerminalThemeDef[] }
// localStorage 键 `ottr.settings.terminalTheme` 降级为启动缓存镜像（防首帧闪
// 非默认配色）+ vault 不可用时的一次性迁移源（syncFromVault 对齐，同
// ThemeContext / i18n 的迁移三段式惯例）。
//
// 消费面：SessionTerminal 主题 effect 订阅本 store（selection/custom 变化即
// 重跑），applyTermTheme 经 resolveTerminalTheme 出最终 ITheme。
import { create } from "zustand";
import {
  AUTO_TERMINAL_THEME_ID,
  findGalleryTheme,
  type TerminalThemeDef,
} from "./gallery";
import type { ResolvedTheme } from "./ThemeContext";
import { terminalThemes, themeTerminalThemes, type ThemedTerminalPaletteId } from "./terminal-themes";
import type { ITheme } from "@xterm/xterm";

const SETTING_KEY = "ui.terminalTheme"; // vault settings 键（JSON 一体面）
const CACHE_KEY = "ottr.settings.terminalTheme"; // localStorage 缓存镜像键

/** auto 色板键（theme-suite T2.3）：界面主题 id 直取配套色板；system 模式由
 * ThemeContext 的 terminalPaletteKey 摊平为解析后的亮/暗——故本键集恒不含
 * "system"。旧 light/dark 调用点（含既有测试）不受影响。 */
export type TerminalPaletteKey = ResolvedTheme | ThemedTerminalPaletteId;

/** auto 色板映射：light/dark 沿用旧亮暗两套（同引用不漂移），四主题取配套。 */
const AUTO_PALETTES: Record<TerminalPaletteKey, ITheme> = {
  light: terminalThemes.light,
  dark: terminalThemes.dark,
  ...themeTerminalThemes,
};

/** settings 值形态（读写同构；损坏按缺省收）。 */
export interface TerminalThemeSetting {
  selection: string;
  custom: TerminalThemeDef[];
}

function sanitize(raw: unknown): TerminalThemeSetting | null {
  if (!raw || typeof raw !== "object") return null;
  const { selection, custom } = raw as Partial<TerminalThemeSetting>;
  if (typeof selection !== "string") return null;
  if (!Array.isArray(custom)) return { selection, custom: [] };
  // 防脏数据进 xterm：缺 id/name/theme 的条目剔除（vault 是用户数据面）。
  return {
    selection,
    custom: custom.filter(
      (t): t is TerminalThemeDef =>
        !!t && typeof t.id === "string" && typeof t.name === "string" && !!t.theme,
    ),
  };
}

function readCache(): TerminalThemeSetting | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCache(state: TerminalThemeSetting): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // 缓存失败不阻塞（会话内仍生效）
  }
}

async function persist(state: TerminalThemeSetting): Promise<void> {
  writeCache(state);
  try {
    const { vaultApi } = await import("../vault/api");
    await vaultApi.settings.set(SETTING_KEY, state);
  } catch {
    // 非 Tauri 环境（纯浏览器 dev / vitest 无 mock）：缓存镜像已是持久化面
  }
}

export function resolveTerminalTheme(
  paletteKey: TerminalPaletteKey,
  setting: TerminalThemeSetting,
): ITheme {
  if (setting.selection === AUTO_TERMINAL_THEME_ID) {
    // auto：跟随界面主题 id 取配套色板（terminalThemes/themeTerminalThemes 单源）；
    // 穷尽联合下 ?? 不可达（运行时脏值兜底回落暗色套）。
    return AUTO_PALETTES[paletteKey] ?? terminalThemes.dark;
  }
  const custom = setting.custom.find((t) => t.id === setting.selection);
  if (custom) return custom.theme;
  const gallery = findGalleryTheme(setting.selection);
  if (gallery) return gallery.theme;
  return AUTO_PALETTES[paletteKey] ?? terminalThemes.dark; // 未知 id（主题被删/降级）→ auto 兜底
}

interface TerminalThemeStore {
  selection: string;
  custom: TerminalThemeDef[];
  /** sync 完成过一次（App 就绪门后调用；防闪烁缓存先行、vault 到达后覆盖）。 */
  synced: boolean;
  /** vault 真源对齐/迁移（App 挂载就绪后调用一次，同 syncThemeFromVault 惯例）。 */
  syncFromVault: () => Promise<void>;
  /** 选择主题（auto / 内置 id / 自定义 id）；vault 写失败不阻塞切换。 */
  select: (id: string) => void;
  /** 注册自定义主题（同名覆盖——重复导入同一配色文件幂等）并选中它。 */
  addCustom: (def: TerminalThemeDef) => void;
  /** 删除自定义主题；删的是当前选中 → 回 auto。 */
  removeCustom: (id: string) => void;
}

export const useTerminalThemeStore = create<TerminalThemeStore>((set, get) => ({
  selection: AUTO_TERMINAL_THEME_ID,
  custom: [],
  synced: false,

  syncFromVault: async () => {
    try {
      const { vaultApi } = await import("../vault/api");
      const raw = await vaultApi.settings.get<unknown>(SETTING_KEY);
      const fromVault = sanitize(raw);
      if (fromVault) {
        set({ selection: fromVault.selection, custom: fromVault.custom, synced: true });
        writeCache(fromVault); // 刷新缓存镜像（vault 是真源）
        return;
      }
      // vault 无值 + 缓存有值 → 迁移：写 vault（缓存保留为镜像）。
      const cached = readCache();
      if (cached) {
        set({ selection: cached.selection, custom: cached.custom, synced: true });
        void persist(cached);
        return;
      }
      set({ synced: true });
    } catch {
      set({ synced: true }); // 后端不可达：维持缓存/默认（下次启动再试）
    }
  },

  select: (id) => {
    set({ selection: id });
    void persist({ selection: get().selection, custom: get().custom });
  },

  addCustom: (def) => {
    const custom = [...get().custom.filter((t) => t.name !== def.name), def];
    set({ selection: def.id, custom });
    void persist({ selection: def.id, custom });
  },

  removeCustom: (id) => {
    const custom = get().custom.filter((t) => t.id !== id);
    const selection = get().selection === id ? AUTO_TERMINAL_THEME_ID : get().selection;
    set({ selection, custom });
    void persist({ selection, custom });
  },
}))

/** 测试隔离：清回缺省（vitest 各用例间 store 状态泄漏防线）。 */
export function resetTerminalThemeStoreForTest(): void {
  useTerminalThemeStore.setState({
    selection: AUTO_TERMINAL_THEME_ID,
    custom: [],
    synced: false,
  });
}
