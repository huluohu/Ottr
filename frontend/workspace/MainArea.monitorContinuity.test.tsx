// 监控侧栏连续性测试（UI 批次一 Task 3 评审提醒面）：总览/批量迁入主区互斥视
// 图后，监控/插件侧栏在非终端视图让位卸载——本套件验证「切走→切回」监控指标
// **连续**：数据真源 useMonitorStore 挂模块作用域（事件驱动持续灌入，与视图挂
// 载无关），侧栏重挂后即读即显最新窗口，不重置、不丢窗口。
// 顺带钉住终端常驻不变量在实体视图下的表现：整趟往返终端是同一 DOM 实例。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../terminal/Terminal", () => ({
  TerminalArea: () => <div data-testid="terminal-area" />,
}));
vi.mock("../session/TabBar", () => ({ TabBar: () => <div data-testid="tabbar" /> }));
vi.mock("../ai/DiagnosePanel", () => ({ DiagnosePanel: () => <div data-testid="diagnose-panel" /> }));
// PluginSidebar 真组件依赖插件 loader（动态 import 面到此为止即可——mock 成
// 标记节点；连续性主张只涉监控侧栏）。
vi.mock("../plugins/PluginSidebar", () => ({
  PluginSidebar: () => <div data-testid="plugin-sidebar" />,
}));
vi.mock("../history/RecordToggle", () => ({
  RecordToggle: () => <div data-testid="record-toggle" />,
}));

import "../i18n";
import { MainArea } from "./MainArea";
import { useWorkspaceStore } from "./workspaceStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import { useMonitorStore, type MonitorWindow } from "../monitor/monitorStore";
import type { Host } from "../vault/api";

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    hostId: 1,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-1",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    ...over,
  };
}

const fakeHost: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: true,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

function win(cpuPercent: number, cpuSeries: number[]): MonitorWindow {
  return {
    status: "live",
    cpu: cpuSeries,
    mem: [61],
    load1: [1.2],
    netRx: [1024],
    netTx: [512],
    disk: [30],
    latest: {
      cpu_percent: cpuPercent,
      mem_used_percent: 61,
      mem_total_kb: 6137524,
      mem_used_kb: 3743889,
      load_one: 1.2,
      load_five: 0.9,
      load_fifteen: 0.7,
      net_rx_bps: 1024,
      net_tx_bps: 512,
      disk: [
        { filesystem: "sda", total_kb: 100, used_kb: 30, avail_kb: 70, used_percent: 30, mount: "/" },
      ],
    },
  };
}

function cpuValue(): string {
  // 指标行序：CPU 在首位（MonitorSidebar MetricRow 顺序）
  return screen.getAllByTestId("monitor-metric-value")[0].textContent ?? "";
}

beforeEach(() => {
  localStorage.setItem("ottr.monitor.sidebarOpen", "1"); // 展开态（默认收起）
  useWorkspaceStore.setState({ mainView: "terminal", dockTabs: [], dockActive: null });
  useSessionStore.setState({ sessions: [fakeSession()], activeId: "sess-1" });
  useVaultStore.setState({ hosts: [fakeHost], hostGroups: [], credentials: [], loading: false, error: null });
  useMonitorStore.setState({ windows: { "pty-1": win(42, [40, 41, 42]) } });
});

afterEach(() => {
  cleanup();
  localStorage.removeItem("ottr.monitor.sidebarOpen");
});

describe("MainArea 实体视图 ↔ 监控侧栏让位（指标连续性）", () => {
  it("切 overview 侧栏让位、数据源持续；切回后侧栏即显最新窗口（不重置）", () => {
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    expect(cpuValue()).toBe("42%");
    const terminalBefore = screen.getByTestId("terminal-area");

    // 切 overview：监控侧栏卸载让位；终端 DOM 仍在（不变量）
    act(() => {
      useWorkspaceStore.getState().openMainView("overview");
    });
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull();
    expect(screen.getByTestId("overview-panel")).toBeTruthy();
    expect(screen.getByTestId("terminal-area")).toBeTruthy();

    // 让位期间采样事件照常到达（事件源在 Rust、store 挂模块作用域——与视图无关）
    act(() => {
      useMonitorStore.setState({ windows: { "pty-1": win(77, [40, 41, 42, 60, 77]) } });
    });
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull(); // 仍无挂载面

    // 切回终端：侧栏重挂即显最新值（窗口未丢未重置）+ 终端同一实例
    act(() => {
      useWorkspaceStore.getState().openMainView("terminal");
    });
    expect(screen.getByTestId("monitor-sidebar")).toBeTruthy();
    expect(cpuValue()).toBe("77%");
    expect(screen.getAllByTestId("monitor-metric").length).toBe(5);
    expect(screen.getByTestId("terminal-area")).toBe(terminalBefore);
  });

  it("切 batch 同制式：侧栏让位后切回，指标仍连续", () => {
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    act(() => {
      useWorkspaceStore.getState().openMainView("batch");
    });
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull();
    expect(screen.getByTestId("batch-panel")).toBeTruthy();
    act(() => {
      useMonitorStore.setState({ windows: { "pty-1": win(55, [50, 55]) } });
    });
    act(() => {
      useWorkspaceStore.getState().openMainView("terminal");
    });
    expect(cpuValue()).toBe("55%");
  });
});
