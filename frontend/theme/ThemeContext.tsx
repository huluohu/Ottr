// ThemeContext（A10，Task 1 产出；T11 接 vault settings；theme-suite T2 多主题）：
// mode 七态 light/dark/system/oled/amethyst/verdant/glass；system 跟随
// `prefers-color-scheme`（matchMedia），并叠加 Tauri 侧 `ottr://system-theme`
// 事件兜底（Linux WebKitGTK 明暗动态跟随不可靠，desktop lib.rs 监听
// WindowEvent::ThemeChanged 后推送）。
// 二级解析：resolved: light|dark —— oled/amethyst/glass 为暗底系、verdant 亮底、
// system 跟随系统；color-scheme 沿 resolved（tokens.css 各块自带声明）。
// 解析结果挂 `<html data-theme="…">`：**主题 id 本身**（system 挂 resolved 亮/暗
// ——CSS 语义层按 id 出块，tokens.css [data-theme="…"]）。
// 持久化（T11 迁移完成）：真源 = vault settings `ui.theme`（明文面，锁定可读）；
// localStorage 降级为启动缓存镜像（防首帧闪烁）+ 一次性迁移源（syncThemeFromVault）。
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";

export type ThemeMode =
  | "light"
  | "dark"
  | "system"
  | "oled"
  | "amethyst"
  | "verdant"
  | "glass";
/** 解析后的实际明暗（二级解析结果；terminal 旧亮暗链与 color-scheme 共用）。 */
export type ResolvedTheme = "light" | "dark";

/** 主题 id 全集（theme-suite T2）。白名单单一来源——load/persist/syncThemeFromVault
 * 三处共用 isThemeId，新增主题只改这里；顶栏快切菜单（App ThemeMenu）与设置页
 * 主题网格同消费本全集（2026-10-08 用户口径：快切菜单必须同步全部主题）。 */
export const THEME_IDS: readonly ThemeMode[] = [
  "light",
  "dark",
  "system",
  "oled",
  "amethyst",
  "verdant",
  "glass",
];

function isThemeId(v: string | null | undefined): v is ThemeMode {
  return v != null && (THEME_IDS as readonly string[]).includes(v);
}

/** 二级解析：主题 id → 亮/暗。oled/amethyst/glass 暗底系；verdant 亮底；
 * system 跟随 prefers-color-scheme。 */
function resolveMode(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  switch (mode) {
    case "light":
    case "verdant":
      return "light";
    case "dark":
    case "oled":
    case "amethyst":
    case "glass":
      return "dark";
    case "system":
      return systemDark ? "dark" : "light";
  }
}

/** 终端 auto 色板键（theme-suite T2.3，terminalThemeStore 消费）：具体主题 id
 * 直取配套色板；system 摊平为解析后的亮/暗（无「系统」终端配色）。 */
export function terminalPaletteKey(mode: ThemeMode, resolved: ResolvedTheme): TerminalPaletteKeySource {
  return mode === "system" ? resolved : mode;
}

/** terminalPaletteKey 的返回（= terminalThemeStore.TerminalPaletteKey；此处
 * 字面量并集避免模块环 import）。 */
type TerminalPaletteKeySource = "light" | "dark" | "oled" | "amethyst" | "verdant" | "glass";

const THEME_KEY = "ottr.settings.theme";
const SETTING_KEY = "ui.theme"; // vault settings 键（T11 迁移目标，明文面锁定可读）
const SYSTEM_THEME_EVENT = "ottr://system-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** localStorage 仅作启动缓存镜像（T11 前曾是唯一持久化；vault settings 迁移后
 * 职责降级为防首帧闪烁的缓存），真源 = vault settings。 */
function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeId(v)) return v;
  } catch {
    // localStorage 不可用（隐私模式等）→ 默认跟随系统
  }
  return "system";
}

/** 写真源（vault settings）+ 缓存镜像。vault 写失败不阻塞切换（会话内仍生效，
 * 重启后回落缓存/默认）。白名单拒写未知值（防脏数据进持久化面）。 */
function persistMode(mode: ThemeMode): void {
  if (!isThemeId(mode)) return;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // 缓存失败不阻塞
  }
  void import("../vault/api")
    .then(({ vaultApi }) => vaultApi.settings.set(SETTING_KEY, mode))
    .catch(() => {
      // 非 Tauri 环境（纯浏览器 dev / vitest 无 mock）：镜像已是持久化面
    });
}

