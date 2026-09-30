// ThemeContext（A10，Task 1 产出）：
// mode 三态 light/dark/system；system 跟随 `prefers-color-scheme`（matchMedia），
// 并叠加 Tauri 侧 `ottr://system-theme` 事件兜底（Linux WebKitGTK 明暗动态跟随
// 不可靠，src-tauri lib.rs 监听 WindowEvent::ThemeChanged 后推送）。
// 解析结果挂 `<html data-theme="light|dark">`，tokens.css 按 [data-theme] 出两套语义层。
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
const SYSTEM_THEME_EVENT = "ottr://system-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** 持久化迁移点（Task 4）：settings 表落地后改走 vault，localStorage 仅过渡。 */
function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage 不可用（隐私模式等）→ 默认跟随系统
  }
  return "system";
}

function saveMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // 同上：持久化失败不阻塞会话
  }
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
        saveMode(m); // 持久化（Task 4 迁移点，见 THEME_KEY 注释）
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
