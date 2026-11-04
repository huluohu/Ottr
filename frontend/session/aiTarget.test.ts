// AI 终端目标单测（Ask Ottr，Task 2）：聚焦 pane 解析（A/B 主机、根/子 pane、
// 无回退）、目标捕获（rootTabId、hostId 归属、ftp/无连接拒绝）、目标存活
// （pane/kind/host/rustId/epoch 五元全等）。纯函数测试：直接构造状态切片，
// 不经 store（store 级集成在 SessionStore.test.ts）。
import { describe, expect, it } from "vitest";
import {
  captureAiTarget,
  currentEpoch,
  isAiTargetLive,
  isTerminalSession,
  resolveFocusedTerminal,
  type AiFocusState,
  type AiScopeTarget,
} from "./aiTarget";
import type { Session } from "./types";

/** 会话夹具：默认 = hostA(id=1) 的已连接 SSH 根会话。 */
function sess(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
    hostId: 1,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-a",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    connectionEpoch: 1,
    ...over,
  };
}

function state(
  sessions: Session[],
  activeId: string | null,
  activePane: Record<string, string> = {},
): AiFocusState {
  return { sessions, activeId, activePane };
}

describe("resolveFocusedTerminal（聚焦 pane 解析，无回退）", () => {
  it("A/B 两主机：只解析 activeId 指向的 A，绝不漂移到 B", () => {
    const a = sess({ id: "tab-a" });
    const b = sess({ id: "tab-b", hostId: 2, hostName: "db-01", rustId: "pty-b" });
    const st = state([a, b], "tab-a", { "tab-a": "tab-a", "tab-b": "tab-b" });
    const focused = resolveFocusedTerminal(st);
    expect(focused?.id).toBe("tab-a");
    expect(focused?.hostId).toBe(1);
    expect(focused?.id).not.toBe("tab-b");
  });

  it("同主机双标签（forceNew 语义）：解析活动标签，非「最近打开的另一个」", () => {
    const t1 = sess({ id: "tab-1" });
    const t2 = sess({ id: "tab-2", rustId: "pty-2" }); // 同 hostId=1
    expect(resolveFocusedTerminal(state([t1, t2], "tab-2", { "tab-2": "tab-2" }))?.id).toBe(
      "tab-2",
    );
    expect(resolveFocusedTerminal(state([t1, t2], "tab-1", { "tab-1": "tab-1" }))?.id).toBe(
      "tab-1",
    );
  });

  it("分屏：聚焦子 pane 解析子 pane 会话，不是标签根", () => {
    const root = sess({ id: "tab-root" });
    const pane = sess({ id: "pane-1", paneOf: "tab-root", rustId: "pty-p1" });
    const focused = resolveFocusedTerminal(
      state([root, pane], "tab-root", { "tab-root": "pane-1" }),
    );
    expect(focused?.id).toBe("pane-1");
    expect(focused?.paneOf).toBe("tab-root");
  });

  it("无活动标签（activeId=null）→ null", () => {
    const a = sess({ id: "tab-a" });
    expect(resolveFocusedTerminal(state([a], null))).toBeNull();
  });

  it("activeId 指向不存在的会话 → null（不回退到数组里其他会话）", () => {
    const a = sess({ id: "tab-a" });
    expect(resolveFocusedTerminal(state([a], "tab-gone"))).toBeNull();
  });

  it("activePane 指向已移除的 pane → null（聚焦失效 ≠ 允许漂移到根）", () => {
    const root = sess({ id: "tab-root" });
    expect(
      resolveFocusedTerminal(state([root], "tab-root", { "tab-root": "pane-gone" })),
    ).toBeNull();
  });

  it("未连接/连接中（rustId=null）→ null", () => {
    const off = sess({ id: "tab-off", status: "disconnected", rustId: null });
    expect(resolveFocusedTerminal(state([off], "tab-off"))).toBeNull();
    const connecting = sess({ id: "tab-conn", status: "connecting", rustId: null });
    expect(resolveFocusedTerminal(state([connecting], "tab-conn"))).toBeNull();
  });

  it("重连中（rustId 已清）→ null；重连成功后的 connected 才可解析", () => {
    const rec = sess({ id: "tab-rec", status: "reconnecting", rustId: null, attempt: 1 });
    expect(resolveFocusedTerminal(state([rec], "tab-rec"))).toBeNull();
  });

  it("ftp/ftps（纯文件会话，无 PTY）→ null", () => {
    const ftp = sess({ id: "tab-ftp", protocol: "ftp" });
    expect(resolveFocusedTerminal(state([ftp], "tab-ftp"))).toBeNull();
    const ftps = sess({ id: "tab-ftps", protocol: "ftps" });
    expect(resolveFocusedTerminal(state([ftps], "tab-ftps"))).toBeNull();
  });

  it("本地终端（kind=local）已连接 → 可解析", () => {
    const local = sess({
      id: "tab-local",
      kind: "local",
      hostId: -1,
      rustId: "local-1",
    });
    const focused = resolveFocusedTerminal(state([local], "tab-local"));
    expect(focused?.id).toBe("tab-local");
    expect(focused?.kind).toBe("local");
  });

  it("kind 缺省（存量夹具）+ protocol=ssh → 按 ssh 解析", () => {
    const legacy = sess({ id: "tab-legacy", kind: undefined });
    expect(resolveFocusedTerminal(state([legacy], "tab-legacy"))?.id).toBe("tab-legacy");
  });
});

