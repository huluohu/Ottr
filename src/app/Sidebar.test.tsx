// Sidebar 组件测试（2026-10-10 壳层重构）：三段式（快捷连接/主机区/导航+设置）
// ——导航项点击开对应 dock 面板（workspaceStore 真店断言）、未读徽标、壳层
// 动作回调（快速连接/设置/通知中心开关）、主题/语言快捷循环。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import i18n from "../i18n";
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

function renderSidebar(overrides?: Partial<Parameters<typeof Sidebar>[0]>) {
  const shell = shellProps(overrides);
  render(
    <ThemeProvider>
      <Sidebar {...treeProps()} {...shell} />
    </ThemeProvider>,
  );
  return { shell };
}

beforeEach(() => {
  useWorkspaceStore.setState({ dockPanel: null });
  useNotifyStore.setState({ unread: 0 });
  // ThemeProvider 的 system 主题探测需要 matchMedia（jsdom 无）
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
  localStorage.removeItem("ottr.settings.theme");
});

describe("Sidebar", () => {
  it("三段式渲染：快捷连接/主机区（新建主机入口）/导航/设置", () => {
    renderSidebar();
    expect(screen.getByTestId("sidebar-quick-connect")).toBeTruthy();
    expect(screen.getByTestId("add-host")).toBeTruthy(); // 主机区 = HostTree 原样嵌入
    expect(screen.getByTestId("sidebar-nav-cron")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-alerts")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-mcp")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-notifications")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-settings")).toBeTruthy();
  });

  it("导航点击开对应 dock 面板（真店断言 dockPanel 落位）", () => {
    const { shell } = renderSidebar();
    void shell;
    fireEvent.click(screen.getByTestId("sidebar-nav-cron"));
    expect(useWorkspaceStore.getState().dockPanel).toBe("cron");
    fireEvent.click(screen.getByTestId("sidebar-nav-alerts"));
    expect(useWorkspaceStore.getState().dockPanel).toBe("alerts");
  });

  it("未读数徽标：unread=3 显示 3；归零消失", () => {
    useNotifyStore.setState({ unread: 3 });
    renderSidebar();
    expect(screen.getByTestId("sidebar-unread").textContent).toBe("3");
    cleanup();
    useNotifyStore.setState({ unread: 0 });
    renderSidebar();
    expect(screen.queryByTestId("sidebar-unread")).toBeNull();
  });

  it("壳层动作：快速连接/通知中心开关/设置回调接线", () => {
    const shell = shellProps({
      onQuickConnect: vi.fn(),
      onToggleNotifications: vi.fn(),
      onOpenSettings: vi.fn(),
    });
    renderSidebar(shell);
    fireEvent.click(screen.getByTestId("sidebar-quick-connect"));
    expect(shell.onQuickConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sidebar-nav-notifications"));
    expect(shell.onToggleNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sidebar-nav-settings"));
    expect(shell.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("主题子菜单：行点击弹出浮层七选项；选即应用并收起（不挤动侧栏布局）", async () => {
    renderSidebar();
    const treeBefore = screen.getByTestId("app-sidebar").textContent;
    fireEvent.click(screen.getByTestId("sidebar-theme"));
    expect(screen.getByTestId("sidebar-flyout-theme")).toBeTruthy();
    for (const id of ["system", "light", "dark", "oled", "amethyst", "verdant", "glass"]) {
      expect(screen.getByTestId(`sidebar-theme-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("sidebar-theme-oled"));
    expect(document.documentElement.dataset.theme).toBe("oled");
    // 选即关（原生菜单语义）
    expect(screen.queryByTestId("sidebar-flyout-theme")).toBeNull();
    // 侧栏自身文本不变 = 布局未被顶动
    expect(screen.getByTestId("app-sidebar").textContent).toBe(treeBefore);
  });

  it("语言子菜单：浮层展开中英选项，点选切换 i18n 实例语言并收起", async () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("sidebar-lang"));
    expect(screen.getByTestId("sidebar-flyout-lang")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sidebar-lang-zh-CN"));
    await waitFor(() => expect(i18n.language).toBe("zh-CN"));
    // 选即关
    expect(screen.queryByTestId("sidebar-flyout-lang")).toBeNull();
  });
});
