// MonitorSidebar 组件测试（Phase 3 Task 1 Step 3）：折叠开合（localStorage
// 记忆）/ live 数据渲染（数值 + 图）/ 四态文案（off/unsupported/stopped/waiting）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../i18n";
import { MonitorSidebar, formatRate, formatMemKB } from "./MonitorSidebar";
import { useMonitorStore, type MonitorMetrics } from "./monitorStore";

function metrics(over: Partial<MonitorMetrics> = {}): MonitorMetrics {
  return {
    cpu_percent: 42,
    mem_used_percent: 61,
    mem_total_kb: 6_137_524,
    mem_used_kb: 3_743_889,
    load_one: 1.25,
    load_five: 0.9,
    load_fifteen: 0.7,
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
        cpu: [10, 42],
        mem: [60, 61],
        load1: [1.0, 1.25],
        netRx: [1024, 4096],
        netTx: [256, 512],
        disk: [29, 30],
        latest: metrics(),
      },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  useMonitorStore.setState({ windows: {} });
});
afterEach(cleanup);

describe("collapse/expand", () => {
  it("defaults to collapsed rail and remembers open state", () => {
    const { rerender } = render(<MonitorSidebar rustId="pty-1" enabled />);
    expect(screen.getByTestId("monitor-rail")).toBeTruthy();
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull();

    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-sidebar")).toBeTruthy();
    expect(localStorage.getItem("ottr.monitor.sidebarOpen")).toBe("1");

    // 重挂载走 localStorage 初始值
    rerender(<MonitorSidebar rustId="pty-1" enabled />);
    expect(screen.getByTestId("monitor-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByTestId("monitor-collapse"));
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull();
    expect(localStorage.getItem("ottr.monitor.sidebarOpen")).toBe("0");
  });
});

describe("data face", () => {
  it("renders live metrics values and sparklines", () => {
    seedLive();
    render(<MonitorSidebar rustId="pty-1" enabled />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    const values = screen.getAllByTestId("monitor-metric-value").map((el) => el.textContent);
    expect(values).toEqual(["42%", "61% · 3.6 GB", "30%", "1.25", "↓ 4.0 KB/s ↑ 512 B/s"]);
    expect(screen.getAllByTestId("monitor-metric").length).toBe(5);
    expect(screen.queryByTestId("monitor-spark-empty")).toBeNull();
  });

  it("shows waiting face for enabled host without samples", () => {
    render(<MonitorSidebar rustId="pty-1" enabled />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-waiting")).toBeTruthy();
  });

  it("shows off face when host monitoring disabled", () => {
    render(<MonitorSidebar rustId="pty-1" enabled={false} />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-off")).toBeTruthy();
  });

  it("shows unsupported and stopped faces from store status", () => {
    useMonitorStore.setState({
      windows: { "pty-9": { status: "unsupported" } } as never,
    });
    render(<MonitorSidebar rustId="pty-9" enabled />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-unsupported")).toBeTruthy();

    cleanup();
    localStorage.clear();
    useMonitorStore.setState({
      windows: { "pty-9": { status: "stopped" } } as never,
    });
    render(<MonitorSidebar rustId="pty-9" enabled />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-stopped")).toBeTruthy();
  });

  it("renders with rustId null (disconnected) as waiting/off", () => {
    render(<MonitorSidebar rustId={null} enabled />);
    fireEvent.click(screen.getByTestId("monitor-rail"));
    expect(screen.getByTestId("monitor-waiting")).toBeTruthy();
  });
});

describe("formatters", () => {
  it("formats rates and memory human-readable", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(4096)).toBe("4.0 KB/s");
    expect(formatRate(2 * 1024 * 1024)).toBe("2.0 MB/s");
    expect(formatMemKB(6_137_524)).toBe("5.9 GB");
    expect(formatMemKB(512 * 1024)).toBe("512 MB");
  });
});