describe("captureAiTarget（不可变目标捕获）", () => {
  it("根会话：paneSessionId = rootTabId = 会话 id；五元齐全", () => {
    const t = captureAiTarget(sess({ id: "tab-a" }));
    expect(t).toEqual({
      paneSessionId: "tab-a",
      rootTabId: "tab-a",
      rustId: "pty-a",
      connectionEpoch: 1,
      kind: "ssh",
      hostId: 1,
    });
  });

  it("分屏子 pane：rootTabId = paneOf（标签根），paneSessionId = pane 自己", () => {
    const pane = sess({ id: "pane-1", paneOf: "tab-root", rustId: "pty-p1" });
    const t = captureAiTarget(pane);
    expect(t.paneSessionId).toBe("pane-1");
    expect(t.rootTabId).toBe("tab-root");
  });

  it("rustId=null（未连接）→ 拒绝捕获（抛错）", () => {
    expect(() => captureAiTarget(sess({ id: "x", rustId: null }))).toThrow();
  });

  it("ftp/ftps（无终端）→ 拒绝捕获", () => {
    expect(() => captureAiTarget(sess({ id: "x", protocol: "ftp" }))).toThrow();
    expect(() => captureAiTarget(sess({ id: "x", protocol: "ftps" }))).toThrow();
  });

  it("本地终端：kind=local、hostId=null（-1 哨兵不出前端域）", () => {
    const t = captureAiTarget(
      sess({ id: "loc", kind: "local", hostId: -1, rustId: "local-1" }),
    );
    expect(t.kind).toBe("local");
    expect(t.hostId).toBeNull();
  });

  it("connectionEpoch 快照取当时代数；存量夹具（无字段）按 0 兼容", () => {
    expect(captureAiTarget(sess({ id: "x", connectionEpoch: 7 })).connectionEpoch).toBe(7);
    const legacy = sess({ id: "x" }) as Session;
    delete (legacy as { connectionEpoch?: number }).connectionEpoch;
    expect(captureAiTarget(legacy).connectionEpoch).toBe(0);
  });
});

