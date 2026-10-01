// SecuritySettings 终端配色区组件测试（Phase 2 Task 9 Step 3）：
// 选择器三组（auto/内置画廊/导入清单）、文件导入分派（json→WT 解析，多 scheme
// 全入库选第一个）、导入失败报错、删除自定义回 auto、选择写 store。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import "../i18n";
import { ThemeProvider } from "../theme/ThemeContext";
import { findGalleryTheme } from "../theme/gallery";
import {
  resetTerminalThemeStoreForTest,
  useTerminalThemeStore,
} from "../theme/terminalThemeStore";
import { resetVaultLockStoreForTest, useVaultLockStore } from "./VaultLockStore";
import { SecuritySettings } from "./SecuritySettings";

const mockedInvoke = invoke as unknown as Mock;

function renderDialog() {
  return render(
    <ThemeProvider>
      <SecuritySettings open onClose={() => {}} />
    </ThemeProvider>,
  );
}

const WT_FIXTURE = JSON.stringify({
  schemes: [
    {
      name: "Campbell",
      cursorColor: "#FFFFFF",
      selectionBackground: "#FFFFFF",
      background: "#0C0C0C",
      foreground: "#CCCCCC",
      black: "#0C0C0C",
      red: "#C50F1F",
      green: "#13A10E",
      yellow: "#C19C00",
      blue: "#0037DA",
      purple: "#881798",
      cyan: "#3A96DD",
      white: "#CCCCCC",
      brightBlack: "#767676",
      brightRed: "#E74856",
      brightGreen: "#16C60C",
      brightYellow: "#F9F1A5",
      brightBlue: "#3B78FF",
      brightPurple: "#B4009E",
      brightCyan: "#61D6D6",
      brightWhite: "#F2F2F2",
    },
    {
      name: "Lightless",
      background: "#FFFFFF",
      foreground: "#111111",
    },
  ],
});

function pickFile(name: string, content: string) {
  const input = screen.getByTestId("terminal-theme-file") as HTMLInputElement;
  const file = new File([content], name, { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(() => Promise.resolve(null));
  resetVaultLockStoreForTest();
  useVaultLockStore.setState({ phase: "unlocked", mode: "keyring", error: null });
  localStorage.clear();
  resetTerminalThemeStoreForTest();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecuritySettings 终端配色（B2 主题生态）", () => {
  it("选择器：auto 缺省 + 内置画廊 8 项；选画廊项写 store（不逐项发 settings_set——持久化在 store）", async () => {
    renderDialog();
    const select = (await waitFor(() =>
      screen.getByTestId("terminal-theme-select"),
    )) as HTMLSelectElement;
    expect(select.value).toBe("auto");
    // 画廊项齐备（optgroup 内 8 option + auto）
    expect(select.querySelectorAll("option").length).toBe(9);
    expect(select.textContent).toContain("Dracula");
    expect(select.textContent).toContain("Solarized Light · light");

    fireEvent.change(select, { target: { value: "nord" } });
    expect(useTerminalThemeStore.getState().selection).toBe("nord");
  });

  it("导入 Windows Terminal JSON：两个 scheme 全入库、选第一个、显示成功计数", async () => {
    renderDialog();
    await waitFor(() => screen.getByTestId("terminal-theme-file"));
    pickFile("settings-fragment.json", WT_FIXTURE);

    await waitFor(() => expect(screen.getByTestId("terminal-theme-imported")).toBeTruthy());
    const state = useTerminalThemeStore.getState();
    expect(state.custom.map((t) => t.name)).toEqual(["Campbell", "Lightless"]);
    expect(state.selection).toBe(state.custom[0].id);
    expect(screen.getByTestId("terminal-theme-imported").textContent).toContain("2");
    // 删除按钮随选中自定义项出现
    expect(screen.getByTestId("terminal-theme-delete")).toBeTruthy();
  });

  it("导入坏文件：错误行展示，store 不动", async () => {
    renderDialog();
    await waitFor(() => screen.getByTestId("terminal-theme-file"));
    pickFile("broken.json", "{not json");
    await waitFor(() => expect(screen.getByTestId("terminal-theme-error")).toBeTruthy());
    expect(screen.getByTestId("terminal-theme-error").textContent).toContain("not valid JSON");
    expect(useTerminalThemeStore.getState().custom).toEqual([]);
    expect(useTerminalThemeStore.getState().selection).toBe("auto");
  });

  it("删除自定义选中项：回 auto，删除按钮消失", async () => {
    useTerminalThemeStore.getState().addCustom({
      id: "custom-1",
      name: "Campbell",
      dark: true,
      theme: findGalleryTheme("nord")!.theme,
    });
    renderDialog();
    const select = (await waitFor(() =>
      screen.getByTestId("terminal-theme-select"),
    )) as HTMLSelectElement;
    expect(select.value).toBe("custom-1");
    fireEvent.click(screen.getByTestId("terminal-theme-delete"));
    await waitFor(() => expect(useTerminalThemeStore.getState().selection).toBe("auto"));
    expect(useTerminalThemeStore.getState().custom).toEqual([]);
    expect(screen.queryByTestId("terminal-theme-delete")).toBeNull();
  });
});
