// PluginSidebar 组件测试（Phase 4 Task 6 Step 2）：折叠开合（localStorage 记忆）
// / 网络摘要卡片 live 值与等待态 / 快捷命令包复制（显式动作 → 剪贴板）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { PluginSidebar } from "./PluginSidebar";
import { useMonitorStore, type MonitorMetrics } from "../monitor/monitorStore";

function metrics(over: Partial<MonitorMetrics> = {}): MonitorMetrics {
  return {
    cpu_percent: 10,
    mem_used_percent: 40,
    mem_total_kb: 1_000_000,
    mem_used_kb: 400_000,
    load_one: 0.5,
    load_five: 0.4,
    load_fifteen: 0.3,
    net_rx_bps: 4096,
    net_tx_bps: 512,
    disk: [
      { filesystem: "overlay", total_kb: 100, used_kb: 30, avail_kb: 70, used_percent: 30, mount: "/" },
    ],
    ...over,
  };
}

function seedLive(id = "pty-1") {
  useMonitorStore.setState({
    windows: {
      [id]: {
        status: "live",
        cpu: [10],
        mem: [40],
        load1: [0.5],
        netRx: [1024, 4096],
        netTx: [256, 512],
        disk: [30],
        latest: metrics(),
      },
    },
  });
}

function openSidebar() {
  render(<PluginSidebar rustId="pty-1" />);
  fireEvent.click(screen.getByTestId("plugin-rail"));
}

beforeEach(() => {
  localStorage.clear();
  useMonitorStore.setState({ windows: {} });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);

describe("collapse/expand", () => {
  it("defaults to collapsed rail and remembers open state", () => {
    const { rerender } = render(<PluginSidebar rustId="pty-1" />);
    expect(screen.getByTestId("plugin-rail")).toBeTruthy();
    expect(screen.queryByTestId("plugin-sidebar")).toBeNull();

    fireEvent.click(screen.getByTestId("plugin-rail"));
    expect(screen.getByTestId("plugin-sidebar")).toBeTruthy();
    expect(localStorage.getItem("ottr.plugins.sidebarOpen")).toBe("1");

    // 重挂载走 localStorage 初始值
    rerender(<PluginSidebar rustId="pty-1" />);
    expect(screen.getByTestId("plugin-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByTestId("plugin-collapse"));
    expect(screen.queryByTestId("plugin-sidebar")).toBeNull();
    expect(localStorage.getItem("ottr.plugins.sidebarOpen")).toBe("0");
  });
});

describe("net-summary card", () => {
  it("renders live rx/tx rates（复用 formatRate 口径）", () => {
    seedLive();
    openSidebar();
    expect(screen.getByTestId("plugin-net-card")).toBeTruthy();
    expect(screen.getByTestId("plugin-net-value").textContent).toBe("↓ 4.0 KB/s · ↑ 512 B/s");
  });

  it("shows waiting face without a live window", () => {
    openSidebar();
    expect(screen.getByTestId("plugin-net-waiting")).toBeTruthy();
    expect(screen.queryByTestId("plugin-net-value")).toBeNull();
  });
});

describe("quick-commands card", () => {
  it("lists 4 readonly commands with copy buttons", () => {
    openSidebar();
    const rows = screen.getAllByTestId("plugin-cmd-row");
    expect(rows).toHaveLength(4);
    expect(screen.getByText("df -h")).toBeTruthy();
    expect(screen.getByText("free -m")).toBeTruthy();
    expect(screen.getByText("uptime")).toBeTruthy();
    expect(screen.getByText("docker ps")).toBeTruthy();
  });

  it("copies command on explicit click（插件不自动执行）", async () => {
    openSidebar();
    const copy = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByTestId("plugin-cmd-copy-quick-commands.df"));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("df -h"));
  });
});
