// workspaceStore 单测（UI 批次一 Task 2 Step 1）：mainView 状态机互斥 /
// dockPanel 单槽互斥 / toggleDock 开关语义 / 终端保留不变量（store 动作永不
// 触碰会话状态）/ 托盘关窗语义（store 活在模块作用域，窗口隐藏不重置）。
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionStore, type Session } from "../session/SessionStore";
import { DOCK_PANELS, MAIN_VIEWS, TOOL_DOCK_PANELS, type DockPanel, type MainView } from "./types";
import { useWorkspaceStore } from "./workspaceStore";

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
  useWorkspaceStore.setState({ mainView: "terminal", dockTabs: [], dockActive: null });
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

describe("dock 多页签（共存 + 激活，2026-10-09 根治互相覆盖）", () => {
  it("默认空（dock 关闭）", () => {
    expect(useWorkspaceStore.getState().dockTabs).toEqual([]);
    expect(useWorkspaceStore.getState().dockActive).toBeNull();
  });

  it("openDock：新页签追加并激活；重复打开仅激活（不重复追加）", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().openDock("cron");
    ws().openDock("alerts");
    expect(ws().dockTabs).toEqual(["cron", "alerts"]);
    expect(ws().dockActive).toBe("alerts");
    ws().openDock("cron");
    expect(ws().dockTabs).toEqual(["cron", "alerts"]); // 不重复追加
    expect(ws().dockActive).toBe("cron"); // 仅激活
  });

  it("切换不互相关闭（根治「开 A 顶掉 B」的核心不变量）", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().openDock("cron");
    ws().openDock("alerts");
    ws().openDock("mcp");
    ws().openDock("cron"); // 切回最先打开的页签
    expect(ws().dockTabs).toEqual(["cron", "alerts", "mcp"]); // 三页签共存
    expect(ws().dockActive).toBe("cron");
  });

  it("closeTab：关活动页活动权移交右邻，关尾页签回落最右；关非活动页不影响激活", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().openDock("cron");
    ws().openDock("alerts");
    ws().openDock("mcp");
    ws().openDock("alerts"); // active=alerts, tabs=[cron,alerts,mcp]
    ws().closeTab("alerts");
    expect(ws().dockTabs).toEqual(["cron", "mcp"]);
    expect(ws().dockActive).toBe("mcp"); // 右邻
    ws().closeTab("mcp"); // 关尾页签 → 回落
    expect(ws().dockTabs).toEqual(["cron"]);
    expect(ws().dockActive).toBe("cron");
    ws().openDock("alerts");
    ws().closeTab("cron"); // 关非活动页（激活不动）
    expect(ws().dockTabs).toEqual(["alerts"]);
    expect(ws().dockActive).toBe("alerts");
  });

  it("closeDock 清空全部页签；对已空状态幂等", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().openDock("alerts");
    ws().closeDock();
    expect(ws().dockTabs).toEqual([]);
    expect(ws().dockActive).toBeNull();
    ws().closeDock();
    expect(ws().dockTabs).toEqual([]);
  });

  it("toggleDock：活动页同值关、异值开/激活（异值不关闭已开页签）", () => {
    const ws = () => useWorkspaceStore.getState();
    ws().toggleDock("mcp");
    expect(ws().dockActive).toBe("mcp");
    ws().toggleDock("mcp");
    expect(ws().dockActive).toBeNull();
    ws().toggleDock("cron");
    ws().toggleDock("mcp"); // 异值 = 打开/激活新页签，cron 页签保留
    expect(ws().dockTabs).toEqual(["cron", "mcp"]);
    expect(ws().dockActive).toBe("mcp");
  });

  it("工具面板六值集合与类型口径一致（防漂移）", () => {
    expect(TOOL_DOCK_PANELS).toEqual([
      "forwards",
      "jumpchains",
      "cron",
      "alerts",
      "mcp",
      "notifications",
    ]);
    // 全量 DockPanel = 侧栏二值 + 工具六值
    expect(DOCK_PANELS).toEqual(["monitor", "plugins", ...TOOL_DOCK_PANELS]);
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
    ws.openMainView("terminal");
    ws.openDock("forwards");
    ws.toggleDock("cron");
    ws.closeDock();

    // 同一数组引用 = 会话 store 零 mutation（渲染侧终端 DOM 保留的状态前提）
    expect(useSessionStore.getState().sessions).toBe(before);
    expect(useSessionStore.getState().sessions).toHaveLength(2);
    expect(useSessionStore.getState().activeId).toBe("sess-1-p1");
    // 切回 terminal 恢复（store 无「离开终端」的残留状态）
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
  });
});