/** T11 迁移 + 真源对齐（App 挂载后调用一次）：
 * 1. vault 有值（白名单内）→ 以 vault 为准（修 localStorage 陈旧缓存）；
 * 2. vault 无值 + localStorage 有值（白名单内）→ 迁移：写 vault、清 localStorage 键；
 * 3. 两边皆无/皆不在白名单 → 不动（默认 system）。 */
export async function syncThemeFromVault(): Promise<void> {
  const { vaultApi } = await import("../vault/api");
  let stored: string | null = null;
  try {
    stored = await vaultApi.settings.get<string>(SETTING_KEY);
  } catch {
    return; // 后端不可达：维持现状
  }
  if (isThemeId(stored)) {
    if (stored !== loadMode()) {
      useThemeSyncApply(stored);
    }
    return;
  }
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(THEME_KEY);
  } catch {
    return;
  }
  if (isThemeId(cached)) {
    // vault 未配置 → 把 localStorage 值迁入，迁完清缓存键。
    try {
      await vaultApi.settings.set(SETTING_KEY, cached);
      localStorage.removeItem(THEME_KEY);
    } catch {
      // 迁移失败下次再试（localStorage 键保留即迁移未完成的标记）
    }
  }
}

/** vault 值的应用回调（ThemeProvider 挂载时注册；避免本模块反向依赖 React 状态）。 */
let modeApplier: ((m: ThemeMode) => void) | null = null;
function useThemeSyncApply(m: ThemeMode): void {
  modeApplier?.(m);
}

function systemPrefersDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

// theme-suite T3：平台标记（一次性，挂 `<html data-platform>`）。Glass 主题在
// Linux（WebKitGTK）无系统模糊面（window-vibrancy 不支持），CSS 用
// [data-theme="glass"][data-platform="linux"] 把 bg alpha 提到近实底兜底；
// 其余平台挂 "other"（CSS 不命中）。判据 = userAgent（Android 是 Linux 内核
// 但不按桌面 Linux 口径）。jsdom / 纯浏览器 dev 同样可得值。
function detectPlatform(): "linux" | "other" {
  const ua = navigator.userAgent;
  return /linux/i.test(ua) && !/android/i.test(ua) ? "linux" : "other";
}

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** mode=system 时的解析结果；手动模式等于 mode 本身。 */
  resolved: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(loadMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // T11：注册 vault 值应用回调（syncThemeFromVault 用）。T17 F1：挂载时的
  // syncThemeFromVault 挪进 App 就绪门（VaultInitGate ready 后，与 syncLangFromVault
  // 同点）——挂载期 vault State 尚未 manage，settings_get 被拒即静默降级 localStorage
  // 缓存，vault 真源主题在重启会话后丢失。应用 vault 值时同步刷新缓存镜像。
  useEffect(() => {
    modeApplier = (m) => {
      setModeState(m);
      try {
        localStorage.setItem(THEME_KEY, m);
      } catch {
        // 缓存失败不阻塞真源对齐
      }
    };
    return () => {
      modeApplier = null;
    };
  }, []);

  // 系统明暗变化（matchMedia 主通道）：常驻监听，切回 system 模式时无需重新对表。
  useEffect(() => {
    const mq = window.matchMedia(MEDIA_QUERY);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Tauri 兜底通道：仅 system 模式订阅（手动模式系统变化不影响显示）。
  useEffect(() => {
    if (mode !== "system" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listen<string>(SYSTEM_THEME_EVENT, (e) => {
          setSystemDark(e.payload === "dark");
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        // 非 Tauri 环境（纯浏览器 dev / vitest）：静默降级为仅 matchMedia
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mode]);

  const resolved: ResolvedTheme = resolveMode(mode, systemDark);

  // data-theme 挂 root：CSS 语义层切换的唯一开关（tokens.css [data-theme="…"]）。
  // 挂主题 id 本身（多主题各出块）；system 无自有块 → 挂 resolved 亮/暗命中旧两块。
  useEffect(() => {
    document.documentElement.dataset.theme = mode === "system" ? resolved : mode;
  }, [mode, resolved]);

  // data-platform 挂 root（theme-suite T3，一次性）：Glass 的 Linux 兜底 CSS 面。
  useEffect(() => {
    document.documentElement.dataset.platform = detectPlatform();
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      setMode: (m) => {
        setModeState(m);
        persistMode(m); // vault 真源 + localStorage 缓存镜像（T11 迁移完成态）
      },
    }),
    [mode, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Task 2/8/10 消费入口：{ mode, setMode }（简报接口），附 resolved 供终端主题取用。 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
