// OverviewPage 组件测试（Phase 3 Task 2 Step 3）：纯函数（灯位/排序/反查）
// + 卡片网格渲染（实时卡指标/灰卡降级/状态文案）+ 动作分派（跳转/进程）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { OverviewPage, overviewLight, rootRustIdByHost, sortForOverview } from "./OverviewPage";
import { useMonitorStore, type MonitorWindow } from "./monitorStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host, HostInput } from "../vault/api";

function host(over: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return {
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

function makeSession(over: Partial<Session> & Pick<Session, "id" | "hostId">): Session {
  return {
    hostName: "h",
    address: "10.0.0.1",
    port: 2222,
    username: null,
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: null,
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

function win(over: Partial<MonitorWindow> = {}): MonitorWindow {
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
        { filesystem: "sdb", total_kb: 100, used_kb: 90, avail_kb: 10, used_percent: 90, mount: "/data" },
      ],
    },
    ...over,
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

describe("OverviewPage 纯函数", () => {
  it("overviewLight：off/idle/窗口状态三段映射", () => {
    expect(overviewLight(undefined, false), "未开启 = off").toBe("off");
    expect(overviewLight({ status: "live" } as MonitorWindow, false), "off 优先于窗口").toBe("off");
    expect(overviewLight(undefined, true), "开启但无窗 = idle").toBe("idle");
    expect(overviewLight({ status: "live" } as MonitorWindow, true)).toBe("live");
    expect(overviewLight({ status: "unsupported" } as MonitorWindow, true)).toBe("unsupported");
    expect(overviewLight({ status: "stopped" } as MonitorWindow, true)).toBe("stopped");
  });

  it("sortForOverview：监控主机在前，组内按名称", () => {
    const sorted = sortForOverview([
      host({ id: 1, name: "zeta", monitor_enabled: false }),
      host({ id: 2, name: "alpha", monitor_enabled: true }),
      host({ id: 3, name: "mike", monitor_enabled: true }),
      host({ id: 4, name: "aaa", monitor_enabled: false }),
    ]);
    expect(sorted.map((h) => h.id), "监控在前；组内名称序（aaa < zeta）").toEqual([2, 3, 4, 1]);
  });

  it("rootRustIdByHost：只收标签根会话且 rustId 非空", () => {
    const map = rootRustIdByHost([
      makeSession({ id: "t1", hostId: 1, rustId: "pty-1" }),
      makeSession({ id: "t2", hostId: 2, rustId: null, status: "connecting" }),
      makeSession({ id: "t3", hostId: 1, rustId: "pty-3", paneOf: "t1" }),
    ]);
    expect(map.get(1)).toBe("pty-1");
    expect(map.has(2), "rustId 为空不入表").toBe(false);
  });
});

describe("OverviewPage 卡片网格", () => {
  it("监控主机实时卡：状态灯 live + CPU/内存/磁盘迷你指标；点击跳转 onOpen", () => {
    useVaultStore.setState({
      hosts: [host({ id: 7, name: "web-01", monitor_enabled: true })],
    });
    useSessionStore.setState({ sessions: [makeSession({ id: "t1", hostId: 7, rustId: "pty-7" })] });
    useMonitorStore.setState({ windows: { "pty-7": win() } });
    const onOpen = vi.fn();
    const onOpenProcesses = vi.fn();
    render(
      <OverviewPage onClose={() => {}} onOpen={onOpen} onOpenProcesses={onOpenProcesses} />,
    );

    const card = screen.getByTestId("overview-card-7");
    expect(card.querySelector(".overview-light")?.getAttribute("data-state")).toBe("live");
    // 三条迷你指标，数值取窗口 latest（磁盘 = 根挂载点口径 30%，非最高 90%）
    const bars = screen.getAllByTestId("overview-metric");
    expect(bars.length).toBe(3);
    expect(card.textContent).toContain("42%");
    expect(card.textContent).toContain("61%");
    expect(card.textContent).toContain("30%");

    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe(7);
    expect(onOpenProcesses).not.toHaveBeenCalled();
  });

  it("已连接主机卡「进程」按钮 → onOpenProcesses；未连接禁用", () => {
    useVaultStore.setState({
      hosts: [host({ id: 7, name: "web-01", monitor_enabled: true })],
    });
    useSessionStore.setState({ sessions: [makeSession({ id: "t1", hostId: 7, rustId: "pty-7" })] });
    useMonitorStore.setState({ windows: { "pty-7": win() } });
    const onOpen = vi.fn();
    const onOpenProcesses = vi.fn();
    render(
      <OverviewPage onClose={() => {}} onOpen={onOpen} onOpenProcesses={onOpenProcesses} />,
    );

    const btn = screen.getByTestId("overview-proc-7");
    fireEvent.click(btn);
    expect(onOpenProcesses).toHaveBeenCalledTimes(1);
    expect(onOpenProcesses.mock.calls[0][0].id).toBe(7);
    expect(onOpen, "按钮点击不冒泡成卡片跳转").not.toHaveBeenCalled();
  });

  it("未开启监控主机灰卡（off + 提示文案）；开启但未连接 idle 态", () => {
    useVaultStore.setState({
      hosts: [host({ id: 1, name: "off-host", monitor_enabled: false }), host({ id: 2, name: "idle-host", monitor_enabled: true })],
    });
    render(
      <OverviewPage onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />,
    );

    const offCard = screen.getByTestId("overview-card-1");
    expect(offCard.getAttribute("data-off")).toBe("true");
    expect(offCard.textContent).toContain("Monitoring off");
    expect(offCard.querySelector(".overview-light")?.getAttribute("data-state")).toBe("off");

    const idleCard = screen.getByTestId("overview-card-2");
    expect(idleCard.getAttribute("data-off")).toBe("false");
    expect(idleCard.textContent).toContain("Not connected");
    expect(idleCard.querySelector(".overview-light")?.getAttribute("data-state")).toBe("idle");
  });

  it("unsupported / stopped 窗口状态上灯位与文案；卸载后不渲染（挂载域 = MainArea 路由互斥，UI 批次一 T3 迁主区视图）", () => {
    useVaultStore.setState({
      hosts: [host({ id: 1, name: "a", monitor_enabled: true }), host({ id: 2, name: "b", monitor_enabled: true })],
    });
    useSessionStore.setState({
      sessions: [
        makeSession({ id: "t1", hostId: 1, rustId: "pty-1" }),
        makeSession({ id: "t2", hostId: 2, rustId: "pty-2" }),
      ],
    });
    useMonitorStore.setState({
      windows: {
        "pty-1": win({ status: "unsupported", latest: null }),
        "pty-2": win({ status: "stopped", latest: null }),
      },
    });
    const { unmount } = render(
      <OverviewPage onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />,
    );
    expect(screen.getByTestId("overview-card-1").querySelector(".overview-light")?.getAttribute("data-state")).toBe("unsupported");
    expect(screen.getByTestId("overview-card-2").querySelector(".overview-light")?.getAttribute("data-state")).toBe("stopped");

    // 迁主区后无 open 门：卸载 = 关闭（原 open=false 断言等价迁移——不在 DOM）
    unmount();
    expect(screen.queryByTestId("overview-panel")).toBeNull();
  });
});

// ui-batch2 Task 3（审计 A4 清偿）：「未开启监控」灰卡从纯提示（主机表单 →
// 监控面板深路径）升级为卡内一键「开启监控」——动作 = 既有 updateHost 全量
// 语义（HostInput 由 host 记录推导、只翻 monitor_enabled，HostForm update
// 语义的轻量复用，零新增数据依赖）。
describe("OverviewPage off 卡一键开启监控（ui2 T3，审计 A4）", () => {
  it("off 卡渲染「开启监控」；点击发 updateHost(id, input)——monitor_enabled=true 且其余字段保持", async () => {
    const off = host({ id: 5, name: "off-host", notes: "keep-me", monitor_enabled: false });
    const updateHost = vi.fn(async (_id: number, _input: HostInput) => ({
      ...off,
      monitor_enabled: true,
    }));
    useVaultStore.setState({ hosts: [off], updateHost });
    render(<OverviewPage onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />);

    const btn = screen.getByTestId("overview-monitor-on-5");
    fireEvent.click(btn);
    expect(updateHost).toHaveBeenCalledTimes(1);
    const [id, input] = updateHost.mock.calls[0];
    expect(id).toBe(5);
    expect(input.monitor_enabled).toBe(true);
    // 全量替换式提交的保真面：除开关外逐字段取自 host 记录
    expect(input.name).toBe("off-host");
    expect(input.address).toBe("10.0.0.1");
    expect(input.notes).toBe("keep-me");
  });

  it("按钮点击不冒泡成卡片跳转；非 ssh 与已开启主机不渲染按钮", () => {
    useVaultStore.setState({
      hosts: [
        host({ id: 5, name: "ssh-off", monitor_enabled: false }),
        host({ id: 6, name: "ftp-off", protocol: "ftp", monitor_enabled: false }),
        host({ id: 7, name: "ssh-on", monitor_enabled: true }),
      ],
    });
    const onOpen = vi.fn();
    render(<OverviewPage onClose={() => {}} onOpen={onOpen} onOpenProcesses={() => {}} />);
    expect(screen.getByTestId("overview-monitor-on-5")).toBeTruthy();
    expect(screen.queryByTestId("overview-monitor-on-6"), "监控面是 ssh 专属，ftp 不出开启入口").toBeNull();
    expect(screen.queryByTestId("overview-monitor-on-7"), "已开启主机非 off 态，不出开启入口").toBeNull();
    fireEvent.click(screen.getByTestId("overview-monitor-on-5"));
    expect(onOpen, "按钮点击不冒泡成卡片跳转").not.toHaveBeenCalled();
  });

  // ui2 T4（A5 清偿·三态扫描）：updateHost 会 rethrow——此前无 catch =
  // unhandled rejection + 按钮静默回弹（用户点了没反应）。
  it("开启失败 → 头部错误面（主机名+原因上屏）；按钮恢复可用可重试", async () => {
    const off = host({ id: 5, name: "off-host", monitor_enabled: false });
    const updateHost = vi.fn(async (_id: number, _input: HostInput) => {
      throw new Error("vault is locked");
    });
    useVaultStore.setState({ hosts: [off], updateHost });
    render(<OverviewPage onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />);

    fireEvent.click(screen.getByTestId("overview-monitor-on-5"));
    const err = await screen.findByTestId("overview-enable-error");
    expect(err.textContent).toContain("off-host");
    expect(err.textContent).toContain("vault is locked");
    expect((screen.getByTestId("overview-monitor-on-5") as HTMLButtonElement).disabled).toBe(false);
  });
});
