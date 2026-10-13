// MonitorPanel 组件测试（2026-10-13 改造自 MonitorSidebar）：live 数据渲染
// （数值 + 图）/ 四态文案（off/unsupported/stopped/waiting）。rail/开合记忆
// 已随「终端右栏折叠竖条」退役（面板改经 ToolDialog 打开，壳提供标题与 ✕）。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../i18n";
import { MonitorPanel, formatRate, formatMemKB } from "./MonitorSidebar";
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
  useMonitorStore.setState({ windows: {} });
});
afterEach(cleanup);

describe("MonitorPanel（数据面）", () => {
  it("renders live metrics values and sparklines", () => {
    seedLive();
    render(<MonitorPanel rustId="pty-1" enabled />);
    const values = screen.getAllByTestId("monitor-metric-value").map((el) => el.textContent);
    expect(values).toEqual(["42%", "61% · 3.6 GB", "30%", "1.25", "↓ 4.0 KB/s ↑ 512 B/s"]);
    expect(screen.getAllByTestId("monitor-metric").length).toBe(5);
    expect(screen.queryByTestId("monitor-spark-empty")).toBeNull();
  });

  it("shows waiting face for enabled host without samples", () => {
    render(<MonitorPanel rustId="pty-1" enabled />);
    expect(screen.getByTestId("monitor-waiting")).toBeTruthy();
  });

  it("shows off face when host monitoring disabled", () => {
    render(<MonitorPanel rustId="pty-1" enabled={false} />);
    expect(screen.getByTestId("monitor-off")).toBeTruthy();
  });

  it("shows unsupported and stopped faces from store status", () => {
    useMonitorStore.setState({
      windows: { "pty-9": { status: "unsupported" } } as never,
    });
    render(<MonitorPanel rustId="pty-9" enabled />);
    expect(screen.getByTestId("monitor-unsupported")).toBeTruthy();

    cleanup();
    useMonitorStore.setState({
      windows: { "pty-9": { status: "stopped" } } as never,
    });
    render(<MonitorPanel rustId="pty-9" enabled />);
    expect(screen.getByTestId("monitor-stopped")).toBeTruthy();
  });

  it("renders with rustId null (disconnected) as waiting/off", () => {
    render(<MonitorPanel rustId={null} enabled />);
    expect(screen.getByTestId("monitor-waiting")).toBeTruthy();
  });

  it("无 rail 残留（折叠竖条已退役，回归钉 2026-10-13）", () => {
    render(<MonitorPanel rustId="pty-1" enabled />);
    expect(screen.queryByTestId("monitor-rail")).toBeNull();
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
