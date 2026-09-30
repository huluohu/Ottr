// ThemeContext（A10，Task 1 产出；T11 接 vault settings）：
// mode 三态 light/dark/system；system 跟随 `prefers-color-scheme`（matchMedia），
// 并叠加 Tauri 侧 `ottr://system-theme` 事件兜底（Linux WebKitGTK 明暗动态跟随
// 不可靠，src-tauri lib.rs 监听 WindowEvent::ThemeChanged 后推送）。
// 解析结果挂 `<html data-theme="light|dark">`，tokens.css 按 [data-theme] 出两套语义层。
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

export type ThemeMode = "light" | "dark" | "system";
/** 解析后的实际主题（data-theme 属性值 / terminalThemes 键）。 */
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "ottr.settings.theme";
const SETTING_KEY = "ui.theme"; // vault settings 键（T11 迁移目标，明文面锁定可读）
const SYSTEM_THEME_EVENT = "ottr://system-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** localStorage 仅作启动缓存镜像（T11 前曾是唯一持久化；vault settings 迁移后
 * 职责降级为防首帧闪烁的缓存），真源 = vault settings。 */
function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage 不可用（隐私模式等）→ 默认跟随系统
  }
  return "system";
}

/** 写真源（vault settings）+ 缓存镜像。vault 写失败不阻塞切换（会话内仍生效，
 * 重启后回落缓存/默认）。 */
function persistMode(mode: ThemeMode): void {
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
 * 1. vault 有值 → 以 vault 为准（修 localStorage 陈旧缓存）；
 * 2. vault 无值 + localStorage 有值 → 迁移：写 vault、清 localStorage 键；
 * 3. 两边皆无 → 不动（默认 system）。 */
export async function syncThemeFromVault(): Promise<void> {
  const { vaultApi } = await import("../vault/api");
  let stored: string | null = null;
  try {
    stored = await vaultApi.settings.get<string>(SETTING_KEY);
  } catch {
    return; // 后端不可达：维持现状
  }
  if (stored === "light" || stored === "dark" || stored === "system") {
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
  if (cached === "light" || cached === "dark" || cached === "system") {
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

  // T11：注册 vault 值应用回调（syncThemeFromVault 用）+ 首挂后同步真源。
  // 应用 vault 值时同步刷新缓存镜像（真源变更后镜像不得停留在旧值）。
  useEffect(() => {
    modeApplier = (m) => {
      setModeState(m);
      try {
        localStorage.setItem(THEME_KEY, m);
      } catch {
        // 缓存失败不阻塞真源对齐
      }
    };
    void syncThemeFromVault();
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

  const resolved: ResolvedTheme =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  // data-theme 挂 root：CSS 语义层切换的唯一开关（tokens.css [data-theme="dark"]）。
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

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
