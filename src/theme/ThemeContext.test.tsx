// A10（Task 1 Step 4）：ThemeContext 行为测试——mode 切换改 data-theme、
// system 模式跟随 mock matchMedia、localStorage 持久化与恢复。
// Tauri 事件兜底在纯浏览器环境（jsdom 无 __TAURI_INTERNALS__）自动跳过，只测 matchMedia 主通道。
// T11（A7）：持久化真源迁 vault settings（ui.theme）——localStorage 降级为启动
// 缓存镜像；迁移（vault 空时从 localStorage 迁入并清键）与真源对齐（vault 值
// 纠正陈旧缓存）有专项用例。invoke mock = 内存 settings 表（行为贴近真后端）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  ThemeProvider,
  useTheme,
  syncThemeFromVault,
  type ThemeMode,
} from "./ThemeContext";
import { themeTerminalThemes, terminalThemes } from "./terminal-themes";
import { resolveTerminalTheme } from "./terminalThemeStore";

const mockedInvoke = invoke as unknown as Mock;
const settingsStore = new Map<string, unknown>();

// --- 可控 matchMedia 模拟（jsdom 不实现 prefers-color-scheme 动态切换） ---
type Listener = (e: { matches: boolean }) => void;
let mqListeners: Set<Listener>;
let mqMatches: boolean;

function installMatchMedia(initialDark: boolean) {
  mqMatches = initialDark;
  mqListeners = new Set();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: mqMatches,
      media: query,
      addEventListener: (_type: string, cb: Listener) => mqListeners.add(cb),
      removeEventListener: (_type: string, cb: Listener) => mqListeners.delete(cb),
    })),
  );
}

/** 模拟操作系统明暗切换：更新 matches 并派发 change 事件。 */
function flipSystem(dark: boolean) {
  mqMatches = dark;
  for (const cb of [...mqListeners]) cb({ matches: dark });
}

function Probe() {
  const { mode, setMode, resolved } = useTheme();
  const ids: ThemeMode[] = ["oled", "amethyst", "verdant", "glass"];
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setMode("light")}>set-light</button>
      <button onClick={() => setMode("dark")}>set-dark</button>
      {ids.map((id) => (
        <button key={id} onClick={() => setMode(id)}>
          set-{id}
        </button>
      ))}
    </div>
  );
}

const dataTheme = () => document.documentElement.dataset.theme;
const renderThemed = () =>
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );

