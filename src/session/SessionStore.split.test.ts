// 分屏会话流测试（Task 8 Step 3）：splitPane / closePane / closeTab（pane 连坐）/
// setPaneRatio / 持久化只记根。store 级逻辑（pane 树纯函数本身在 split.test.ts）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  OPEN_TABS_KEY,
  useSessionStore,
  type Session,
} from "./SessionStore";
import type { Host } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const hostA: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  protocol: "ssh",
  credential_id: 7,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    hostKeyAsk: null,
    settings: { maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS },
    trees: {},
    activePane: {},
    searchSessionId: null,
  });
  localStorage.clear();
}

function sess(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
    hostId: hostA.id,
    hostName: hostA.name,
    address: hostA.address,
    port: 22,
    username: "deploy",
    protocol: "ssh",
    status: "connected",
    rustId: null,
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    ...over,
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue("pty-1");
  resetStore();
});

afterEach(() => {
  useSessionStore.setState({ sessions: [], activeId: null, trees: {}, activePane: {} });
});

describe("分屏会话流（SessionStore.trees/activePane）", () => {
  it("splitPane：pane 会话挂到标签（paneOf）、树分裂、聚焦移交、连接同一主机", async () => {
    const tab = useSessionStore.getState().openTab(hostA);
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("attach_host_session", expect.anything()));
    const calls = mockedInvoke.mock.calls.filter(([c]) => c === "attach_host_session") as Array<
      [string, Record<string, unknown>]
    >;
    expect(calls[0][1].hostId).toBe(hostA.id);

    useSessionStore.getState().splitPane(tab, "row");
    const st = useSessionStore.getState();
    const pane = st.sessions.find((s) => s.paneOf === tab);
    expect(pane).toBeTruthy();
    expect(st.trees[tab].kind).toBe("split");
    expect(st.activePane[tab]).toBe(pane!.id);
    // 分屏即连同一主机（新 pane 自己的 attach）
    await vi.waitFor(() =>
      expect(
        mockedInvoke.mock.calls.filter(([c]) => c === "attach_host_session").length,
      ).toBe(2),
    );
    const second = mockedInvoke.mock.calls.filter(
      ([c]) => c === "attach_host_session",
    )[1] as unknown as [string, Record<string, unknown>];
    expect(second[1].hostId).toBe(hostA.id);
  });

  it("closePane（中间 pane）：会话移除、drop_session、树回收、聚焦移交存活 pane", async () => {
    const tab = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    useSessionStore.setState({ sessions: [sess({ id: tab, rustId: "pty-root" })] });
    useSessionStore.getState().splitPane(tab, "row");
    const pane = useSessionStore.getState().sessions.find((s) => s.paneOf === tab)!;
    // 给 pane 一个 rustId，验证关闭时 drop
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((s) => (s.id === pane.id ? { ...s, rustId: "pty-pane" } : s)),
    }));

    useSessionStore.getState().closePane(pane.id);
    const st = useSessionStore.getState();
    expect(st.sessions.some((s) => s.id === pane.id)).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-pane" });
    expect(st.trees[tab].kind, "兄弟提升后回收为叶").toBe("leaf");
    expect(st.activePane[tab]).toBe(tab);
  });

  it("closePane（最后一个 pane）= 关标签：树删除、根会话移除", () => {
    const tab = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    useSessionStore.getState().splitPane(tab, "column");
    const pane = useSessionStore.getState().sessions.find((s) => s.paneOf === tab)!;
    useSessionStore.getState().closePane(pane.id);
    useSessionStore.getState().closePane(tab); // 只剩根 pane → 关标签
    const st = useSessionStore.getState();
    expect(st.sessions).toHaveLength(0);
    expect(st.trees[tab]).toBeUndefined();
    expect(st.activePane[tab]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([]);
  });

  it("closeTab：分屏 pane 连坐收尾（逐个 drop + 树删除 + 持久化只记根）", async () => {
    const tab = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    useSessionStore.setState({ sessions: [sess({ id: tab, rustId: "pty-root" })] });
    useSessionStore.getState().splitPane(tab, "row");
    const pane = useSessionStore.getState().sessions.find((s) => s.paneOf === tab)!;
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((s) => (s.id === pane.id ? { ...s, rustId: "pty-pane" } : s)),
    }));

    useSessionStore.getState().closeTab(tab);
    const st = useSessionStore.getState();
    expect(st.sessions).toHaveLength(0);
    expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-root" });
    expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-pane" });
    expect(st.trees[tab]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([]);
  });

  it("setPaneRatio：写入指定 split 节点（clamp 委托 split.ts）", () => {
    const tab = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    useSessionStore.getState().splitPane(tab, "row");
    useSessionStore.getState().splitPane(tab, "row");
    useSessionStore.getState().setPaneRatio(tab, [], 0.9);
    const tree = useSessionStore.getState().trees[tab];
    expect(tree.kind === "split" && tree.ratio).toBe(0.85); // clamp 上限
  });

  it("openSearch/closeSearch：搜索目标会话", () => {
    useSessionStore.getState().openSearch("tab-1");
    expect(useSessionStore.getState().searchSessionId).toBe("tab-1");
    useSessionStore.getState().openSearch(null);
    expect(useSessionStore.getState().searchSessionId).toBeNull();
  });
});
