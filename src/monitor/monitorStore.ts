// 监控数据面 store（Phase 3 Task 1，B4 上半）：`ottr://monitor` 事件分桶 +
// sparkline 历史窗口。
//
// * 键 = Rust 会话 id（payload.id，即 session.rustId）——重连 = 新 rustId =
//   新窗口（历史随连接重来，与 Rust 侧采样任务同生命周期）；
// * status：live（有采样）/ unsupported（远端非 Linux）/ stopped（exec 连续
//   失败终止）/ idle（无数据：未开启监控或尚未连上）；
// * 历史窗口按点位存（cpu/mem/load/net 各一个数列 + 磁盘占比），上限
//   HISTORY_CAP = 60 点（默认 5s 间隔 ≈ 5 分钟视图）；map 总量以 MAX_KEYS
//   兜底（关标签的旧 rustId 条目惰性淘汰，防长会话累积）。
// * store 保持纯数据机（events.ts 负责接线，同 SessionStore/events 惯例）。
import { create } from "zustand";

/** `ottr://monitor` 事件载荷（Rust MonitorEventPayload 同构）。 */
export interface MonitorMetrics {
  cpu_percent: number;
  mem_used_percent: number;
  mem_total_kb: number;
  mem_used_kb: number;
  load_one: number;
  load_five: number;
  load_fifteen: number;
  net_rx_bps: number;
  net_tx_bps: number;
  disk: {
    filesystem: string;
    total_kb: number;
    used_kb: number;
    avail_kb: number;
    used_percent: number;
    mount: string;
  }[];
}

export interface MonitorEventPayload {
  id: string;
  status: "sample" | "unsupported" | "stopped";
  metrics: MonitorMetrics | null;
}

export type MonitorStatus = "idle" | "live" | "unsupported" | "stopped";

/** 单会话的监控窗口（历史数列等长，latest 供数值面）。 */
export interface MonitorWindow {
  status: MonitorStatus;
  cpu: number[];
  mem: number[];
  load1: number[];
  netRx: number[];
  netTx: number[];
  /** 磁盘使用率（侧栏展示口径 = 根挂载点，无 / 时取使用率最高者）。 */
  disk: number[];
  latest: MonitorMetrics | null;
}

function emptyWindow(status: MonitorStatus = "idle"): MonitorWindow {
  return {
    status,
    cpu: [],
    mem: [],
    load1: [],
    netRx: [],
    netTx: [],
    disk: [],
    latest: null,
  };
}

/** 历史窗口上限（点数；5s 采样 ≈ 5 分钟视图）。 */
export const HISTORY_CAP = 60;
/** map 键数上限（惰性淘汰最旧 rustId；防关标签残留累积）。 */
export const MAX_KEYS = 32;

/** 侧栏磁盘口径：根挂载点优先，缺席取使用率最高的（0-100）。 */
export function pickDiskPercent(metrics: MonitorMetrics): number {
  const root = metrics.disk.find((d) => d.mount === "/");
  if (root) return root.used_percent;
  return metrics.disk.reduce((max, d) => Math.max(max, d.used_percent), 0);
}

/** 追加并截窗（等长数列共用一份裁剪逻辑）。 */
export function pushCapped(series: number[], value: number, cap = HISTORY_CAP): number[] {
  const next = [...series, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

interface MonitorStore {
  /** rustId → 监控窗口。 */
  windows: Record<string, MonitorWindow>;
  /** ottr://monitor 事件入口（events.ts 接线）。 */
  onMonitorEvent: (payload: MonitorEventPayload) => void;
  /** 显式清窗（rustId 变化/测试复位用）。 */
  forget: (rustId: string) => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  windows: {},

  onMonitorEvent: (payload) =>
    set((st) => {
      const win = st.windows[payload.id] ?? emptyWindow();
      let next: MonitorWindow;
      if (payload.status === "sample" && payload.metrics) {
        const m = payload.metrics;
        next = {
          status: "live",
          cpu: pushCapped(win.cpu, m.cpu_percent),
          mem: pushCapped(win.mem, m.mem_used_percent),
          load1: pushCapped(win.load1, m.load_one),
          netRx: pushCapped(win.netRx, m.net_rx_bps),
          netTx: pushCapped(win.netTx, m.net_tx_bps),
          disk: pushCapped(win.disk, pickDiskPercent(m)),
          latest: m,
        };
      } else if (payload.status === "unsupported") {
        next = { ...win, status: "unsupported" };
      } else {
        next = { ...win, status: "stopped" };
      }
      const windows = { ...st.windows, [payload.id]: next };
      // 键数兜底：超出上限淘汰最旧（插入序 = Object.keys 顺序）
      const keys = Object.keys(windows);
      if (keys.length > MAX_KEYS) {
        for (const k of keys.slice(0, keys.length - MAX_KEYS)) {
          delete windows[k];
        }
      }
      return { windows };
    }),

  forget: (rustId) =>
    set((st) => {
      if (!(rustId in st.windows)) return {};
      const windows = { ...st.windows };
      delete windows[rustId];
      return { windows };
    }),
}));
