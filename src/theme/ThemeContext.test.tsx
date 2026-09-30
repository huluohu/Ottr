// A10（Task 1 Step 4）：ThemeContext 行为测试——mode 切换改 data-theme、
// system 模式跟随 mock matchMedia、localStorage 持久化与恢复。
// Tauri 事件兜底在纯浏览器环境（jsdom 无 __TAURI_INTERNALS__）自动跳过，只测 matchMedia 主通道。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

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
});
