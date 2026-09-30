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

const mockedInvoke = invoke as unknown as Mock;

function makeSession(over: Partial<Session> & Pick<Session, "id" | "hostId" | "hostName">): Session {
  return {
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    status: "disconnected",
    rustId: null,
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
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
    render(<TabBar />);
    expect(screen.queryByRole("tablist")).toBeNull();
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
