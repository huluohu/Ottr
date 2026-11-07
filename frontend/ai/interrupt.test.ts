// 打断插话：消费方的 AbortSignal、对话历史和迟到结果都用可控流验证。
// 流故意不自行响应 AbortSignal，确保晚到保护由真实 store 负责。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ChatDelta, ChatRequest } from "./provider";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const providerQueue: ReturnType<typeof controlledProvider>[] = [];
const allProviders: ReturnType<typeof controlledProvider>[] = [];
vi.mock("./provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("./provider")>(),
  createProvider: () => {
    const next = providerQueue.shift();
    if (!next) throw new Error("unexpected extra model request");
    return next;
  },
}));

import i18n from "../i18n";
import * as aiSettings from "./settings";
import { useAiStore, type AskRequest } from "./aiStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { resetRateLimiter, setNotifyPorts } from "../notify/core";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function controlledProvider() {
  const packets: (ChatDelta | Error | null)[] = [];
  const completed = deferred<void>();
  let wake: (() => void) | undefined;
  let finished = false;
  const emit = (packet: ChatDelta | Error | null) => {
    packets.push(packet);
    wake?.();
    wake = undefined;
  };
  return {
    requests: [] as ChatRequest[],
    completed: completed.promise,
    push: (delta: ChatDelta) => emit(delta),
    fail: (error: Error) => emit(error),
    finish: () => {
      if (!finished) {
        finished = true;
        emit(null);
      }
    },
    async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
      this.requests.push(request);
      try {
        for (;;) {
          if (packets.length === 0) {
            await new Promise<void>((done) => { wake = done; });
          }
          const packet = packets.shift();
          if (packet === null) return;
          if (packet instanceof Error) throw packet;
          if (packet) yield packet;
        }
      } finally {
        completed.resolve();
      }
    },
    async testConnection() { return "ok"; },
  };
}

const target = {
  paneSessionId: "pane-a",
  rootTabId: "pane-a",
  rustId: "pty-a",
  connectionEpoch: 1,
  kind: "ssh" as const,
  hostId: 7,
};
const request: AskRequest = {
  kind: "ask", sessionId: "pane-a", rustId: "pty-a", hostId: 7,
  hostName: "web-01", target,
};
function liveSession(): Session {
  return {
    id: "pane-a", hostId: 7, hostName: "web-01", address: "10.0.0.1", port: 22,
    username: "deploy", protocol: "ssh", jumpChainId: null, status: "connected",
    rustId: "pty-a", attempt: 0, lastError: null, nextRetryAt: null, paneOf: null,
    encoding: "utf-8", encodingOverride: "utf-8", encodingHint: null,
    isProduction: false, connectionEpoch: 1,
  };
}
const state = () => useAiStore.getState().sessions["pane-a"]!;
const runs: Promise<void>[] = [];
let heldSettings: ReturnType<typeof deferred<void>> | undefined;
let heldExec: ReturnType<typeof deferred<void>> | undefined;
let heldReadFile: ReturnType<typeof deferred<void>> | undefined;
let heldRunStep: ReturnType<typeof deferred<void>> | undefined;
let failRunStep = false;
let noProvider = false;
let mcpEnabled = false;

