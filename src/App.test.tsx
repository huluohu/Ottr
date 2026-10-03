// App 布局集成测试（原 QuickConnect.test.tsx 的 App 集成面，Task 14 随
// ⌘K 面板并入 palette 迁移至此）：主页骨架渲染 + Ctrl+K 呼出命令面板 +
// refresh 失败横幅。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// App 挂载即注册 Tauri 事件监听（Task 7 会话事件）；jsdom 无 Tauri runtime，stub 掉
vi.mock("./session/events", () => ({ initSessionEvents: vi.fn(async () => {}) }));
// Task 10（A5）传输事件同上（漏 mock 会让真 listen() 产生 unhandled rejection）
vi.mock("./files/events", () => ({ initTransferEvents: vi.fn(async () => {}) }));
// Phase 3 Task 1（I-1 转办）：监控采样事件接线同上（jsdom 无 Tauri runtime）
vi.mock("./monitor/events", () => ({ initMonitorEvents: vi.fn(async () => {}) }));
// Phase 3 Task 4（B6）：批量结果事件接线同上（jsdom 无 Tauri runtime）
vi.mock("./batch/events", () => ({ initBatchEvents: vi.fn(async () => {}) }));
// Phase 4 Task 1（缺口①）：cron 事件接线同上（真 listen 在 jsdom 无 Tauri
// 运行时会 unhandled reject）。
vi.mock("./cron/events", () => ({ initCronEvents: vi.fn(async () => {}) }));
// Task 12 通知管线同上：只 stub initNotifyEvents，其余保留真实现。
vi.mock("./notify/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./notify/core")>();
  return { ...mod, initNotifyEvents: vi.fn(async () => {}) };
});
// Phase 3 Task 3（B5）：告警引擎接线（listen ottr://monitor + 进程轮询）与
// 渠道挂载（vault 读 + reveal）在 App 挂载链触发——jsdom 无 runtime，stub 掉。
vi.mock("./notify/rules", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./notify/rules")>();
  return { ...mod, initAlertEngine: vi.fn(async () => {}) };
});
vi.mock("./notify/channelRegistry", () => ({ remountChannels: vi.fn(async () => {}) }));

import "./i18n";
import App from "./App";
import { useVaultStore } from "./vault/store";
import { useWorkspaceStore } from "./workspace/workspaceStore";
import type { Host } from "./vault/api";

const mockedInvoke = invoke as unknown as Mock;

const web: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 2222,
  username: "deploy",
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  mockedInvoke.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  useVaultStore.setState({ hosts: [], hostGroups: [], credentials: [], loading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App 主页布局（集成）", () => {
  it("渲染骨架：顶栏 + 主机树（refresh 后）+ 主区占位；Ctrl+K 呼出/关闭命令面板", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([web]);
      if (cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    render(<App />);
    expect(screen.getByTestId("main-area")).toBeTruthy();
    expect(screen.getByTestId("open-palette")).toBeTruthy();
    // refresh 完成后主机树可见
    await waitFor(() => expect(screen.getByText("web-01")).toBeTruthy());
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host on the left");

    // 选中主机 → 主区切到已选占位
    fireEvent.click(screen.getByText("web-01"));
    expect(screen.getByTestId("main-area").textContent).toContain("Double-click a host");

    // Ctrl+K 呼出命令面板（A12：命令 + 主机双区）
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("command-palette")).toBeTruthy());
    expect(screen.getByText("Commands")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("refresh 失败：主区显示错误横幅", async () => {
    mockedInvoke.mockRejectedValue(new Error("vault locked"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("store-error").textContent).toContain("vault locked"),
    );
  });

  // 评审 M-4（fix round 1/5）终端聚焦守卫：target 在 [data-terminal] 容器内时
  // 全局监听只拦 Shift 系分屏与 ⌘K——裸 Ctrl+D（终端 EOF）必须不被
  // preventDefault（放行 PTY）。
  it("终端聚焦守卫：终端内 Ctrl+D 放行（defaultPrevented=false）、Ctrl+Shift+D 仍拦截、Ctrl+N 被守卫挡", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<App />);
    const term = document.createElement("div");
    term.setAttribute("data-terminal", "");
    document.body.appendChild(term);

    // 裸 Ctrl+D：registry 已不注册 + 守卫双保险 → 事件原样放行（到 PTY）
    expect(fireEvent.keyDown(term, { key: "d", ctrlKey: true })).toBe(true);
    // Ctrl+Shift+D（分屏右）：terminalSafe + 带 Shift → 拦截（preventDefault）
    expect(fireEvent.keyDown(term, { key: "D", ctrlKey: true, shiftKey: true })).toBe(false);
    // ⌘K / Ctrl+K（面板）：terminalSafe 例外 → 拦截
    expect(fireEvent.keyDown(term, { key: "k", ctrlKey: true })).toBe(false);
    // Ctrl+N（新建主机）：非 terminalSafe → 守卫挡下、不拦截
    expect(fireEvent.keyDown(term, { key: "n", ctrlKey: true })).toBe(true);
    // T15：Ctrl+R（history.search，非 terminalSafe）→ 终端内放行（shell 反向
    // 搜索），且历史面板不被呼出
    expect(fireEvent.keyDown(term, { key: "r", ctrlKey: true })).toBe(true);
    expect(screen.queryByTestId("history-search")).toBeNull();

    // 对照：终端外（target = body）Ctrl+N 照常拦截；Ctrl+R 呼出历史面板
    expect(fireEvent.keyDown(document.body, { key: "n", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: "r", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByTestId("history-search")).toBeTruthy());
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", {
      query: "",
      hostId: null,
      limit: 50,
    });

    term.remove();
  });
});

