// TabBar / HostKeyDialog 组件测试（Task 7 Step 4）：
// 开 3 会话切换/关闭/恢复 + 状态灯映射 + 重连计数徽标 + TOFU 确认框两态。
// 直接 seed zustand store（SessionStore 状态机单测另有专文件），invoke 全量 mock。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import "../i18n";
import { TabBar } from "./TabBar";
import { HostKeyDialog } from "./HostKeyDialog";
import { OPEN_TABS_KEY, useSessionStore, type Session } from "./SessionStore";
import { useModalStore } from "../ui/modalStore";
import { useWorkspaceStore } from "../workspace/workspaceStore";

const mockedInvoke = invoke as unknown as Mock;

function makeSession(over: Partial<Session> & Pick<Session, "id" | "hostId" | "hostName">): Session {
  return {
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "disconnected",
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

function seedThreeTabs() {
  useSessionStore.setState({
    sessions: [
      makeSession({ id: "t1", hostId: 1, hostName: "web-01", status: "connected", rustId: "pty-1" }),
      makeSession({ id: "t2", hostId: 2, hostName: "db-01", status: "reconnecting", attempt: 2 }),
      makeSession({ id: "t3", hostId: 3, hostName: "cache-01", status: "waiting_host_key" }),
    ],
    activeId: "t1",
    settings: { maxReconnectAttempts: 5 },
  });
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify([1, 2, 3]));
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], activeId: null, hostKeyAsk: null });
  useModalStore.setState({ active: null });
});

describe("TabBar（3 会话：切换/关闭/状态灯）", () => {
  it("渲染 3 标签 + 状态灯 data-status + 重连计数徽标", () => {
    seedThreeTabs();
    render(<TabBar />);
    expect(screen.getByTestId("tab-web-01")).toBeTruthy();
    expect(screen.getByTestId("tab-db-01")).toBeTruthy();
    expect(screen.getByTestId("tab-cache-01")).toBeTruthy();
    expect(screen.getByTestId("tab-dot-web-01").getAttribute("data-status") ?? "").toBe("");
    expect(screen.getByTestId("tab-db-01").getAttribute("data-status")).toBe("reconnecting");
    expect(screen.getByTestId("tab-cache-01").getAttribute("data-status")).toBe("waiting_host_key");
    expect(screen.getByTestId("tab-retry-db-01").textContent).toBe("2/5");
  });

  it("点击切换激活标签（aria-selected / data-active）", () => {
    seedThreeTabs();
    render(<TabBar />);
    expect(screen.getByTestId("tab-web-01").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("tab-cache-01"));
    expect(useSessionStore.getState().activeId).toBe("t3");
    expect(screen.getByTestId("tab-cache-01").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("tab-web-01").getAttribute("aria-selected")).toBe("false");
  });

  it("关闭中间标签：无 rustId 不发 drop_session；激活位与持久化正确更新", async () => {
    seedThreeTabs();
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab db-01" }));
    // db-01 处于重连中（rustId=null）：没有 Rust 会话可 drop
    await waitFor(() => expect(mockedInvoke).not.toHaveBeenCalled());
    expect(useSessionStore.getState().sessions.map((s) => s.hostName)).toEqual([
      "web-01",
      "cache-01",
    ]);
    expect(useSessionStore.getState().activeId).toBe("t1");
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([1, 3]);
  });

  it("关闭非激活标签：drop_session 只针对被关标签的 rustId；激活位不变", async () => {
    seedThreeTabs();
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab cache-01" }));
    await waitFor(() =>
      expect(mockedInvoke).not.toHaveBeenCalled(), // cache-01 无 rustId，不发 drop
    );
    expect(useSessionStore.getState().sessions.map((s) => s.hostName)).toEqual([
      "web-01",
      "db-01",
    ]);
    expect(useSessionStore.getState().activeId).toBe("t1");
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([1, 2]);
  });

  it("关闭激活标签：激活位顺延到最后一个存活标签", async () => {
    seedThreeTabs();
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab web-01" }));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-1" }),
    );
    expect(useSessionStore.getState().activeId).toBe("t3");
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([2, 3]);
  });

  it("无标签时不渲染", () => {
    useSessionStore.setState({ sessions: [], activeId: null });
    useWorkspaceStore.setState({ overviewOpen: false });
    render(<TabBar />);
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

// 总览置顶标签（2026-10-16 用户需求：总览标签化、打开后始终显示在第一个）。
describe("TabBar 总览置顶标签", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ overviewOpen: false, mainView: "terminal" });
  });
  afterEach(() => {
    useWorkspaceStore.setState({ overviewOpen: false, mainView: "terminal" });
  });

  it("总览标签恒在第一位：点击激活总览视图；点会话标签激活会话并回终端视图", () => {
    seedThreeTabs();
    useWorkspaceStore.setState({ overviewOpen: true });
    render(<TabBar />);
    const bar = screen.getByRole("tablist");
    expect((bar.firstElementChild as HTMLElement).getAttribute("data-testid")).toBe("tab-overview");
    const overviewTab = screen.getByTestId("tab-overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(overviewTab);
    expect(useWorkspaceStore.getState().mainView).toBe("overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-web-01").getAttribute("data-active")).toBe("false");
    // 从总览视图点会话标签 = 离开总览（标签语义：点标签切到该标签内容）
    fireEvent.click(screen.getByTestId("tab-web-01"));
    expect(useSessionStore.getState().activeId).toBe("t1");
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
    // 总览标签保持打开（固定首位不因会话切换消失）
    expect(useWorkspaceStore.getState().overviewOpen).toBe(true);
  });

  it("关闭总览标签（✕）：标签消失；正显示总览时回终端视图", () => {
    useWorkspaceStore.setState({ overviewOpen: true, mainView: "overview" });
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab Overview" }));
    expect(useWorkspaceStore.getState().overviewOpen).toBe(false);
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
  });

  it("关闭总览标签时正看着其他视图：只关标签，视图不动", () => {
    seedThreeTabs();
    useWorkspaceStore.setState({ overviewOpen: true, mainView: "terminal" });
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close tab Overview" }));
    expect(useWorkspaceStore.getState().overviewOpen).toBe(false);
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
    expect(screen.queryByTestId("tab-overview")).toBeNull();
    expect(screen.getByTestId("tab-web-01")).toBeTruthy();
  });

  it("零会话但总览标签开：仅渲染总览一个标签（标签条不消失）", () => {
    useSessionStore.setState({ sessions: [], activeId: null });
    useWorkspaceStore.setState({ overviewOpen: true });
    render(<TabBar />);
    const bar = screen.getByRole("tablist");
    expect(bar.children).toHaveLength(1);
    expect(screen.getByTestId("tab-overview")).toBeTruthy();
  });
});

