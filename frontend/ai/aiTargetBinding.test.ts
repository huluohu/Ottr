// AI 对话/运行与目标绑定测试（ask-ottr-orb Task 3）：
//   * 对话 per paneSessionId、绑定不可变目标：close 只隐藏（request 摘除，
//     历史/草稿/对话 id 保留）；openAsk 同活目标续对话不重置；
//   * R3：run 在准备期（settings/scope open）被 close/openAsk 取代——迟到
//     的准备不得复活或覆盖新切片；刚开的 scope 被撤销；
//   * scope 用法：每个 run 走 ai_scope_open（目标活校验后）+ ai_scope_context
//     （8KB 尾 + 备注），abort/close/生命周期失效撤销 scope；
//   * 重连 → 旧对话只读；下次 ask 对新代数目标自动开新对话（旧消息不换绑）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const chatFactory = vi.fn();
vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: (meta: unknown, apiKey: string) => {
      chatFactory(meta, apiKey);
      return orig.createMockProvider(["好的。", "```bash\ndf -h\n```"]);
    },
  };
});

import i18n from "../i18n";
import { useAiStore, type AskRequest, type SessionAiState } from "./aiStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { resetRateLimiter, setNotifyPorts } from "../notify/core";

const mockedInvoke = invoke as unknown as Mock;

const PROVIDERS = [
  {
    id: "p1",
    name: "DeepSeek",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
];

const TARGET = {
  paneSessionId: "pane-a",
  rootTabId: "pane-a",
  rustId: "pty-a",
  connectionEpoch: 1,
  kind: "ssh" as const,
  hostId: 7,
};

const ASK_REQ: AskRequest = {
  kind: "ask",
  sessionId: "pane-a",
  rustId: "pty-a",
  hostId: 7,
  hostName: "web-01",
  target: { ...TARGET },
};

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

function seedLivePane(over: Partial<Session> = {}): void {
  useSessionStore.setState({
    sessions: [fakeSession(over)],
    activeId: "pane-a",
    activePane: {},
  });
}

const slice = (): SessionAiState | undefined => useAiStore.getState().sessions["pane-a"];

const calls = (cmd: string): [string, Record<string, unknown>?][] =>
  (mockedInvoke.mock.calls as [string, Record<string, unknown>?][]).filter(([c]) => c === cmd);

/** 可控门：把指定命令挂起，直到 release。release **粘滞**——同一键后续调用
 *  直接放行（再批准/链续跑会再次读 settings，不能每次都重新挂起）。 */
const gates = new Map<string, () => void>();
const released = new Set<string>();
function isHeld(cmd: string, heldList: string[]): boolean {
  return heldList.includes(cmd) && !released.has(cmd);
}
function hold(cmd: string, result: unknown): Promise<unknown> {
  return new Promise((res) => {
    gates.set(cmd, () => res(result));
  });
}
function release(cmd: string): void {
  released.add(cmd);
  const g = gates.get(cmd);
  gates.delete(cmd);
  g?.();
}

function mockBackend(over: { held?: string[]; scopeId?: string } = {}): void {
  const held = over.held ?? [];
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") {
          return isHeld("settings_get:ai_providers", held)
            ? hold("settings_get:ai_providers", PROVIDERS)
            : Promise.resolve(PROVIDERS);
        }
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "ai_scope_open": {
        const scope = {
          ...(args?.target as Record<string, unknown>),
          scopeId: over.scopeId ?? "scope-run",
          endpoint: "10.0.0.1:22",
          username: "deploy",
        };
        return isHeld("ai_scope_open", held)
          ? hold("ai_scope_open", scope)
          : Promise.resolve(scope);
      }
      case "ai_scope_context":
        return Promise.resolve({ tail: "磁盘输出 tail", notes: "备注：Nginx 部署" });
      case "ai_scope_revoke":
        return Promise.resolve(null);
      case "mcp_server_call":
        return Promise.resolve({ text: "工具结果", isError: false });
      case "session_tail":
        return Promise.resolve("legacy tail");
      case "hosts_get":
        return Promise.resolve(null);
      case "notify_insert":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  gates.clear();
  released.clear();
  chatFactory.mockClear();
  useAiStore.setState({ sessions: {} });
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 1_000, focused: () => true, system: async () => {} });
  await i18n.changeLanguage("zh-CN");
});

