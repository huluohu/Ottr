// Sidebar 组件测试（2026-10-10 壳层重构）：三段式（快捷连接/主机区/导航+设置）
// ——导航项点击开对应 dock 面板（workspaceStore 真店断言）、未读徽标、壳层
// 动作回调（快速连接/设置/通知中心开关）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import "../i18n";
import { Sidebar } from "./Sidebar";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useNotifyStore } from "../notify/core";

const noop = () => {};

function treeProps() {
  return {
    selectedId: null,
    onSelect: noop,
    onOpen: noop,
    onEdit: noop,
    onAdd: noop,
    onImport: noop,
  };
}

function shellProps(overrides?: Partial<Parameters<typeof Sidebar>[0]>) {
  return {
    style: undefined,
    onQuickConnect: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleNotifications: vi.fn(),
    notificationsOpen: false,
    ...overrides,
  };
}

beforeEach(() => {
  useWorkspaceStore.setState({ dockPanel: null });
  useNotifyStore.setState({ unread: 0 });
});

afterEach(() => cleanup());

describe("Sidebar", () => {
  it("三段式渲染：快捷连接/主机区（新建主机入口）/导航/设置", () => {
    render(<Sidebar {...treeProps()} {...shellProps()} />);
    expect(screen.getByTestId("sidebar-quick-connect")).toBeTruthy();
    expect(screen.getByTestId("add-host")).toBeTruthy(); // 主机区 = HostTree 原样嵌入
    expect(screen.getByTestId("sidebar-nav-cron")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-alerts")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-mcp")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-notifications")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-settings")).toBeTruthy();
  });

  it("导航点击开对应 dock 面板（真店断言 dockPanel 落位）", () => {
    render(<Sidebar {...treeProps()} {...shellProps()} />);
    fireEvent.click(screen.getByTestId("sidebar-nav-cron"));
    expect(useWorkspaceStore.getState().dockPanel).toBe("cron");
    fireEvent.click(screen.getByTestId("sidebar-nav-alerts"));
    expect(useWorkspaceStore.getState().dockPanel).toBe("alerts");
  });

  it("未读数徽标：unread=3 显示 3；归零消失", () => {
    useNotifyStore.setState({ unread: 3 });
    render(<Sidebar {...treeProps()} {...shellProps()} />);
    expect(screen.getByTestId("sidebar-unread").textContent).toBe("3");
    cleanup();
    useNotifyStore.setState({ unread: 0 });
    render(<Sidebar {...treeProps()} {...shellProps()} />);
    expect(screen.queryByTestId("sidebar-unread")).toBeNull();
  });

  it("壳层动作：快速连接/通知中心开关/设置回调接线", () => {
    const shell = shellProps({
      onQuickConnect: vi.fn(),
      onToggleNotifications: vi.fn(),
      onOpenSettings: vi.fn(),
    });
    render(<Sidebar {...treeProps()} {...shell} />);
    fireEvent.click(screen.getByTestId("sidebar-quick-connect"));
    expect(shell.onQuickConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sidebar-nav-notifications"));
    expect(shell.onToggleNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    expect(shell.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