describe("HostKeyDialog（TOFU 两态）", () => {
  it("无问询时不渲染", () => {
    useSessionStore.setState({ hostKeyAsk: null });
    render(<HostKeyDialog />);
    expect(screen.queryByTestId("host-key-dialog")).toBeNull();
  });

  it("首连（kind=first）：指纹展示，信任=accent 主操作；确认发 host_key_decision(accept=true)", async () => {
    useSessionStore.setState({
      hostKeyAsk: {
        sessionId: "t1",
        host_id: 1,
        host_name: "web-01",
        fingerprint: "SHA256:FP1",
        kind: "first",
      },
    });
    useModalStore.getState().open("hostKey");
    render(<HostKeyDialog />);
    expect(screen.getByTestId("host-key-fingerprint").textContent).toBe("SHA256:FP1");
    const trust = screen.getByTestId("host-key-accept");
    expect(trust.className).toContain("btn-accent");
    expect(screen.getByTestId("host-key-accept").textContent).toContain("Trust");
    fireEvent.click(trust);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
        hostId: 1,
        fingerprint: "SHA256:FP1",
        accept: true,
      }),
    );
  });

  it("changed 强提醒：默认操作=拒绝（accent），仍要连接=danger；拒绝发 accept=false", async () => {
    useSessionStore.setState({
      hostKeyAsk: {
        sessionId: "t3",
        host_id: 3,
        host_name: "cache-01",
        fingerprint: "SHA256:FP2",
        kind: "changed",
      },
    });
    useModalStore.getState().open("hostKey");
    render(<HostKeyDialog />);
    expect(screen.getByTestId("host-key-reject").className).toContain("btn-accent");
    expect(screen.getByTestId("host-key-accept").className).toContain("btn-danger");
    expect(screen.getByText("WARNING: host key has changed!")).toBeTruthy();
    fireEvent.click(screen.getByTestId("host-key-reject"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
        hostId: 3,
        fingerprint: "SHA256:FP2",
        accept: false,
      }),
    );
  });
});

describe("TabBar 生产徽标（Phase 2 Task 11，B11）", () => {
  it("isProduction 会话渲染 PROD 徽标；普通会话无", () => {
    seedThreeTabs();
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((s) =>
        s.hostName === "db-01" ? { ...s, isProduction: true } : s,
      ),
    }));
    render(<TabBar />);
    expect(screen.getByTestId("tab-prod-db-01").textContent).toBe("PROD");
    expect(screen.queryByTestId("tab-prod-web-01")).toBeNull();
    expect(screen.queryByTestId("tab-prod-cache-01")).toBeNull();
  });
});