describe("对话生命周期（per paneSessionId，close 隐藏不清）", () => {
  it("openAsk 首次开新对话（绑定目标）；close 只摘 request，历史/草稿/对话 id 保留", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    const convId = slice()!.conversationId;
    expect(convId).not.toBe("");
    expect(slice()!.target).toEqual(TARGET);
    await useAiStore.getState().run("pane-a", "磁盘还剩多少");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()!.messages.length).toBeGreaterThan(0);
    useAiStore.getState().patchDraft("pane-a", "草稿残留");
    useAiStore.getState().close("pane-a");
    const closed = slice()!;
    expect(closed.request).toBeNull(); // 「open」旗标摘除（orb 可见性随之恢复）
    expect(closed.conversationId).toBe(convId); // 对话保留
    expect(closed.messages.length).toBeGreaterThan(0); // 历史保留
    expect(closed.draft).toBe("草稿残留");
  });

  it("openAsk 同活目标重开 = 续对话（messages/conversationId/draft 不丢）", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const convId = slice()!.conversationId;
    const messages = slice()!.messages;
    useAiStore.getState().openAsk(ASK_REQ);
    const st = slice()!;
    expect(st.request?.kind).toBe("ask");
    expect(st.conversationId).toBe(convId);
    expect(st.messages).toEqual(messages);
    expect(st.status).toBe("idle"); // 在途运行已被取代（此处本就无）
  });

  it("openAsk 目标已换代（重连）→ 自动开新对话，旧消息不换绑到新连接", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const convId = slice()!.conversationId;
    // 重连：rustId 换新 + 代数 +1
    useSessionStore.setState({
      sessions: [fakeSession({ rustId: "pty-a2", connectionEpoch: 2 })],
    });
    useAiStore.getState().openAsk({ ...ASK_REQ, rustId: "pty-a2", target: { ...TARGET, rustId: "pty-a2", connectionEpoch: 2 } });
    const st = slice()!;
    expect(st.conversationId).not.toBe(convId); // 新对话
    expect(st.messages).toEqual([]); // 旧历史不换绑
    expect(st.conversationReadonly).toBe(false);
    expect(st.target).toEqual({ ...TARGET, rustId: "pty-a2", connectionEpoch: 2 });
  });

  it("newConversation 显式清空（request 保留）；重连 → 旧对话只读（历史可见）", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    // 生命周期：重连成功（代数 +1）→ 旧对话只读，历史保留可见
    useSessionStore.setState({
      sessions: [fakeSession({ rustId: "pty-a2", connectionEpoch: 2 })],
    });
    useAiStore.getState().handleSessionLifecycle({
      type: "reconnected",
      session: fakeSession({ rustId: "pty-a2", connectionEpoch: 2 }),
    });
    expect(slice()!.conversationReadonly).toBe(true);
    expect(slice()!.messages.length).toBeGreaterThan(0);
    // 显式新对话：清历史/草稿/只读标记，request 保留
    const convId = slice()!.conversationId;
    useAiStore.getState().newConversation("pane-a");
    const st = slice()!;
    expect(st.messages).toEqual([]);
    expect(st.draft).toBe("");
    expect(st.conversationReadonly).toBe(false);
    expect(st.conversationId).not.toBe(convId);
    expect(st.request).not.toBeNull();
  });

  it("重连生命周期：scope 全撤销 + 目标已死的对话标只读；无目标切片不受扰", () => {
    mockBackend();
    seedLivePane();
    useAiStore.setState({
      sessions: {
        "pane-a": {
          request: ASK_REQ,
          status: "done",
          answer: "",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: true,
          usage: null,
          modelUsed: null,
          elapsedMs: null,
          messages: [{ role: "user", content: "q" }],
          conversationId: "conv-1",
          target: { ...TARGET },
          scope: null,
          runId: null,
          draft: "",
          conversationReadonly: false,
        },
      },
    });
    // 会话快照 = 重连后的新代数 → 旧目标失活
    useSessionStore.setState({
      sessions: [fakeSession({ rustId: "pty-a2", connectionEpoch: 2 })],
    });
    useAiStore.getState().handleSessionLifecycle({
      type: "reconnected",
      session: fakeSession({ rustId: "pty-a2", connectionEpoch: 2 }),
    });
    expect(slice()!.conversationReadonly).toBe(true);
    expect(calls("ai_scope_revoke")).toHaveLength(0); // 本就无活 scope
    // 无绑定目标的生命周期事件：no-op 不产生幽灵切片
    useAiStore.getState().handleSessionLifecycle({ type: "disconnected", session: fakeSession({ id: "ghost" }) });
    expect(useAiStore.getState().sessions["ghost"]).toBeUndefined();
  });
});

