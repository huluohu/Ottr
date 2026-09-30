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

import { ThemeProvider, useTheme, syncThemeFromVault } from "./ThemeContext";

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
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setMode("light")}>set-light</button>
      <button onClick={() => setMode("dark")}>set-dark</button>
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

beforeEach(() => {
  localStorage.clear();
  settingsStore.clear();
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

  it("setMode 立即写 data-theme 并持久化；手动模式不受系统切换影响", () => {
    renderThemed();
    fireEvent.click(screen.getByText("set-dark"));
    expect(dataTheme()).toBe("dark");
    // 迁移点注记：localStorage 键 ottr.settings.theme，Task 4 vault 落地后迁移
    expect(localStorage.getItem("ottr.settings.theme")).toBe("dark");
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
      // 首帧（同步）按缓存 light，挂载 sync 后被 vault 值纠正为 dark
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
