// monitorStore 纯数据机测试（Phase 3 Task 1 Step 3）：
// 样本追加截窗 / 状态迁移 / 磁盘口径 / 键数兜底。
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_KEYS,
  HISTORY_CAP,
  pickDiskPercent,
  pushCapped,
  useMonitorStore,
  type MonitorMetrics,
} from "./monitorStore";

function metrics(over: Partial<MonitorMetrics> = {}): MonitorMetrics {
  return {
    cpu_percent: 12.5,
    mem_used_percent: 50,
    mem_total_kb: 1_000_000,
    mem_used_kb: 500_000,
    load_one: 1.2,
    load_five: 0.9,
    load_fifteen: 0.7,
    net_rx_bps: 2048,
    net_tx_bps: 512,
    disk: [
      { filesystem: "tmpfs", total_kb: 1, used_kb: 0, avail_kb: 1, used_percent: 0, mount: "/dev" },
      { filesystem: "overlay", total_kb: 100, used_kb: 30, avail_kb: 70, used_percent: 30, mount: "/" },
    ],
    ...over,
  };
}

beforeEach(() => {
  useMonitorStore.setState({ windows: {} });
});

describe("onMonitorEvent", () => {
  it("first sample creates a live window with history", () => {
    useMonitorStore.getState().onMonitorEvent({ id: "pty-1", status: "sample", metrics: metrics() });
    const win = useMonitorStore.getState().windows["pty-1"];
    expect(win.status).toBe("live");
    expect(win.cpu).toEqual([12.5]);
    expect(win.mem).toEqual([50]);
    expect(win.disk).toEqual([30]);
    expect(win.latest?.net_rx_bps).toBe(2048);
  });

  it("appends samples and caps history at HISTORY_CAP", () => {
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      useMonitorStore
        .getState()
        .onMonitorEvent({ id: "pty-1", status: "sample", metrics: metrics({ cpu_percent: i }) });
    }
    const win = useMonitorStore.getState().windows["pty-1"];
    expect(win.cpu.length).toBe(HISTORY_CAP);
    expect(win.cpu[0]).toBe(10);
    expect(win.cpu[win.cpu.length - 1]).toBe(HISTORY_CAP + 9);
    // 等长窗口：其余序列同步截窗
    expect(win.mem.length).toBe(HISTORY_CAP);
    expect(win.disk.length).toBe(HISTORY_CAP);
  });

  it("terminal statuses flip without touching history", () => {
    useMonitorStore.getState().onMonitorEvent({ id: "pty-1", status: "sample", metrics: metrics() });
    useMonitorStore.getState().onMonitorEvent({ id: "pty-1", status: "unsupported", metrics: null });
    expect(useMonitorStore.getState().windows["pty-1"].status).toBe("unsupported");
    expect(useMonitorStore.getState().windows["pty-1"].cpu.length).toBe(1);

    useMonitorStore.getState().onMonitorEvent({ id: "pty-2", status: "stopped", metrics: null });
    expect(useMonitorStore.getState().windows["pty-2"].status).toBe("stopped");
  });

  it("buckets by rustId and evicts oldest beyond MAX_KEYS", () => {
    for (let i = 0; i <= MAX_KEYS; i++) {
      useMonitorStore
        .getState()
        .onMonitorEvent({ id: `pty-${i}`, status: "sample", metrics: metrics() });
    }
    const windows = useMonitorStore.getState().windows;
    expect(Object.keys(windows).length).toBe(MAX_KEYS);
    expect(windows["pty-0"]).toBeUndefined();
    expect(windows[`pty-${MAX_KEYS}`]).toBeDefined();
  });
});

describe("pickDiskPercent", () => {
  it("prefers root mount, falls back to max", () => {
    expect(pickDiskPercent(metrics())).toBe(30);
    const noRoot = metrics({ disk: metrics().disk.slice(0, 1) });
    expect(pickDiskPercent(noRoot)).toBe(0);
    const high = metrics({
      disk: [
        { filesystem: "a", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: 95, mount: "/data" },
        { filesystem: "b", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: 42, mount: "/bak" },
      ],
    });
    expect(pickDiskPercent(high)).toBe(95);
  });
});

describe("pushCapped", () => {
  it("appends below cap and slices beyond", () => {
    expect(pushCapped([1, 2], 3, 4)).toEqual([1, 2, 3]);
    expect(pushCapped([1, 2, 3, 4], 5, 4)).toEqual([2, 3, 4, 5]);
    expect(pushCapped([], 9, 4)).toEqual([9]);
  });
});