beforeEach(async () => {
  localStorage.clear();
  settingsStore.clear();
  // T17 F1：预热 persistMode 的动态 import（模块转换有真实 I/O 延迟，冷缓存时
  // 其浮动 promise 会滞留到后续用例，污染 vault 前置态）；预热后微任务级落定。
  await import("../vault/api");
  // 内存 settings 表（settings_get/set 契约面；其余命令显式失败防误用）
  mockedInvoke.mockImplementation((cmd: string, args?: { key: string; value: unknown }) => {
    if (cmd === "settings_get") {
      return Promise.resolve(settingsStore.has(args!.key) ? settingsStore.get(args!.key) : null);
    }
    if (cmd === "settings_set") {
      settingsStore.set(args!.key, args!.value);
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
  installMatchMedia(false); // 默认系统为亮色
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("ThemeContext", () => {
  it("默认 system 模式：data-theme 跟随 prefers-color-scheme（初始亮色）", () => {
    renderThemed();
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(dataTheme()).toBe("light");
  });

  it("system 模式：系统明暗切换（matchMedia change）→ data-theme 翻转", () => {
    renderThemed();
    act(() => flipSystem(true));
    expect(dataTheme()).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    act(() => flipSystem(false));
    expect(dataTheme()).toBe("light");
  });

  it("setMode 立即写 data-theme 并持久化；手动模式不受系统切换影响", async () => {
    renderThemed();
    fireEvent.click(screen.getByText("set-dark"));
    expect(dataTheme()).toBe("dark");
    // 迁移点注记：localStorage 键 ottr.settings.theme，Task 4 vault 落地后迁移
    expect(localStorage.getItem("ottr.settings.theme")).toBe("dark");
    // T17 F1：冲刷 persistMode 的浮动 promise（动态 import 跨测试滞留会污染
    // 后续用例的 vault 前置态——曾使迁移用例的 settings_store 预期失真）
    await act(async () => {});
    expect(settingsStore.get("ui.theme")).toBe("dark");
    act(() => flipSystem(false)); // 系统变亮，手动 dark 不跟随
    expect(dataTheme()).toBe("dark");
  });

  it("重新挂载从 localStorage 恢复 mode", () => {
    localStorage.setItem("ottr.settings.theme", "light");
    renderThemed();
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(dataTheme()).toBe("light");
  });

  it("T11 迁移：localStorage 有值、vault 空 → 迁入 ui.theme 并清 localStorage 键", async () => {
    localStorage.setItem("ottr.settings.theme", "dark");
    await act(async () => {
      await syncThemeFromVault();
    });
    expect(settingsStore.get("ui.theme")).toBe("dark");
    expect(localStorage.getItem("ottr.settings.theme")).toBeNull();
    // 幂等：二次 sync 不再写
    mockedInvoke.mockClear();
    await act(async () => {
      await syncThemeFromVault();
    });
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "settings_set"),
    ).toHaveLength(0);
  });

  it("T11 真源对齐：vault 有值时以 vault 为准（陈旧缓存被纠正）", async () => {
    settingsStore.set("ui.theme", "dark");
    localStorage.setItem("ottr.settings.theme", "light"); // 陈旧缓存
    await act(async () => {
      renderThemed();
    });
    // T17 F1：sync 已挪出 ThemeProvider 挂载（App 就绪门内调用）——挂载本身不得触达 vault
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "settings_get")).toHaveLength(0);
    expect(screen.getByTestId("mode").textContent).toBe("light"); // 仍按缓存首帧
    // 模拟就绪门放行后的显式 sync（modeApplier 已注册）→ vault 真源纠正缓存
    await act(async () => {
      await syncThemeFromVault();
    });
    await waitFor(() => expect(screen.getByTestId("mode").textContent).toBe("dark"));
    expect(dataTheme()).toBe("dark");
    // 真源对齐不迁不删：缓存镜像刷新为 vault 值
    expect(localStorage.getItem("ottr.settings.theme")).toBe("dark");
  });

  it("T11 setMode 双写：缓存镜像 + vault ui.theme", async () => {
    renderThemed();
    fireEvent.click(screen.getByText("set-dark"));
    expect(localStorage.getItem("ottr.settings.theme")).toBe("dark");
    await waitFor(() => expect(settingsStore.get("ui.theme")).toBe("dark"));
  });
});

// theme-suite T2：多主题模型——主题 id 扩到七态，二级解析 resolved（亮/暗），
// data-theme 挂主题 id（system 挂解析结果）；白名单三处同步。
describe("ThemeContext 多主题（theme-suite T2）", () => {
  it.each([
    ["oled", "dark"],
    ["amethyst", "dark"],
    ["glass", "dark"],
    ["verdant", "light"],
  ] as const)("二级解析：%s → resolved %s", async (id, want) => {
    renderThemed();
    fireEvent.click(screen.getByText(`set-${id}`));
    expect(screen.getByTestId("mode").textContent).toBe(id);
    expect(screen.getByTestId("resolved").textContent).toBe(want);
    // data-theme 挂主题 id 本身（CSS 按 id 出块），不是 resolved
    expect(document.documentElement.dataset.theme).toBe(id);
    // 持久化面同样收新 id
    expect(localStorage.getItem("ottr.settings.theme")).toBe(id);
    await act(async () => {});
    expect(settingsStore.get("ui.theme")).toBe(id);
    localStorage.removeItem("ottr.settings.theme");
  });

  it("auto 终端色板按主题 id 解析：oled 取配套色板（不是 resolved 暗色套）", async () => {
    renderThemed();
    fireEvent.click(screen.getByText("set-oled"));
    const mode = screen.getByTestId("mode").textContent!;
    const setting = { selection: "auto", custom: [] };
    expect(resolveTerminalTheme(mode as never, setting)).toBe(themeTerminalThemes.oled);
    // 对照：resolved 虽是 dark，但不再回落 darkTerminalTheme
    expect(themeTerminalThemes.oled).not.toBe(terminalThemes.dark);
  });

  it.each(["oled", "amethyst", "verdant", "glass"] as const)(
    "重新挂载从 localStorage 恢复新主题 id（%s）",
    (id) => {
      localStorage.setItem("ottr.settings.theme", id);
      renderThemed();
      expect(screen.getByTestId("mode").textContent).toBe(id);
      expect(document.documentElement.dataset.theme).toBe(id);
    },
  );

  it("白名单拒绝：vault / localStorage 存在未知主题值 → 不采纳（回落默认 system）", async () => {
    settingsStore.set("ui.theme", "solarized-ultra");
    localStorage.setItem("ottr.settings.theme", "hacker-green");
    renderThemed();
    expect(screen.getByTestId("mode").textContent).toBe("system");
    await act(async () => {
      await syncThemeFromVault();
    });
    // 未知 vault 值不进状态，也不迁不明缓存
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "settings_set")).toHaveLength(0);
  });

  it("system 模式仍挂 resolved 亮/暗（data-theme=light/dark，CSS 块可命中）", () => {
    renderThemed();
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => flipSystem(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