function enqueue() {
  const provider = controlledProvider();
  providerQueue.push(provider);
  allProviders.push(provider);
  return provider;
}
async function startPartial(text = "我先解释磁盘情况。") {
  const provider = enqueue();
  useAiStore.getState().openAsk(request);
  runs.push(useAiStore.getState().run("pane-a", "看看磁盘"));
  await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
  provider.push({ text });
  await vi.waitFor(() => expect(state().answer).toBe(text));
  return provider;
}
function nextAnswer(text = "好的，先不删除。") {
  const provider = enqueue();
  provider.push({ text });
  provider.finish();
  return provider;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  providerQueue.length = 0;
  allProviders.length = 0;
  runs.length = 0;
  heldSettings = undefined;
  heldExec = undefined;
  heldReadFile = undefined;
  heldRunStep = undefined;
  failRunStep = false;
  noProvider = false;
  mcpEnabled = false;
  useAiStore.setState({ sessions: {} });
  useVaultLockStore.setState({ phase: "unlocked" });
  useSessionStore.setState({ sessions: [liveSession()], activeId: "pane-a", activePane: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 0, focused: () => true, system: async () => {} });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, rawArgs) => {
    const args = rawArgs as Record<string, unknown> | undefined;
    switch (command) {
      case "settings_get":
        if (heldSettings) await heldSettings.promise;
        if (args?.key === "ai_providers") return noProvider ? [] : [{
          id: "p1", name: "test", kind: "openai-compatible",
          baseURL: "http://127.0.0.1:18081/v1", model: "test-model",
        }];
        if (args?.key === "redaction") return {
          hostname: true, custom: [{ name: "token", pattern: "PRIVATE_TOKEN", enabled: true }],
        };
        return null;
      case "secret_get": return "test-key";
      case "ai_scope_open": return {
        ...(args?.target as object), scopeId: `scope-${args?.requestId}`,
        endpoint: "10.0.0.1:22", username: "deploy",
      };
      case "ai_scope_context": return { tail: "disk output", notes: null };
      case "ai_scope_read_file":
        if (heldReadFile) await heldReadFile.promise;
        return { path: args?.path, size: 11, content: "file output", truncated: false };
      case "mcp_servers_list": return mcpEnabled ? [{
        id: "server-1", name: "files", command: "test-server", args: [],
        enabled: true, envNames: [],
      }] : [];
      case "mcp_server_tools": return [{
        name: "inspect", description: "inspect", inputSchema: '{"type":"object"}',
      }];
      case "ai_scope_exec":
        if (heldExec) await heldExec.promise;
        return { executed: false, planned: true, stepId: "step-1", message: "registered" };
      case "ai_scope_run_step":
        if (heldRunStep) await heldRunStep.promise;
        if (failRunStep) throw new Error("OLD_TOOL_RESULT_FAILURE");
        return {
          executed: true, stepId: args?.stepId, exitCode: 0,
          stdout: "OLD_TOOL_RESULT", stderr: "", truncated: false, timedOut: false,
          message: "command completed successfully (exit code 0)",
        };
      default: return null;
    }
  });
});

afterEach(async () => {
  heldSettings?.resolve();
  heldExec?.resolve();
  heldReadFile?.resolve();
  heldRunStep?.resolve();
  for (const id of Object.keys(useAiStore.getState().sessions)) {
    useAiStore.getState().close(id);
  }
  for (const provider of allProviders) provider.finish();
  await Promise.allSettled(runs);
  useAiStore.setState({ sessions: {} });
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
  useVaultLockStore.setState({ phase: "boot" });
  vi.restoreAllMocks();
});

