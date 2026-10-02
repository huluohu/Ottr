// OverviewPage 20 主机规模渲染（Phase 3 Task 7 验收 · 性能维 P2）：
// 「多主机总览页 20 主机卡片」承诺的构造测试——12 实时卡（live 窗口）+
// 4 idle（开启未连）+ 4 off（未开启灰卡）= 20 卡一屏，断言全量出卡 +
// 灯位分布正确；jsdom 渲染耗时宽松上界防回归冒烟（精确基线数字以验收
// 报告实测为准——jsdom 与真 webview 渲染面不同源，不在此钉死毫秒红线）。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../i18n";
import { OverviewPage } from "./OverviewPage";
import { useMonitorStore, type MonitorWindow } from "./monitorStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";

function host(id: number, over: Partial<Host> = {}): Host {
  return {
    id,
    name: `host-${id}`,
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
    ...over,
  };
}

function makeSession(id: string, hostId: number): Session {
  return {
    id,
    hostId,
    hostName: `h${hostId}`,
    address: "10.0.0.1",
    port: 2222,
    username: null,
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: id,
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
  };
}

function liveWin(): MonitorWindow {
  return {
    status: "live",
    cpu: [42],
    mem: [61],
    load1: [1.2],
    netRx: [1024],
    netTx: [512],
    disk: [30],
    latest: {
      cpu_percent: 42,
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

beforeEach(() => {
  useVaultStore.setState({ hosts: [], hostGroups: [], credentials: [], loading: false, error: null });
  useSessionStore.setState({ sessions: [], activeId: null });
  useMonitorStore.setState({ windows: {} });
});

afterEach(() => {
  cleanup();
});

describe("OverviewPage 20 主机规模（T7 性能维构造测试）", () => {
  it("12 live + 4 idle + 4 off = 20 卡全量出卡，灯位分布正确", () => {
    const hosts: Host[] = [];
    const sessions: Session[] = [];
    const windows: Record<string, MonitorWindow> = {};
    for (let i = 1; i <= 12; i++) {
      hosts.push(host(i, { name: `live-${i}`, monitor_enabled: true }));
      sessions.push(makeSession(`pty-${i}`, i));
      windows[`pty-${i}`] = liveWin();
    }
    for (let i = 13; i <= 16; i++) {
      hosts.push(host(i, { name: `idle-${i}`, monitor_enabled: true }));
    }
    for (let i = 17; i <= 20; i++) {
      hosts.push(host(i, { name: `off-${i}`, monitor_enabled: false }));
    }
    useVaultStore.setState({ hosts });
    useSessionStore.setState({ sessions, activeId: null });
    useMonitorStore.setState({ windows });

    const t0 = performance.now();
    render(<OverviewPage open onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />);
    const renderMs = performance.now() - t0;

    const grid = screen.getByTestId("overview-grid");
    expect(grid.children.length).toBe(20);
    expect(screen.getByTestId("overview-card-1").querySelector(".overview-light")?.getAttribute("data-state")).toBe("live");
    expect(screen.getByTestId("overview-card-13").querySelector(".overview-light")?.getAttribute("data-state")).toBe("idle");
    expect(screen.getByTestId("overview-card-20").getAttribute("data-off")).toBe("true");
    // 宽松上界冒烟（防数量级回归；精确数字记录于验收报告，不钉 CI 毫秒红线）
    expect(renderMs, `20 卡 jsdom 渲染 ${renderMs.toFixed(1)}ms`).toBeLessThan(2000);
  });
});