// Phase 5 T1（顶栏收纳）：低频面板入口收进「工具」下拉、主题改单按钮下拉——
// 呈现重排但功能零丢失：每个原入口仍可达（此处抽「凭据」全链 + 主题切换全链
// 验证；其余条目与凭据同一 TopbarMenu 壳、同一 onSelect 收口）。
describe("App 顶栏收纳（Phase 5 T1）", () => {
  function listMock() {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  it("工具下拉：九个面板入口齐全；点「凭据」打开凭据对话框", async () => {
    listMock();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("open-palette")).toBeTruthy());

    fireEvent.click(screen.getByTestId("topbar-tools"));
    const menu = screen.getByTestId("topbar-tools-menu");
    // 九入口（用户口径八项 + AI 助手收纳）：凭据/告警/MCP/AI/端口转发/跳板链/总览/批量执行/定时任务
    for (const testid of [
      "menu-open-credentials",
      "menu-open-alert-settings",
      "menu-open-mcp-settings",
      "menu-open-ai-settings",
      "menu-open-forwards",
      "menu-open-jump-chains",
      "menu-open-overview",
      "menu-open-batch",
      "menu-open-cron",
    ]) {
      expect(menu.querySelector(`[data-testid="${testid}"]`)).toBeTruthy();
    }

    // 入口可达性全链：点「凭据」→ 凭据对话框挂载
    fireEvent.click(screen.getByTestId("menu-open-credentials"));
    await waitFor(() => expect(screen.getByTestId("credentials-dialog")).toBeTruthy());
  });

  it("工具下拉：点外/Escape 收起", async () => {
    listMock();
    render(<App />);
    // 点外（mousedown 落在菜单壳之外，对齐 NotificationCenter 契约）收起
    fireEvent.click(screen.getByTestId("topbar-tools"));
    expect(screen.getByTestId("topbar-tools-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("topbar-tools-menu")).toBeNull();
    // Escape 收起
    fireEvent.click(screen.getByTestId("topbar-tools"));
    expect(screen.getByTestId("topbar-tools-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("topbar-tools-menu")).toBeNull();
  });

  it("主题单按钮下拉：按钮面显示当前模式，菜单三选一即时生效", async () => {
    listMock();
    render(<App />);
    // 默认 mode=system → 按钮面显示「System」（按钮面 = 当前模式名）
    const themeButton = screen.getByTestId("topbar-theme");
    expect(themeButton.textContent).toContain("System");

    fireEvent.click(themeButton);
    const menu = screen.getByTestId("topbar-theme-menu");
    expect(menu.querySelector('[data-testid="topbar-theme-light"]')).toBeTruthy();
    expect(menu.querySelector('[data-testid="topbar-theme-dark"]')).toBeTruthy();
    expect(menu.querySelector('[data-testid="topbar-theme-system"]')).toBeTruthy();

    // 选暗色 → data-theme 立即切换 + 按钮面更新（persistMode 走 localStorage 镜像）
    fireEvent.click(menu.querySelector('[data-testid="topbar-theme-dark"]')!);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("topbar-theme").textContent).toContain("Dark");
    // 菜单已收起
    expect(screen.queryByTestId("topbar-theme-menu")).toBeNull();
    localStorage.removeItem("ottr.settings.theme");
  });
});

// UI 批次一 Task 2：工具菜单工作区族条目 → workspaceStore 路由（T14 守卫的
// 实现面——条目→openDock/openMainView 映射；registry 动作 ID 零新增零删除，
// registry.test.ts 原样锁定）。对话框族（凭据/AI/同步）不在此列。
describe("App 工具菜单 → workspace 路由（UI 批次一 Task 2）", () => {
  function listMock() {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  beforeEach(() => {
    useWorkspaceStore.setState({ mainView: "terminal", dockPanel: null });
  });

  it("转发/定时任务 → openDock 单槽（后者替换前者）；dock 关闭按钮可用", async () => {
    listMock();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("open-palette")).toBeTruthy());

    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-forwards"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("forwards");

    // 单槽互斥走真菜单路径：开 cron 替换 forwards
    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-cron"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("cron");

    fireEvent.click(screen.getByTestId("dock-close"));
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("告警/MCP/跳板链 → openDock 对应面板；总览/批量 → openMainView 主区槽位", async () => {
    listMock();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("open-palette")).toBeTruthy());

    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-alert-settings"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("alerts");
    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-mcp-settings"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("mcp");
    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-jump-chains"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("jumpchains");

    // 总览/批量 = 主区互斥视图（零会话也可开——原对话框语义）；返回按钮回占位面
    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-overview"));
    expect(screen.getByTestId("main-view-slot").getAttribute("data-view")).toBe("overview");
    fireEvent.click(screen.getByTestId("topbar-tools"));
    fireEvent.click(screen.getByTestId("menu-open-batch"));
    expect(screen.getByTestId("main-view-slot").getAttribute("data-view")).toBe("batch");
    fireEvent.click(screen.getByTestId("slot-back-terminal"));
    expect(screen.queryByTestId("main-view-slot")).toBeNull();
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host");
  });
});
