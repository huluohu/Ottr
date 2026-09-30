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
// Task 12 通知管线同上：只 stub initNotifyEvents，其余保留真实现。
vi.mock("./notify/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./notify/core")>();
  return { ...mod, initNotifyEvents: vi.fn(async () => {}) };
});

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
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
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
      if (cmd === "credentials_list" || cmd === "host_groups_list") return Promise.resolve([]);
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
});
