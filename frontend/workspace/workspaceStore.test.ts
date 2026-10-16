// workspaceStore 单测（UI 批次一 Task 2 Step 1；2026-10-16 IA 重构随迁）：
// mainView 状态机互斥（含监控/插件会话子页签）/ 终端保留不变量（store 动作
// 永不触碰会话状态）/ 托盘关窗语义（store 活在模块作用域，窗口隐藏不重置）。
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore, type Session } from "../session/SessionStore";
import type { MainView } from "./types";

import { MAIN_VIEWS, useWorkspaceStore } from "./workspaceStore";

/** Session 测试夹具（只填必填面；store 不变量测试不触渲染字段）。 */
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

beforeEach(() => {
  // 回默认态：zustand 模块级单例，跨用例必须复位（防用例间互斥语义串扰）
  useWorkspaceStore.setState({ mainView: "terminal", overviewOpen: false });
  useSessionStore.setState({ sessions: [], activeId: null });
});

describe("mainView 状态机", () => {
  it("terminal 恒为默认", () => {
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
  });

  it("openMainView 五视图单值互斥：设新值即替换旧值", () => {
    for (const v of MAIN_VIEWS as readonly MainView[]) {
      useWorkspaceStore.getState().openMainView(v);
      expect(useWorkspaceStore.getState().mainView).toBe(v);
    }
    // 任意两两互斥抽查：切走 files 后其余视图不再在场
    useWorkspaceStore.getState().openMainView("files");
    const state = useWorkspaceStore.getState();
    expect(state.mainView).toBe("files");
    expect(MAIN_VIEWS.filter((v) => v !== "files")).not.toContain(state.mainView);
  });

  it("openMainView 幂等：重复设同值无变化", () => {
    useWorkspaceStore.getState().openMainView("overview");
    useWorkspaceStore.getState().openMainView("overview");
    expect(useWorkspaceStore.getState().mainView).toBe("overview");
  });
});

describe("总览置顶标签（2026-10-16 用户需求：总览标签化、打开后固定第一位）", () => {
  it("默认不开；openOverview 开标签并激活总览视图（幂等）", () => {
    const ws = () => useWorkspaceStore.getState();
    expect(ws().overviewOpen).toBe(false);
    ws().openOverview();
    expect(ws().overviewOpen).toBe(true);
    expect(ws().mainView).toBe("overview");
    ws().openOverview();
    expect(ws().overviewOpen).toBe(true);
    expect(ws().mainView).toBe("overview");
  });

  it("closeOverview：正显示总览时回终端视图；显示其他视图时只关标签不动视图", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().openOverview();
    ws().openMainView("files"); // 标签开着但用户在看文件视图
    ws().closeOverview();
    expect(ws().overviewOpen).toBe(false);
    expect(ws().mainView).toBe("files");
    ws().openOverview();
    ws().closeOverview();
    expect(ws().overviewOpen).toBe(false);
    expect(ws().mainView).toBe("terminal");
  });

  it("openOverview/closeOverview 均不触碰 SessionStore（终端保留不变量同源）", () => {
    const sess = fakeSession();
    useSessionStore.setState({ sessions: [sess], activeId: "sess-1" });
    const before = useSessionStore.getState().sessions;
    const ws = useWorkspaceStore.getState();
    ws.openOverview();
    ws.closeOverview();
    expect(useSessionStore.getState().sessions).toBe(before);
  });
});

describe("终端保留不变量（store 层）", () => {
  it("workspace 动作永不触碰 SessionStore：切视图/开关 dock 后会话原样保留", () => {
    const sess = fakeSession();
    const pane = fakeSession({ id: "sess-1-p1", paneOf: "sess-1", rustId: "pty-1-p1" });
    useSessionStore.setState({ sessions: [sess, pane], activeId: "sess-1-p1" });

    const before = useSessionStore.getState().sessions;
    const ws = useWorkspaceStore.getState();
    ws.openMainView("files");
    ws.openMainView("processes");
    ws.openMainView("overview");
    ws.openMainView("batch");
    ws.openMainView("cron");
    ws.openMainView("notifications");
    ws.openMainView("forwards");
    ws.openMainView("jumpchains");
    ws.openMainView("monitor");
    ws.openMainView("plugins");
    ws.openMainView("terminal");

    // 同一数组引用 = 会话 store 零 mutation（渲染侧终端 DOM 保留的状态前提）
    expect(useSessionStore.getState().sessions).toBe(before);
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().activeId).toBe("sess-1-p1");
    // 切回 terminal 恢复（store 无「离开终端」的残留状态）
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
  });
});
