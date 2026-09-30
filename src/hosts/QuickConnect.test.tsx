// QuickConnect（⌘K 雏形）+ App 布局集成测试（Task 5 Step 4）：
// ⌘K/Ctrl+K 呼出、键盘选择、Escape 关闭；主页骨架（左树+主区占位）渲染。
// App 级测试需 stub matchMedia（ThemeProvider 主通道，同 ThemeContext.test 模式）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import App from "../App";
import { QuickConnect } from "./QuickConnect";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";

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

describe("QuickConnect（受控 open）", () => {
  it("open=false 不渲染；open=true 搜索（空查询全量）并列出主机", async () => {
    mockedInvoke.mockResolvedValue([web]);
    const onClose = vi.fn();
    const { rerender } = render(<QuickConnect open={false} onClose={onClose} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("quick-connect")).toBeNull();

    rerender(<QuickConnect open={true} onClose={onClose} onSelect={vi.fn()} />);
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_search", { query: "" });
    });
    expect(screen.getByText("web-01")).toBeTruthy();
  });

  it("点击结果 → onSelect 并由父层关闭", async () => {
    mockedInvoke.mockResolvedValue([web]);
    const onSelect = vi.fn();
    render(<QuickConnect open={true} onClose={vi.fn()} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("web-01")).toBeTruthy());
    fireEvent.click(screen.getByText("web-01"));
    expect(onSelect).toHaveBeenCalledWith(web);
  });

  it("键盘：Escape 触发 onClose（由父层置 open=false）", () => {
    mockedInvoke.mockResolvedValue([]); // open 挂载即发空查询搜索
    const onClose = vi.fn();
    render(<QuickConnect open={true} onClose={onClose} onSelect={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("App 主页布局（集成）", () => {
  it("渲染骨架：顶栏 + 主机树（refresh 后）+ 主区占位；Ctrl+K 呼出快速连接", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([web]);
      if (cmd === "credentials_list" || cmd === "host_groups_list") return Promise.resolve([]);
      if (cmd === "hosts_search") return Promise.resolve([web]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    render(<App />);
    // 主区占位与顶栏
    expect(screen.getByTestId("main-area")).toBeTruthy();
    expect(screen.getByTestId("open-quick-connect")).toBeTruthy();
    // refresh 完成后主机树可见
    await waitFor(() => expect(screen.getByText("web-01")).toBeTruthy());
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host on the left");

    // 选中主机 → 主区切到已选占位
    fireEvent.click(screen.getByText("web-01"));
    expect(screen.getByTestId("main-area").textContent).toContain("Terminal sessions arrive");

    // Ctrl+K 呼出 palette（快速连接雏形）
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("quick-connect")).toBeTruthy());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByTestId("quick-connect")).toBeNull();
  });

  it("refresh 失败：主区显示错误横幅", async () => {
    mockedInvoke.mockRejectedValue(new Error("vault locked"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("store-error").textContent).toContain("vault locked"),
    );
  });
});