describe("isAiTargetLive（五元全等校验）", () => {
  const targetOf = (s: Session): AiScopeTarget => captureAiTarget(s);

  it("精确匹配（同 pane 同连接代数）→ true", () => {
    const a = sess({ id: "tab-a" });
    expect(isAiTargetLive(targetOf(a), state([a], "tab-a"))).toBe(true);
  });

  it("同主机另一标签的目标不被误判（pane id 才是定位键，不是 hostId）", () => {
    const t1 = sess({ id: "tab-1" });
    const t2 = sess({ id: "tab-2", rustId: "pty-2" }); // 同 hostId=1
    // B 活动着，A 的目标依然 live（存活 ≠ 聚焦）
    expect(isAiTargetLive(targetOf(t1), state([t1, t2], "tab-2", { "tab-2": "tab-2" }))).toBe(
      true,
    );
    expect(isAiTargetLive(targetOf(t2), state([t1, t2], "tab-2", { "tab-2": "tab-2" }))).toBe(
      true,
    );
  });

  it("重连后（rustId 换新 + epoch +1）→ 旧目标死", () => {
    const before = sess({ id: "tab-a", rustId: "pty-1", connectionEpoch: 1 });
    const after = sess({ id: "tab-a", rustId: "pty-2", connectionEpoch: 2 });
    expect(isAiTargetLive(targetOf(before), state([after], "tab-a"))).toBe(false);
    expect(isAiTargetLive(targetOf(after), state([after], "tab-a"))).toBe(true);
  });

  it("shell_exit（rustId 清空 + epoch +1）→ 旧目标失活", () => {
    const before = sess({ id: "tab-a", rustId: "local-1", connectionEpoch: 1 });
    const after = sess({ id: "tab-a", rustId: "local-1", connectionEpoch: 2 });
    expect(isAiTargetLive(targetOf(before), state([after], "tab-a"))).toBe(false);
  });

  it("会话已移除（关标签/关 pane）→ false", () => {
    const target = targetOf(sess({ id: "tab-gone" }));
    expect(isAiTargetLive(target, state([], null))).toBe(false);
    const other = sess({ id: "tab-other" });
    expect(isAiTargetLive(target, state([other], "tab-other"))).toBe(false);
  });

  it("kind/hostId 不符 → false（本地目标不可挂到 SSH 会话，反之亦然）", () => {
    const localTarget = targetOf(
      sess({ id: "loc", kind: "local", hostId: -1, rustId: "local-1" }),
    );
    // 同 pane id 变成 SSH 会话（理论构造）：kind 与 hostId 双失配
    const asSsh = sess({ id: "loc", hostId: 1 });
    expect(isAiTargetLive(localTarget, state([asSsh], "loc"))).toBe(false);
    const sshTarget = targetOf(sess({ id: "tab-a", hostId: 1 }));
    const movedHost = sess({ id: "tab-a", hostId: 2 });
    expect(isAiTargetLive(sshTarget, state([movedHost], "tab-a"))).toBe(false);
  });

  it("零效应侧：无关会话（B）断开不影响 A 目标存活", () => {
    const a = sess({ id: "tab-a" });
    const bBefore = sess({ id: "tab-b", hostId: 2, rustId: "pty-b" });
    const bAfter = sess({
      id: "tab-b",
      hostId: 2,
      status: "disconnected",
      rustId: null,
    });
    expect(isAiTargetLive(targetOf(a), state([a, bBefore], "tab-b"))).toBe(true);
    expect(isAiTargetLive(targetOf(a), state([a, bAfter], "tab-b"))).toBe(true);
  });
});

describe("currentEpoch / isTerminalSession（辅助口径）", () => {
  it("currentEpoch：缺省 0（存量夹具兼容），有值取值", () => {
    expect(currentEpoch({})).toBe(0);
    expect(currentEpoch({ connectionEpoch: 0 })).toBe(0);
    expect(currentEpoch({ connectionEpoch: 3 })).toBe(3);
  });

  it("isTerminalSession：ssh/local true；ftp/ftps false", () => {
    expect(isTerminalSession(sess({ id: "x" }))).toBe(true);
    expect(isTerminalSession(sess({ id: "x", kind: "local", hostId: -1 }))).toBe(true);
    expect(isTerminalSession(sess({ id: "x", protocol: "ftp" }))).toBe(false);
    expect(isTerminalSession(sess({ id: "x", protocol: "ftps" }))).toBe(false);
  });
});