describe("scope 用法（每 run 一开；上下文与撤销）", () => {
  it("绑定目标 run：ai_scope_open(conversationId, requestId=runId) → ai_scope_context(8KB)；备注走 scope 不再单独查主机", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "磁盘情况如何");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const openCall = calls("ai_scope_open")[0]?.[1] as Record<string, unknown>;
    expect(openCall.target).toEqual(TARGET);
    expect(openCall.conversationId).toBe(slice()!.conversationId);
    expect(openCall.requestId).toBe(slice()!.runId);
    const ctxCall = calls("ai_scope_context")[0]?.[1] as Record<string, unknown>;
    expect(ctxCall).toMatchObject({ scopeId: "scope-run", bytes: 8192 });
    // scope 通道：不再按 hostId 单独取主机备注（scope_context 已带 notes）
    expect(calls("hosts_get")).toHaveLength(0);
    // 尾与备注进了模型请求（脱敏后）
    const sent = chatFactory.mock.calls.length;
    expect(sent).toBe(1);
    expect(slice()!.scope).toMatchObject({ scopeId: "scope-run", endpoint: "10.0.0.1:22", username: "deploy" });
  });

  it("无绑定目标（目标捕获失败）→ 回落 legacy session_tail 路径，不碰 scope", async () => {
    mockBackend();
    useAiStore.setState({
      sessions: {
        "pane-a": {
          request: { ...ASK_REQ, target: null },
          status: "idle",
          answer: "",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: false,
          usage: null,
          modelUsed: null,
          elapsedMs: null,
          messages: [],
          conversationId: "conv-legacy",
          target: null,
          scope: null,
          runId: null,
          draft: "",
          conversationReadonly: false,
        },
      },
    });
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(calls("ai_scope_open")).toHaveLength(0);
    expect(calls("session_tail").length).toBeGreaterThan(0);
    expect(slice()!.scope).toBeNull();
  });

  it("abort 在途 run → scope 撤销；完成的 run 其 scope 存活（插入授权保留）", async () => {
    mockBackend({ held: ["ai_scope_open"] });
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    void useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("running"));
    // 等门真的挂上（run 的微任务链走到 ai_scope_open）再取消——waitFor(status)
    // 可能快于准备链的微任务排空。
    await vi.waitFor(() => expect(gates.has("ai_scope_open")).toBe(true));
    useAiStore.getState().abort("pane-a");
    release("ai_scope_open"); // 迟到的 open 结果
    await vi.waitFor(() => expect(calls("ai_scope_revoke")).toHaveLength(1));
    expect(slice()?.status).toBe("aborted");

    // 正常完成：scope 不撤销
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(calls("ai_scope_revoke")).toHaveLength(1); // 仍是上面那一次
  });

  it("close 撤销该会话全部 scope；dropSession（closed 生命周期）一并清切片", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(calls("ai_scope_revoke")).toHaveLength(0);
    useAiStore.getState().close("pane-a");
    await vi.waitFor(() => expect(calls("ai_scope_revoke")).toHaveLength(1));
    // 生命周期 closed → dropSession：清切片（scope 已被 close 撤过，幂等）
    useAiStore.getState().handleSessionLifecycle({ type: "closed", session: fakeSession() });
    expect(slice()).toBeUndefined();
  });
});

