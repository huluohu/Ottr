// Sidebar 组件测试（2026-10-10 壳层重构；2026-10-16 视觉重设计 M3 瘦身）：
// 两段式（快捷连接/主机区）+ ⌓\ 折叠胶囊。功能导航/Otty 球弹层已迁
// app/IconRail（断言随迁 IconRail.test.tsx，testid 前缀 rail-*）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { Sidebar } from "./Sidebar";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useNotifyStore } from "../notify/core";
import { useVaultStore } from "../vault/store";

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
    onNewGroup: vi.fn(),
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
  useWorkspaceStore.setState({ toolDialog: null, mainView: "terminal" });
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
  it("两段式渲染：搜索/主机区（新建主机入口）；功能导航已迁图标轨（不再有快捷菜单按钮）", () => {
    renderSidebar();
    expect(screen.getByTestId("sidebar-search")).toBeTruthy();
    expect(screen.getByTestId("sidebar-add-host")).toBeTruthy(); // 主机区 = HostTree 原样嵌入
    expect(screen.getByTestId("sidebar-add-group")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-quickmenu")).toBeNull();
  });

  it("壳层动作：搜索回调接线（⌓K 面板呼出）", () => {
    const shell = shellProps({ onQuickConnect: vi.fn() });
    renderSidebar(shell);
    fireEvent.click(screen.getByTestId("sidebar-search"));
    expect(shell.onQuickConnect).toHaveBeenCalledTimes(1);
  });

  it("折叠胶囊：只渲染搜索圆钮 + 分组圆点 + 未读徽标；树/新建入口收起", () => {
    // 组数据：两命名组（一带组色）+ 一台未分组主机
    useVaultStore.setState({
      hostGroups: [
        { id: 1, name: "生产", parent_id: null, color: "#d92d20", created_at: 0, updated_at: 0 },
        { id: 2, name: "测试", parent_id: null, color: null, created_at: 0, updated_at: 0 },
      ],
      hosts: [
        { id: 1, name: "a", address: "1.1.1.1", port: 22, protocol: "ssh", group_id: 1, tags: [] },
        { id: 2, name: "b", address: "2.2.2.2", port: 22, protocol: "ssh", group_id: null, tags: [] },
      ] as never,
    });
    useNotifyStore.setState({ unread: 5 });
    renderSidebar({ collapsed: true });
    expect(screen.getByTestId("app-sidebar").getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByTestId("sidebar-add-host")).toBeNull();
    const dots = screen.getByTestId("sidebar-capsule-hosts").querySelectorAll(".capsule-dot");
    expect(dots.length).toBe(3); // 两命名组 + 未分组桶
    expect((dots[0] as HTMLElement).style.background).toContain("rgb(217, 45, 32)");
    expect(screen.getByTestId("sidebar-unread").textContent).toContain("5");
    useVaultStore.setState({ hostGroups: [], hosts: [] });
    useNotifyStore.setState({ unread: 0 });
  });

  it("折叠态未读为零：徽标不渲染", () => {
    renderSidebar({ collapsed: true });
    expect(screen.queryByTestId("sidebar-unread")).toBeNull();
  });
});
