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
    onOpenCredentials: vi.fn(),
    onNewGroup: vi.fn(),
    onOpenSettings: vi.fn(),
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
  useWorkspaceStore.setState({ dockTabs: [], dockActive: null });
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
  it("三段式渲染：搜索/主机区（新建主机入口）/导航/设置", () => {
    renderSidebar();
    expect(screen.getByTestId("sidebar-search")).toBeTruthy();
    expect(screen.getByTestId("sidebar-add-host")).toBeTruthy(); // 主机区 = HostTree 原样嵌入
    expect(screen.getByTestId("sidebar-add-group")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-cron")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-alerts")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-mcp")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-notifications")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-settings")).toBeTruthy();
  });

  it("导航点击开对应 dock 页签（共存不互关）；再点同页签关闭（开关二态）", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("sidebar-nav-cron"));
    expect(useWorkspaceStore.getState().dockActive).toBe("cron");
    fireEvent.click(screen.getByTestId("sidebar-nav-alerts"));
    expect(useWorkspaceStore.getState().dockActive).toBe("alerts");
    expect(useWorkspaceStore.getState().dockTabs).toEqual(["cron", "alerts"]); // 共存
    fireEvent.click(screen.getByTestId("sidebar-nav-alerts")); // 再点 = 关该页签
    expect(useWorkspaceStore.getState().dockActive).toBe("cron"); // 活动权移交右邻
    expect(useWorkspaceStore.getState().dockTabs).toEqual(["cron"]);
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

  it("壳层动作：搜索/设置回调接线（通知中心行已收编 nav，走 dock 不再经壳回调）", () => {
    const shell = shellProps({
      onQuickConnect: vi.fn(),
      onOpenSettings: vi.fn(),
    });
    renderSidebar(shell);
    fireEvent.click(screen.getByTestId("sidebar-search"));
    expect(shell.onQuickConnect).toHaveBeenCalledTimes(1);
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

  // 回归（v0.5.0 实测「选择不生效」）：浮层渲染在 nav 之外，外点关闭监听
  // mousedown——旧实现把面板内的 mousedown 误判为「点外」即刻卸载面板，
  // 后续 click 永远不触发（真机事件序 = mousedown → click）。本用例按真实
  // 事件序模拟：面板内 mousedown 不得卸载，随后 click 正常应用主题。
  it("回归：面板内 mousedown 不卸载浮层，随后 click 正常应用（真实事件序）", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("sidebar-theme"));
    const option = screen.getByTestId("sidebar-theme-oled");
    fireEvent.mouseDown(option); // 旧实现：面板在此被卸载 → click 落空
    expect(screen.getByTestId("sidebar-flyout-theme")).toBeTruthy();
    fireEvent.click(option);
    expect(document.documentElement.dataset.theme).toBe("oled");
    expect(screen.queryByTestId("sidebar-flyout-theme")).toBeNull();
  });

  it("外点（面板外元素）mousedown 仍收起浮层", () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId("sidebar-theme"));
    expect(screen.getByTestId("sidebar-flyout-theme")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("sidebar-flyout-theme")).toBeNull();
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