describe("R3：run 准备期被取代（迟到准备不得复活/覆盖新切片）", () => {
  it("close+openAsk 后，迟到准备不出网、不复活请求，但已提交问题保留一次", async () => {
    mockBackend({ held: ["settings_get:ai_providers"] });
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    const staleRun = useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("running"));
    useAiStore.getState().close("pane-a");
    useAiStore.getState().openAsk(ASK_REQ); // 重开（同活目标 → 续对话）
    release("settings_get:ai_providers");
    await staleRun;
    await new Promise((r) => setTimeout(r, 10));
    const st = slice()!;
    expect(st.request).not.toBeNull(); // 新切片在场
    expect(st.runId).toBeNull(); // 迟到 run 不得复占 runId
    expect(st.status).toBe("idle"); // 未被迟到准备改写
    expect(st.answer).toBe("");
    // 2026-11-07 打断插话契约：close 只保留安全用户轮（脱敏后一次），绝不
    // 复活 request/status/出网——旧断言「messages 清空」会丢用户已提交的问题。
    expect(st.messages).toHaveLength(1);
    expect(st.messages[0].role).toBe("user");
    expect(st.messages[0].content).toContain("第一问");
    expect(chatFactory).not.toHaveBeenCalled(); // 迟到准备未出网
  });

  it("openAsk 取代在途 run → 旧 run 停在 settings，重开后迟到准备被丢弃", async () => {
    mockBackend({ held: ["settings_get:ai_providers"] });
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    void useAiStore.getState().run("pane-a", "第一问");
    // 等门挂上再取代（run 的微任务链先走到 settings）
    await vi.waitFor(() => expect(gates.has("settings_get:ai_providers")).toBe(true));
    useAiStore.getState().openAsk(ASK_REQ); // 直接重开（取代在途）
    release("settings_get:ai_providers");
    await new Promise((r) => setTimeout(r, 10));
    const st = slice()!;
    expect(st.runId).toBeNull();
    expect(st.status).toBe("idle");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("scope open 挂起期间被 abort → 迟到的 scope 被撤销，run 不再写状态", async () => {
    mockBackend({ held: ["ai_scope_open"] });
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    void useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(gates.has("ai_scope_open")).toBe(true));
    useAiStore.getState().abort("pane-a");
    release("ai_scope_open");
    await vi.waitFor(() => expect(calls("ai_scope_revoke")).toHaveLength(1));
    expect(slice()?.status).toBe("aborted");
    expect(slice()?.scope).toBeNull(); // 迟到的 scope 未落切片
    expect(chatFactory).not.toHaveBeenCalled();
  });
});

describe("重试语义（替换不重复追加）", () => {
  it("首轮失败重试：替换末轮用户上下文，不追加重复问题", async () => {
    mockBackend();
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    // 人为置错误态（模拟首轮端点失败收尾——streamTurn 的错误回滚把半截
    // assistant 轮摘掉，历史以**用户轮**收尾）
    useAiStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        "pane-a": {
          ...st.sessions["pane-a"]!,
          status: "error",
          errorKind: "request",
          error: "boom",
          messages: st.sessions["pane-a"]!.messages.slice(0, 1),
        },
      },
    }));
    await useAiStore.getState().run("pane-a"); // 重试（无追问文本）
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const userTurns = slice()!.messages.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1); // 替换而非追加
    expect(chatFactory).toHaveBeenCalledTimes(2);
  });
});

