// ⌘J NL 生成目标绑定测试（ask-ottr-orb Task 3，R2）：
//   * nlBegin 捕获聚焦 pane 的不可变目标；每轮 submit 开自己的 scope
//     （ai_scope_open），完成轮入账时携带 source target/scopeId/runId；
//   * A 生成的旧轮在聚焦切到 B 后绝不插进 B——插入绑定跟随轮次来源，
//     跨目标在 CodeBlockRow 生产守卫处禁用（组件面见 insertTarget.test.tsx）；
//   * abort/close 撤销在途 scope。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => orig.createMockProvider(["docker ps"]),
  };
});

import i18n from "../i18n";
import { nlBegin } from "./NLCommandPanel";
import { useNlStore } from "./nl2cmd";
import { defaultScopeInserter } from "./InsertRow";
import { aiSessionApi } from "./sessionApi";
import { useSessionStore, type Session } from "../session/SessionStore";

const mockedInvoke = invoke as unknown as Mock;

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "pane-a",
    hostId: 7,
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

function focusPane(id: string): void {
  useSessionStore.setState({
    sessions: [
      fakeSession({ id: "pane-a", paneOf: "tab-1" }),
      fakeSession({ id: "pane-b", paneOf: "tab-1", rustId: "pty-b" }),
    ],
    activeId: "tab-1",
    activePane: { "tab-1": id },
  });
}

function mockBackend(): void {
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") {
          return Promise.resolve([
            {
              id: "p1",
              name: "DeepSeek",
              kind: "openai-compatible",
              baseURL: "https://api.deepseek.com",
              model: "deepseek-chat",
            },
          ]);
        }
        if (args?.key === "ai.max_tokens") return Promise.resolve(777);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "ai_scope_open":
        return Promise.resolve({
          ...(args?.target as Record<string, unknown>),
          scopeId: `scope-${String(args?.requestId ?? "")}`,
          endpoint: "10.0.0.1:22",
          username: "deploy",
        });
      case "hosts_get":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

const calls = (cmd: string): [string, Record<string, unknown>?][] =>
  (mockedInvoke.mock.calls as [string, Record<string, unknown>?][]).filter(([c]) => c === cmd);

beforeEach(async () => {
  mockedInvoke.mockReset();
  useNlStore.getState().close();
  useNlStore.setState({ rounds: [] });
  focusPane("pane-a");
  await i18n.changeLanguage("zh-CN");
});

describe("NL 轮次目标绑定", () => {
  it("nlBegin 捕获聚焦 pane 的不可变目标；submit 为本轮开 scope 并随轮入账", async () => {
    mockBackend();
    nlBegin();
    const st0 = useNlStore.getState();
    expect(st0.target).toMatchObject({ paneSessionId: "pane-a", rustId: "pty-a", connectionEpoch: 1 });
    useNlStore.getState().setInput("列出容器");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));

    const st = useNlStore.getState();
    expect(st.command).toBe("docker ps");
    expect(st.runId).not.toBeNull();
    expect(st.scopeId).toBe(`scope-${st.runId}`);
    // open 参数：绑定目标 + NL 会话 id + requestId = runId
    const openCall = calls("ai_scope_open")[0]?.[1] as Record<string, unknown>;
    expect(openCall.target).toMatchObject({ paneSessionId: "pane-a", rustId: "pty-a" });
    expect(openCall.conversationId).toBe(`nl-${st.runId}`);
    expect(openCall.requestId).toBe(st.runId);
    // 完成轮携带来源（历史回看面）
    const round = st.rounds[0];
    expect(round.target).toMatchObject({ paneSessionId: "pane-a" });
    expect(round.scopeId).toBe(st.scopeId);
    expect(round.runId).toBe(st.runId);
  });

  it("R2：A 生成的旧轮保留来源 A；切到 B 再生成的新轮绑定 B——旧轮不被改写", async () => {
    mockBackend();
    nlBegin();
    useNlStore.getState().setInput("第一问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));
    const roundA = useNlStore.getState().rounds[0];

    focusPane("pane-b");
    nlBegin();
    useNlStore.getState().setInput("第二问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));

    const st = useNlStore.getState();
    expect(st.target).toMatchObject({ paneSessionId: "pane-b", rustId: "pty-b" });
    expect(st.rounds[1]).toEqual(roundA); // A 轮来源分毫不动
    expect(st.rounds[0].target).toMatchObject({ paneSessionId: "pane-b" });
    // 两次 open 各自绑定对应目标
    const opens = calls("ai_scope_open");
    expect(opens).toHaveLength(2);
    expect((opens[0][1] as Record<string, unknown>).target).toMatchObject({ paneSessionId: "pane-a" });
    expect((opens[1][1] as Record<string, unknown>).target).toMatchObject({ paneSessionId: "pane-b" });
  });

  it("无连接（目标 null）→ 不开 scope、照常生成；插入面由绑定缺失禁用", async () => {
    mockBackend();
    useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
    nlBegin();
    expect(useNlStore.getState().target).toBeNull();
    useNlStore.getState().setInput("列出容器");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));
    expect(calls("ai_scope_open")).toHaveLength(0);
    expect(useNlStore.getState().scopeId).toBeNull();
    const round = useNlStore.getState().rounds[0];
    expect(round.target).toBeNull();
    expect(round.scopeId).toBeNull();
  });

  it("abort 撤销在途 scope", async () => {
    const gates = new Map<string, () => void>();
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve([
        { id: "p1", name: "DeepSeek", kind: "openai-compatible", baseURL: "https://api.deepseek.com", model: "m" },
      ]);
      if (cmd === "ai_scope_open") {
        return new Promise((res) => {
          gates.set("open", () =>
            res({ ...(args?.target as Record<string, unknown>), scopeId: "scope-hold", endpoint: "e", username: null }),
          );
        });
      }
      if (cmd === "ai_scope_revoke") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    nlBegin();
    useNlStore.getState().setInput("列出容器");
    void useNlStore.getState().submit();
    // 等门真的挂上（submit 的微任务链走到 ai_scope_open）再取消
    await vi.waitFor(() => expect(gates.get("open")).toBeTruthy());
    useNlStore.getState().abort();
    gates.get("open")?.();
    await vi.waitFor(() => expect(calls("ai_scope_revoke")).toHaveLength(1));
    expect(useNlStore.getState().scopeId).toBeNull();
  });
});

