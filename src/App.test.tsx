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
