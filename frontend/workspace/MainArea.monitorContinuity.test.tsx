// 监控面板连续性测试（2026-10-16 IA 重构随迁）：监控转为会话子页签后，
// 连续性主张不变——数据真源 useMonitorStore 挂模块作用域（事件驱动持续
// 灌入，与视图挂载无关）——切走子页签再切回，即读即显最新窗口，不重置。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../forward/ForwardPanel", () => ({ ForwardPanel: () => <div data-testid="fw" /> }));
vi.mock("../hosts/JumpChainEditor", () => ({ JumpChainEditor: () => <div data-testid="jc" /> }));
vi.mock("../cron/CronPanel", () => ({ CronPanel: () => <div data-testid="cron" /> }));
vi.mock("../notify/AlertSettings", () => ({ AlertSettings: () => <div data-testid="alerts" /> }));
vi.mock("../security/McpSettings", () => ({ McpSettings: () => <div data-testid="mcp" /> }));
vi.mock("../notify/NotificationCenter", () => ({
  NotificationCenter: () => <div data-testid="nc" />,
}));
vi.mock("../terminal/Terminal", () => ({ TerminalArea: () => <div data-testid="term" /> }));
vi.mock("../history/RecordToggle", () => ({ RecordToggle: () => <div data-testid="record" /> }));
vi.mock("../ai/DiagnosePanel", () => ({ DiagnosePanel: () => <div data-testid="diag" /> }));
vi.mock("../home/HomeWelcome", () => ({ HomeWelcome: () => <div data-testid="welcome" /> }));

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
  // 指标行序：CPU 在首位（MonitorPanel MetricRow 顺序）
  return screen.getAllByTestId("monitor-metric-value")[0].textContent ?? "";
}

const noop = () => {};

function renderMainArea() {
  return render(
    <MainArea
      storeError={null}
      selected={null}
      onOpenAiSettings={noop}
      onAddHost={noop}
      onOpenPalette={noop}
      onOpenImport={noop}
      onOpenAlerts={noop}
    />,
  );
}

function openMonitorView() {
  act(() => {
    useWorkspaceStore.getState().openMainView("monitor");
  });
}

function closeMonitorView() {
  act(() => {
    useWorkspaceStore.getState().openMainView("terminal");
  });
}

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", overviewOpen: false });
  useSessionStore.setState({ sessions: [fakeSession()], activeId: "sess-1" });
  useVaultStore.setState({ hosts: [fakeHost], hostGroups: [], credentials: [], loading: false, error: null });
  useMonitorStore.setState({ windows: { "pty-1": win(42, [40, 41, 42]) } });
});

afterEach(cleanup);

describe("监控面板（会话子页签）指标连续性", () => {
  it("子页签打开即显当前窗口；切走期间采样照常灌入；切回即显最新（不重置）", () => {
    renderMainArea();
    openMonitorView();
    expect(cpuValue()).toBe("42%");
    expect(screen.getAllByTestId("monitor-metric").length).toBe(5);

    // 切回终端子页签：面板卸载；数据源（store）仍在模块作用域持续更新
    closeMonitorView();
    expect(screen.queryByTestId("monitor-metric")).toBeNull();
    act(() => {
      useMonitorStore.setState({ windows: { "pty-1": win(77, [40, 41, 42, 60, 77]) } });
    });

    // 切回：即显最新窗口（未丢未重置）
    openMonitorView();
    expect(cpuValue()).toBe("77%");
    expect(screen.getAllByTestId("monitor-metric").length).toBe(5);
  });

  it("主机未开启监控 → off 指引面（非 live 窗口时 StatusFace 口径）", () => {
    useVaultStore.setState({ hosts: [{ ...fakeHost, monitor_enabled: false }], hostGroups: [], credentials: [], loading: false, error: null });
    useMonitorStore.setState({ windows: {} }); // off 面仅非 live 生效（live 压过状态面）
    renderMainArea();
    openMonitorView();
    expect(screen.getByTestId("monitor-off")).toBeTruthy();
  });
});