describe("I-2（fix round 1）：scope 生命周期——settle 不撤销 / close 全收 / supersede 收在途", () => {
  /** 判别式 scope 账本 mock：insert 对已撤销的 scopeId 拒绝（fail-closed）。 */
  function backendWithScopeLedger() {
    const revoked = new Set<string>();
    const opened: string[] = [];
    let holdFirstOpen = false;
    const gates2 = new Map<string, () => void>();
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "settings_get":
          if (args?.key === "ai_providers") {
            return Promise.resolve([
              { id: "p1", name: "DeepSeek", kind: "openai-compatible", baseURL: "https://api.deepseek.com", model: "m" },
            ]);
          }
          if (args?.key === "ai.max_tokens") return Promise.resolve(777);
          return Promise.resolve(null);
        case "secret_get":
          return Promise.resolve("sk-test");
        case "ai_scope_open": {
          const scope = {
            ...(args?.target as Record<string, unknown>),
            scopeId: `scope-${String(args?.requestId ?? "")}`,
            endpoint: "10.0.0.1:22",
            username: "deploy",
          };
          opened.push(scope.scopeId);
          if (holdFirstOpen) {
            holdFirstOpen = false;
            return new Promise((res) => {
              gates2.set("open", () => res(scope));
            });
          }
          return Promise.resolve(scope);
        }
        case "ai_scope_revoke":
          revoked.add(String(args?.scopeId));
          return Promise.resolve(null);
        case "ai_scope_insert":
          if (revoked.has(String(args?.scopeId))) {
            return Promise.reject(new Error("AI scope revoked"));
          }
          return Promise.resolve(null);
        case "hosts_get":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
    return { revoked, opened, gates2, armFirstOpenHold: () => { holdFirstOpen = true; } };
  }

  it("完成轮 A 后 submit 轮 B——A 的 scope 不被撤销，A 历史轮插入仍成功", async () => {
    const { revoked } = backendWithScopeLedger();
    nlBegin();
    useNlStore.getState().setInput("A 问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));
    const roundA = useNlStore.getState().rounds[0];
    expect(roundA.scopeId).toBeTruthy();
    useNlStore.getState().setInput("B 问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().rounds.length).toBe(2));
    // settle 只清指针不撤销：revoked 空（I-2 核心回归钉）
    expect(revoked.size).toBe(0);
    // A 的历史轮插入走生产 scope 插入器：判别 mock 放行
    await expect(
      defaultScopeInserter(
        { target: roundA.target!, scopeId: roundA.scopeId!, runId: roundA.runId, blockIndex: 0 },
        "docker ps",
      ),
    ).resolves.toBeUndefined();
  });

  // 2026-11-13 用户要求：面板关闭**不再**收回已完成轮次的授权——面板留着轮次
  // 给人回看（「最近生成」），却把回看面做成死路（点插入终端插不进去）。
  // 授权改留到后端 TTL（15 分钟）/ 会话生命周期失效（源终端重连即拒）。
  it("close 不收回已完成轮次的授权——重开后历史仍可插入", async () => {
    const { revoked } = backendWithScopeLedger();
    nlBegin();
    useNlStore.getState().setInput("A 问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));
    const roundA = useNlStore.getState().rounds[0];
    useNlStore.getState().setInput("B 问");
    await useNlStore.getState().submit();
    await vi.waitFor(() => expect(useNlStore.getState().rounds.length).toBe(2));
    useNlStore.getState().close();
    // 两轮都已完成（在途指针已空）→ close 不撤任何一把
    await new Promise((r) => setTimeout(r, 20));
    expect(revoked.size).toBe(0);
    // 授权仍在 → 旧轮照常插入
    await expect(
      defaultScopeInserter(
        { target: roundA.target!, scopeId: roundA.scopeId!, runId: roundA.runId, blockIndex: 0 },
        "docker ps",
      ),
    ).resolves.toBeUndefined();
  });

  it("A 在途时 submit B——A 的 scope 被撤销（supersede）、A 插入 fail-closed；B 照常", async () => {
    const { revoked, opened, gates2, armFirstOpenHold } = backendWithScopeLedger();
    armFirstOpenHold(); // 第一笔 open 挂起（A 在途）
    nlBegin();
    useNlStore.getState().setInput("A 问");
    void useNlStore.getState().submit();
    await vi.waitFor(() => expect(gates2.has("open")).toBe(true));
    useNlStore.getState().setInput("B 问");
    void useNlStore.getState().submit(); // supersede：B 走完整链
    await vi.waitFor(() => expect(useNlStore.getState().status).toBe("done"));
    gates2.get("open")?.(); // 迟到的 A open 结果
    await vi.waitFor(() => expect(revoked.size).toBe(1));
    expect(revoked.has(opened[0])).toBe(true); // A 在途 scope 收权
    expect(revoked.has(opened[1])).toBe(false); // B 完成轮存活
    await expect(aiSessionApi.insert(opened[0], "x", "cmd")).rejects.toThrow("AI scope revoked");
    await expect(aiSessionApi.insert(opened[1], "x", "cmd")).resolves.toBeUndefined();
  });
});