describe("I-1（fix round 1）：审批竞态的丢弃路径清挂起标记（pending 保留可再批）", () => {
  /** 直塞一个「审批挂起」切片：pending 带来源 runId（run-1），目标绑定活 pane。 */
  function seedPendingSlice(): void {
    useAiStore.setState({
      sessions: {
        "pane-a": {
          request: ASK_REQ,
          status: "awaiting_tool_approval",
          answer: "",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: true,
          usage: null,
          modelUsed: null,
          elapsedMs: null,
          messages: [
            { role: "user", content: "q" },
            {
              role: "assistant",
              content: "调工具",
              toolCalls: [{ id: "call_1", name: "mcp__srv-1__t", arguments: "{}" }],
            },
          ],
          conversationId: "conv-1",
          target: { ...TARGET },
          scope: null,
          runId: "run-1",
          draft: "",
          conversationReadonly: false,
          pendingToolCalls: [
            { id: "call_1", serverId: "srv-1", serverName: "files", tool: "t", args: "{}", runId: "run-1" },
          ],
          toolRounds: 1,
          runningToolCallId: null,
        },
      },
    });
  }

  it("approve → supersede（openAsk 续开）在执行前拦截：不执行、清挂起、pending 保留且可再批", async () => {
    mockBackend();
    seedLivePane();
    seedPendingSlice();
    // 挂起 resolveToolCall 的首个 await（loadAiSettings）——批准点击已落，
    // 执行尚未开始
    mockBackend({ held: ["settings_get:ai_providers"] });
    void useAiStore.getState().resolveToolCall("pane-a", "call_1", true);
    await vi.waitFor(() =>
      expect(useAiStore.getState().sessions["pane-a"]?.runningToolCallId).toBe("call_1"),
    );
    // supersede：openAsk 同活目标续开（runId 清空、pending 保留）
    useAiStore.getState().openAsk(ASK_REQ);
    release("settings_get:ai_providers");
    await new Promise((r) => setTimeout(r, 10));
    const st = useAiStore.getState().sessions["pane-a"]!;
    expect(st.runningToolCallId).toBeNull(); // 丢弃路径清挂起（审批面不变砖）
    expect(st.pendingToolCalls ?? []).toHaveLength(1); // 调用仍待处置
    expect(calls("mcp_server_call")).toHaveLength(0); // 未执行
    // 回到同一切片可再批（恢复路径）→ 恰好一次执行 → 链续跑收尾
    await useAiStore.getState().resolveToolCall("pane-a", "call_1", true);
    await vi.waitFor(() => expect(useAiStore.getState().sessions["pane-a"]?.status).toBe("done"));
    expect(calls("mcp_server_call")).toHaveLength(1);
    expect(useAiStore.getState().sessions["pane-a"]?.runningToolCallId).toBeNull();
  });

  it("approve → close（hide）在执行前拦截：不执行、清挂起、重开后续批成功", async () => {
    mockBackend({ held: ["settings_get:ai_providers"] });
    seedLivePane();
    seedPendingSlice();
    void useAiStore.getState().resolveToolCall("pane-a", "call_1", true);
    await vi.waitFor(() =>
      expect(useAiStore.getState().sessions["pane-a"]?.runningToolCallId).toBe("call_1"),
    );
    useAiStore.getState().close("pane-a"); // hide：request 摘除、切片保留
    release("settings_get:ai_providers");
    await new Promise((r) => setTimeout(r, 10));
    const st = useAiStore.getState().sessions["pane-a"]!;
    expect(st.request).toBeNull();
    expect(st.runningToolCallId).toBeNull(); // 不砖
    expect(st.pendingToolCalls ?? []).toHaveLength(1);
    expect(calls("mcp_server_call")).toHaveLength(0);
    // 重开（同活目标续对话）→ 再批 → 成功
    useAiStore.getState().openAsk(ASK_REQ);
    await useAiStore.getState().resolveToolCall("pane-a", "call_1", true);
    await vi.waitFor(() => expect(useAiStore.getState().sessions["pane-a"]?.status).toBe("done"));
    expect(calls("mcp_server_call")).toHaveLength(1);
  });

  it("approve → vault 锁定在执行前拦截：清挂起、pending 保留、不执行", async () => {
    mockBackend();
    seedLivePane();
    seedPendingSlice();
    useVaultLockStore.setState({ phase: "locked" });
    await useAiStore.getState().resolveToolCall("pane-a", "call_1", true);
    const st = useAiStore.getState().sessions["pane-a"]!;
    expect(st.runningToolCallId).toBeNull();
    expect(st.pendingToolCalls ?? []).toHaveLength(1);
    expect(calls("mcp_server_call")).toHaveLength(0);
    useVaultLockStore.setState({ phase: "unlocked" });
  });
});

describe("M-1（fix round 1）：目标半路死亡的搁浅救援（不留永久 running）", () => {
  it("run 准备期目标死亡 → 守卫失败归位 idle（非 supersede 路径才写）", async () => {
    mockBackend({ held: ["settings_get:ai_providers"] });
    seedLivePane();
    useAiStore.getState().openAsk(ASK_REQ);
    void useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(gates.has("settings_get:ai_providers")).toBe(true));
    // 目标半路死亡：pane 移除（isAiTargetLive 失配）
    useSessionStore.setState({ sessions: [], activeId: null });
    release("settings_get:ai_providers");
    await new Promise((r) => setTimeout(r, 10));
    const st = useAiStore.getState().sessions["pane-a"]!;
    expect(st.status).toBe("idle"); // 不再搁浅在 running
    expect(chatFactory).not.toHaveBeenCalled();
  });
});
