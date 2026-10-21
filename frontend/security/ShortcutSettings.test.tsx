// 设置 → 快捷键（改键）组件测试：列表渲染、搜索过滤、捕获改键（模拟 keydown
 // 归一）、冲突拒绝、恢复默认。invoke mock 覆盖 settings_get/set。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = invoke as unknown as Mock;

import { ShortcutSettings } from "./ShortcutSettings";
import { ACTIONS } from "../shortcuts/registry";
import { useShortcutStore } from "../shortcuts/store";
import "../i18n";

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "settings_get") {
      return Promise.resolve(useShortcutStore.getState().overrides);
    }
    return Promise.resolve(null);
  });
  useShortcutStore.setState({ loaded: false, overrides: {}, version: 0 });
});

afterEach(() => {
  cleanup();
  useShortcutStore.setState({ loaded: false, overrides: {}, version: 0 });
});

describe("ShortcutSettings（设置 → 快捷键）", () => {
  it("列表渲染全部动作（行数 = 注册表）＋当前键位", async () => {
    render(<ShortcutSettings />);
    await useShortcutStore.getState().load();
    await waitFor(() => {
      expect(useShortcutStore.getState().loaded).toBe(true);
    });
    expect(screen.getByTestId("shortcuts-list").children.length).toBe(ACTIONS.length);
    expect(screen.getByTestId("shortcut-row-palette.toggle").textContent).toMatch(
      /⌘K|Ctrl\+K/,
    );
  });

  it("搜索过滤动作名", async () => {
    render(<ShortcutSettings />);
    fireEvent.change(screen.getByTestId("shortcuts-search"), {
      target: { value: "command" },
    });
    const rows = screen.getByTestId("shortcuts-list").children;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("shortcut-row-palette.toggle")).toBeTruthy();
    expect(screen.queryByTestId("shortcut-row-hosts.new")).toBeNull();
  });

  it("捕获改键：按下 ⌘⇧K → settings_set 写入覆盖表", async () => {
    render(<ShortcutSettings />);
    fireEvent.click(screen.getByTestId("shortcut-edit-palette.toggle"));
    const capture = screen.getByTestId(`shortcut-capture-palette.toggle`);
    fireEvent.keyDown(capture, { key: "K", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "shortcuts.overrides",
        value: { "palette.toggle": "CmdOrCtrl+Shift+K" },
      });
    });
  });

  it("冲突拒绝：与既有默认撞键 → 行内报错、不落库", async () => {
    // 预置 hosts.new = ⌘K（与 palette.toggle 的默认键撞）——冲突按生效键位算
    useShortcutStore.setState({
      loaded: true,
      overrides: { "hosts.new": "CmdOrCtrl+K" },
      version: 3,
    });
    render(<ShortcutSettings />);
    fireEvent.click(screen.getByTestId("shortcut-edit-palette.toggle"));
    fireEvent.keyDown(screen.getByTestId(`shortcut-capture-palette.toggle`), {
      key: "k",
      metaKey: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId(`shortcut-error-palette.toggle`)).toBeTruthy();
    });
    expect(
      mockedInvoke.mock.calls.find(([c]) => c === "settings_set"),
    ).toBeUndefined();
  });

  it("恢复默认：删除该条覆盖并落库", async () => {
    useShortcutStore.setState({
      loaded: true,
      overrides: { "hosts.new": "CmdOrCtrl+Alt+N" },
      version: 5,
    });
    render(<ShortcutSettings />);
    fireEvent.click(screen.getByTestId("shortcut-reset-hosts.new"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "shortcuts.overrides",
        value: {},
      });
    });
  });

  it("Esc 取消捕获：不落库", async () => {
    render(<ShortcutSettings />);
    fireEvent.click(screen.getByTestId("shortcut-edit-palette.toggle"));
    fireEvent.keyDown(screen.getByTestId(`shortcut-capture-palette.toggle`), {
      key: "Escape",
    });
    expect(
      mockedInvoke.mock.calls.find(([c]) => c === "settings_set"),
    ).toBeUndefined();
    expect(screen.queryByTestId(`shortcut-capture-palette.toggle`)).toBeNull();
  });
});