describe("打断插话", () => {
  it("首问设置加载失败时恢复已提交文本到草稿，重试后仍带原问题", async () => {
    heldSettings = deferred<void>();
    const settings = vi.spyOn(aiSettings, "loadAiSettings").mockImplementationOnce(() =>
      heldSettings!.promise.then(() => { throw new Error("settings unavailable"); }),
    );
    const unused = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().patchDraft("pane-a", "保留的问题");
    const submitted = useAiStore.getState().run("pane-a", state().draft);
    runs.push(submitted);
    expect(state().draft).toBe("");
    heldSettings.resolve();
    await submitted;
    expect(state().draft).toBe("保留的问题");
    expect(unused.requests).toHaveLength(0);
    settings.mockRestore();

    providerQueue.length = 0;
    const retry = enqueue();
    retry.push({ text: "重试后的回答" });
    retry.finish();
    const retried = useAiStore.getState().run("pane-a");
    runs.push(retried);
    await retried;
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0].messages.filter((m) => m.role === "user").length).toBe(1);
    expect(retry.requests[0].messages[0].content).toContain("保留的问题");
  });

  it("Ask 首轮无 provider 后重试仍发送已提交问题一次", async () => {
    noProvider = true;
    const unused = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().patchDraft("pane-a", "原始问题");
    const failed = useAiStore.getState().run("pane-a", state().draft);
    runs.push(failed);
    await failed;
    expect(state().status).toBe("error");
    expect(state().messages.filter((m) => m.role === "user" && m.content.includes("原始问题"))).toHaveLength(1);
    noProvider = false;
    providerQueue.length = 0;
    const retry = enqueue();
    retry.push({ text: "已恢复回答" });
    retry.finish();
    const retried = useAiStore.getState().run("pane-a");
    runs.push(retried);
    await retried;
    expect(unused.requests).toHaveLength(0);
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0].messages.filter((m) => m.role === "user" && m.content.includes("原始问题"))).toHaveLength(1);
    expect(state().messages.filter((m) => m.role === "user" && m.content.includes("原始问题"))).toHaveLength(1);
  });

  it("Ask 追问失败后重试只替换末尾问题，不重复或丢失上下文", async () => {
    const first = enqueue();
    useAiStore.getState().openAsk(request);
    const initial = useAiStore.getState().run("pane-a", "初始问题");
    runs.push(initial);
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    first.push({ text: "初始回答" });
    first.finish();
    await vi.waitFor(() => expect(state().status).toBe("done"));

    const failed = enqueue();
    failed.fail(new Error("temporary endpoint error"));
    const followup = useAiStore.getState().run("pane-a", "追问内容");
    runs.push(followup);
    await followup;
    expect(state().status).toBe("error");

    const retry = enqueue();
    retry.push({ text: "恢复后的回答" });
    retry.finish();
    const retried = useAiStore.getState().run("pane-a");
    runs.push(retried);
    await retried;
    const messages = retry.requests[0].messages;
    expect(messages.filter((m) => m.role === "user" && m.content.includes("初始问题"))).toHaveLength(1);
    expect(messages.filter((m) => m.role === "user" && m.content === "追问内容")).toHaveLength(1);
    expect(messages[messages.length - 1]?.content).toBe("追问内容");
    expect(state().messages.filter((m) => m.role === "user" && m.content === "追问内容")).toHaveLength(1);
  });

  it("发送首问后立即清空草稿，运行中可以输入下一句", async () => {
    const provider = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().patchDraft("pane-a", "看看磁盘");
    const submitted = useAiStore.getState().run("pane-a", state().draft);
    runs.push(submitted);
    expect(state().draft).toBe("");
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
  });

  it.each(["stop", "close"] as const)("首问准备期间 %s 后已提交问题仍保留一次脱敏历史并进入下次请求", async (event) => {
    heldSettings = deferred<void>();
    const unused = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().patchDraft("pane-a", "原始问题 PRIVATE_TOKEN，密码是 hunter2");
    const original = useAiStore.getState().run("pane-a", state().draft);
    runs.push(original);
    expect(state().status).toBe("running");
    // 本轮设置尚未返回，不能先把未知自定义规则覆盖的明文塞进历史。
    expect(JSON.stringify(state().messages)).not.toContain("PRIVATE_TOKEN");
    expect(JSON.stringify(state().messages)).not.toContain("hunter2");
    if (event === "stop") useAiStore.getState().abort("pane-a");
    else useAiStore.getState().close("pane-a");
    heldSettings.resolve();
    await original;
    expect(unused.requests).toHaveLength(0);
    expect(state().status).not.toBe("running");
    if (event === "close") {
      expect(state().request).toBeNull();
      useAiStore.getState().openAsk(request);
    }
    // 旧轮未出网，丢掉它未被消费的测试 provider，下一次请求单独捕获。
    providerQueue.length = 0;
    const next = nextAnswer();
    const submitted = useAiStore.getState().run("pane-a", "新的问题");
    runs.push(submitted);
    await submitted;
    expect(next.requests).toHaveLength(1);
    for (const turns of [state().messages, next.requests[0].messages]) {
      const originalQuestions = turns.filter((m) => m.role === "user" && m.content.includes("原始问题"));
      expect(originalQuestions).toHaveLength(1);
      expect(originalQuestions[0].content).toContain("[REDACTED_");
      expect(JSON.stringify(turns)).not.toContain("PRIVATE_TOKEN");
      expect(JSON.stringify(turns)).not.toContain("hunter2");
      expect(turns.filter((m) => m.role === "user" && m.content === "新的问题")).toHaveLength(1);
    }
  });

  it("首轮请求准备期间不打断、不替换原始问题，保留新草稿待回复开始", async () => {
    heldSettings = deferred<void>();
    const provider = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().patchDraft("pane-a", "原始问题");
    const original = useAiStore.getState().run("pane-a", state().draft);
    runs.push(original);
    const preparingRunId = state().runId!;
    useAiStore.getState().patchDraft("pane-a", "等会儿补充");
    await useAiStore.getState().interrupt("pane-a", "补充问题", preparingRunId);
    expect(state().runId).toBe(preparingRunId);
    expect(state().status).toBe("running");
    expect(state().draft).toBe("等会儿补充");
    heldSettings.resolve();
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(provider.requests[0].messages[0].content).toContain("原始问题");
    expect(provider.requests[0].messages[0].content).not.toContain("补充问题");
  });

  it("发送瞬间就停止旧请求，不等待读取下一轮设置", async () => {
    const old = await startPartial();
    heldSettings = deferred<void>();
    const next = nextAnswer();
    const submitted = useAiStore.getState().interrupt("pane-a", "先别删", state().runId!);
    runs.push(submitted);
    expect(old.requests[0].signal?.aborted).toBe(true);
    expect(next.requests).toHaveLength(0);
    heldSettings.resolve();
    await vi.waitFor(() => expect(next.requests).toHaveLength(1));
    await submitted;
  });

  it("流式 assistant 轮绑定本轮 runId，便于打断时脱敏定稿", async () => {
    await startPartial();
    const assistant = state().messages[state().messages.length - 1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.runId).toBe(state().runId);
  });

  it("部分回答在历史和下一次请求里各保留一份，不再追加重复 assistant", async () => {
    await startPartial();
    const next = nextAnswer();
    const submitted = useAiStore.getState().interrupt("pane-a", "先别删", state().runId!);
    runs.push(submitted);
    await vi.waitFor(() => expect(state().status).toBe("done"));
    const partials = state().messages.filter((m) => m.role === "assistant" && m.content === "我先解释磁盘情况。");
    expect(partials).toHaveLength(1);
    expect(next.requests[0].messages.map((m) => m.content)).toEqual([
      expect.stringContaining("看看磁盘"), "我先解释磁盘情况。", "先别删",
    ]);
    expect(state().draft).toBe("");
  });

  it("部分回答使用本轮脱敏配置定稿，不把敏感内容再次发送", async () => {
    await startPartial("PRIVATE_TOKEN，密码是 hunter2");
    const next = nextAnswer();
    runs.push(useAiStore.getState().interrupt("pane-a", "换个角度", state().runId!));
    expect(JSON.stringify(state().messages)).not.toContain("PRIVATE_TOKEN");
    expect(JSON.stringify(state().messages)).not.toContain("hunter2");
    await vi.waitFor(() => expect(state().status).toBe("done"));
    const stored = JSON.stringify(state().messages);
    const sent = JSON.stringify(next.requests[0].messages);
    for (const text of [stored, sent]) {
      expect(text).not.toContain("PRIVATE_TOKEN");
      expect(text).not.toContain("hunter2");
      expect(text).toContain("[REDACTED_");
    }
  });

  it.each(["delta", "error", "done"] as const)("旧流晚到 %s 不覆盖新对话、不重启工具续跑", async (late) => {
    const old = await startPartial();
    nextAnswer("新回答已完成");
    runs.push(useAiStore.getState().interrupt("pane-a", "换个问题", state().runId!));
    await vi.waitFor(() => expect(state().status).toBe("done"));
    const snapshot = state();
    if (late === "delta") old.push({ text: "旧回复不该出现" });
    if (late === "error") old.fail(new Error("old stream error"));
    old.finish();
    await runs[0];
    expect(state()).toBe(snapshot);
    expect(state().answer).toBe("新回答已完成");
  });

  it.each(["close", "newConversation", "lock"] as const)("下一轮准备中发生 %s，不复活旧消息或继续发请求", async (event) => {
    const old = await startPartial();
    heldSettings = deferred<void>();
    const next = nextAnswer();
    const submitted = useAiStore.getState().interrupt("pane-a", "先别删", state().runId!);
    runs.push(submitted);
    if (event === "close") useAiStore.getState().close("pane-a");
    if (event === "newConversation") useAiStore.getState().newConversation("pane-a");
    if (event === "lock") useVaultLockStore.setState({ phase: "locked" });
    const conversationId = state().conversationId;
    heldSettings.resolve();
    await submitted;
    await vi.waitFor(() => expect(state().status).not.toBe("running"));
    expect(old.requests[0].signal?.aborted).toBe(true);
    expect(next.requests).toHaveLength(0);
    expect(state().conversationId).toBe(conversationId);
    if (event === "newConversation") expect(state().messages).toEqual([]);
    if (event === "close") expect(state().request).toBeNull();
  });

  it("未吐出首字时插话，空的 assistant 占位不进入下一次请求", async () => {
    const old = enqueue();
    useAiStore.getState().openAsk(request);
    runs.push(useAiStore.getState().run("pane-a", "看看磁盘"));
    await vi.waitFor(() => expect(old.requests).toHaveLength(1));
    const next = nextAnswer();
    runs.push(useAiStore.getState().interrupt("pane-a", "先看内存", state().runId!));
    await vi.waitFor(() => expect(state().status).toBe("done"));
    expect(old.requests[0].signal?.aborted).toBe(true);
    expect(next.requests[0].messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(next.requests[0].messages[next.requests[0].messages.length - 1]?.content).toBe("先看内存");
  });

  it("同一运行快照重复发送只新增一条用户消息、一个模型请求", async () => {
    await startPartial();
    const runId = state().runId;
    const next = nextAnswer();
    const first = useAiStore.getState().interrupt("pane-a", "先别删", runId);
    const second = useAiStore.getState().interrupt("pane-a", "先别删", runId);
    runs.push(first, second);
    await vi.waitFor(() => expect(state().status).toBe("done"));
    expect(next.requests).toHaveLength(1);
    expect(state().messages.filter((m) => m.role === "user" && m.content === "先别删")).toHaveLength(1);
  });

  it("内建主机工具正在执行时不插话，停止后的迟到结果不新增步骤或续跑", async () => {
    const old = await startPartial();
    useAiStore.getState().setMode("pane-a", "manual");
    heldExec = deferred<void>();
    old.push({ text: "", toolCalls: [{
      id: "call-exec", name: "ottr_exec_command", arguments: '{"command":"uptime"}',
    }] });
    old.finish();
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "ai_scope_exec")).toBe(true));
    expect(state().runningHostToolCallId).toBe("call-exec");
    const snapshot = state();
    await useAiStore.getState().interrupt("pane-a", "先别执行", state().runId!);
    expect(state()).toBe(snapshot);
    useAiStore.getState().abort("pane-a");
    const stopped = state();
    expect(stopped.status).toBe("aborted");
    expect(stopped.runningHostToolCallId).toBe("call-exec");
    await useAiStore.getState().run("pane-a", "工具没回来前不能开新轮");
    expect(state()).toBe(stopped);
    heldExec.resolve();
    await runs[0];
    expect(state().status).toBe("aborted");
    expect(state().messages).toEqual(stopped.messages);
    expect(state().runningHostToolCallId).toBeNull();
    expect(state().plan ?? []).toEqual([]);
    expect(providerQueue).toHaveLength(0);
  });

  it("host 与 MCP 混批在主机工具等待期间停止，不丢待确认协议对也不再派发后续工具", async () => {
    mcpEnabled = true;
    heldReadFile = deferred<void>();
    const old = await startPartial();
    old.push({ text: "", toolCalls: [
      { id: "call-read", name: "ottr_read_file", arguments: '{"path":"/etc/hosts"}' },
      { id: "call-not-started", name: "ottr_exec_command", arguments: '{"command":"uptime"}' },
      { id: "call-mcp", name: "mcp__server-1__inspect", arguments: "{}" },
    ] });
    old.finish();
    await vi.waitFor(() => expect(state().runningHostToolCallId).toBe("call-read"));
    useAiStore.getState().abort("pane-a");
    heldReadFile.resolve();
    await runs[0];
    expect(state().status).toBe("aborted");
    expect(state().pendingToolCalls).toEqual([expect.objectContaining({
      id: "call-mcp", serverId: "server-1", tool: "inspect", args: "{}",
    })]);
    const assistant = state().messages.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistant?.toolCalls?.map((tc) => tc.id)).toEqual([
      "call-read", "call-not-started", "call-mcp",
    ]);
    // 未派发的主机调用必须有中止的 tool 响应；不能把半截协议带进下轮。
    expect(state().messages.filter((m) => m.role === "tool" && m.toolCallId === "call-not-started")).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "ai_scope_exec")).toHaveLength(0);
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "mcp_server_call")).toHaveLength(0);
    expect(state().plan ?? []).toEqual([]);
    expect(old.requests).toHaveLength(1);
    expect(providerQueue).toHaveLength(0);
  });

  it("runStep 等待期间新对话，旧工具迟到结果不得复活消息或续跑", async () => {
    heldRunStep = deferred<void>();
    const old = enqueue();
    useAiStore.getState().openAsk(request);
    useAiStore.getState().setMode("pane-a", "manual");
    runs.push(useAiStore.getState().run("pane-a", "看看负载"));
    await vi.waitFor(() => expect(old.requests).toHaveLength(1));
    old.push({ text: "", toolCalls: [{
      id: "call-exec", name: "ottr_exec_command", arguments: '{"command":"uptime"}',
    }] });
    old.finish();
    await runs[0];
    expect(state().status).toBe("awaiting_tool_approval");
    const resolved = useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    runs.push(resolved);
    await vi.waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "ai_scope_run_step")).toHaveLength(1));
    // 意外续跑时也给确定的响应，确保失败是状态被复活，而不是测试 provider 缺失。
    const unexpected = nextAnswer("旧工具不该启动的新回答");
    useAiStore.getState().newConversation("pane-a");
    const newConversationId = state().conversationId;
    heldRunStep.resolve();
    await resolved;
    expect(state().conversationId).toBe(newConversationId);
    expect(state().messages).toEqual([]);
    expect(state().plan ?? []).toEqual([]);
    expect(state().runId).toBeNull();
    expect(state().status).toBe("idle");
    expect(unexpected.requests).toHaveLength(0);
  });

  it("点停止仍保留已生成内容，迟到流不能改成完成或删除部分回答", async () => {
    const old = await startPartial();
    useAiStore.getState().abort("pane-a");
    const stopped = state();
    expect(stopped.status).toBe("aborted");
    expect(stopped.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["我先解释磁盘情况。"]);
    old.push({ text: "迟到内容" });
    old.finish();
    await runs[0];
    expect(state()).toBe(stopped);
  });

  it("等待用户确认时不停止、不丢弃待确认调用，也不开新请求", async () => {
    const old = await startPartial();
    const pending = {
      id: "call-1", serverId: "server-1", serverName: "server", tool: "run",
      args: "{}", runId: state().runId,
    };
    useAiStore.setState((s) => ({ sessions: {
      ...s.sessions, "pane-a": { ...state(), pendingToolCalls: [pending] },
    } }));
    const blocked = state();
    await useAiStore.getState().interrupt("pane-a", "新消息", state().runId);
    expect(state()).toBe(blocked);
    expect(old.requests[0].signal?.aborted).toBe(false);
  });

  it("旧运行快照在新运行启动后不能再次打断", async () => {
    await startPartial();
    const staleRunId = state().runId!;
    const next = enqueue();
    const first = useAiStore.getState().interrupt("pane-a", "第一条插话", staleRunId);
    runs.push(first);
    await vi.waitFor(() => expect(state().runId).not.toBe(staleRunId));
    const currentRunId = state().runId;
    await vi.waitFor(() => expect(next.requests).toHaveLength(1));
    await useAiStore.getState().interrupt("pane-a", "过期事件", staleRunId);
    expect(state().runId).toBe(currentRunId);
    expect(state().messages.filter((m) => m.role === "user" && m.content === "过期事件")).toHaveLength(0);
    expect(next.requests).toHaveLength(1);
  });
});
