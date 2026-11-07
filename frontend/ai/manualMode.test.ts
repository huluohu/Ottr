// Ask Ottr 执行模式（第二步：Manual 档）store 层测试：
//   * 模型发起 ottr_exec_command → **只登记、不执行**（run_step 零调用）→ 本轮
//     挂起（status=awaiting_tool_approval）+ 计划步骤待确认；
//   * 点「执行」→ 调 `ai_scope_run_step(scopeId, stepId, actionId)` → 结果作为
//     tool 轮回灌模型 → **续跑一轮** → 步骤状态 done；
//   * 点「拒绝」→ 「已拒绝」回灌 → 续跑 → 步骤状态 rejected；
//   * 重复点击只执行一次（执行中状态 = 前端那一道闸）；
//   * plan 档**不调** run_step（后端也会拒，前端不暴露入口）；
//   * 跨目标：切到别的终端后，原对话的步骤执行仍打**原 scope**；
//   * 模式切换（plan ↔ manual）步骤不丢。
//
// provider 层 mock（按轮次脚本产出工具调用/最终回答）；invoke 全量 mock。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ChatDelta, ChatRequest, ToolCall } from "./provider";
import i18n from "../i18n";
import { newRearmActionId, useAiStore, type AskRequest, type SessionAiState } from "./aiStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { resetRateLimiter, setNotifyPorts } from "../notify/core";

/** 每轮 provider 的产出脚本（按轮次索引）。 */
let script: (turn: number, req: ChatRequest) => ChatDelta[] = () => [{ text: "最终回答" }];
/** 已发出的请求（按轮次顺序）。 */
let requests: ChatRequest[] = [];
let turnIndex = 0;

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => ({
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        const turn = turnIndex++;
        requests.push(req);
        for (const d of script(turn, req)) {
          await Promise.resolve();
          yield d;
        }
      },
      async testConnection(): Promise<string> {
        return "ok";
      },
    }),
  };
});

const mockedInvoke = invoke as unknown as Mock;

const TARGET_A = {
  paneSessionId: "pane-a",
  rootTabId: "pane-a",
  rustId: "pty-a",
  connectionEpoch: 1,
  kind: "ssh" as const,
  hostId: 7,
};

const TARGET_B = {
  paneSessionId: "pane-b",
  rootTabId: "pane-b",
  rustId: "pty-b",
  connectionEpoch: 1,
  kind: "ssh" as const,
  hostId: 9,
};

const ASK_A: AskRequest = {
  kind: "ask",
  sessionId: "pane-a",
  rustId: "pty-a",
  hostId: 7,
  hostName: "web-01",
  target: { ...TARGET_A },
};

const ASK_B: AskRequest = {
  kind: "ask",
  sessionId: "pane-b",
  rustId: "pty-b",
  hostId: 9,
  hostName: "db-01",
  target: { ...TARGET_B },
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

/** 活目标会话（pane-a / pane-b 同时在场）。 */
function seedLivePanes(): void {
  useSessionStore.setState({
    sessions: [
      fakeSession(),
      fakeSession({ id: "pane-b", hostId: 9, hostName: "db-01", rustId: "pty-b" }),
    ],
    activeId: "pane-a",
    activePane: {},
  });
}

/** ai_scope_run_step 的回包策略（按用例改写）。 */
let runResult: { outcome?: Record<string, unknown>; error?: string } = {};
/** ai_scope_exec 的登记次数（每次登记返回**新的** stepId——后端按 actionId
 *  一次性登记，重登记 = 新的一条）。 */
let execSeq = 0;
/** ai_scope_upgrade_step 的回包策略（档位升级面：后端取命令原文）。 */
let upgradeResult: { outcome?: Record<string, unknown>; error?: string } = {};
/** ai_scope_upgrade_step 的升级次数（每次升级 = 新登记的一条 → 新 stepId）。 */
let upgradeSeq = 0;

/** 后端桩：设置 / key / scope / 主机工具 / run_step。 */
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
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "ai_scope_open": {
        const target = args?.target as Record<string, unknown>;
        return Promise.resolve({
          ...target,
          scopeId: `scope-${target.paneSessionId}`,
          endpoint: "10.0.0.1:22",
          username: "deploy",
        });
      }
      case "ai_scope_context":
        return Promise.resolve({ tail: "终端输出尾部", notes: null });
      case "ai_scope_exec": {
        // plan / manual 一律**只登记**：零执行，回一个 stepId。
        // 每次登记都是**新的一条**（后端按 actionId 一次性消费）。
        execSeq += 1;
        return Promise.resolve({
          executed: false,
          planned: true,
          stepId: `step-${execSeq}`,
          message: "recorded for confirmation; not executed (manual mode)",
        });
      }
      case "ai_scope_upgrade_step": {
        // 档位升级面（2026-11-04 修补 I-1）：**命令原文只从后端登记簿里取**
        // ——本命令**没有命令参数**（前端不传命令）。升级只升级、不执行。
        if (upgradeResult.error) return Promise.reject(new Error(upgradeResult.error));
        upgradeSeq += 1;
        return Promise.resolve(
          upgradeResult.outcome ?? {
            stepId: `upgraded-${upgradeSeq}`,
            actionId: (args?.actionId as string) ?? "",
            mode: "manual",
            message: "upgraded to manual mode (recorded from the plan registry; not executed yet)",
          },
        );
      }
      case "ai_scope_run_step":
        if (runResult.error) return Promise.reject(new Error(runResult.error));
        return Promise.resolve(
          runResult.outcome ?? {
            executed: true,
            stepId: "step-1",
            exitCode: 0,
            stdout: "hello from host",
            stderr: "",
            truncated: false,
            message: "executed (manual mode)",
          },
        );
      case "ai_scope_revoke":
        return Promise.resolve(null);
      case "mcp_servers_list":
        return Promise.resolve([]);
      case "notify_insert":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

const slice = (id = "pane-a"): SessionAiState | undefined =>
  useAiStore.getState().sessions[id];

const calls = (cmd: string): [string, Record<string, unknown>?][] =>
  (mockedInvoke.mock.calls as [string, Record<string, unknown>?][]).filter(([c]) => c === cmd);

/** 一次工具调用的标准形态。 */
function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, name, arguments: args };
}

/** 首轮脚本：模型发起执行类调用（第二轮给最终回答）。 */
function execScript(command = "uptime"): (turn: number) => ChatDelta[] {
  return (turn) =>
    turn === 0
      ? [
          {
            text: "我先看负载",
            toolCalls: [toolCall("call_1", "ottr_exec_command", JSON.stringify({ command }))],
          },
        ]
      : [{ text: "已收悉" }];
}

/** 首轮脚本：模型一轮里发起**两条**不同的执行类调用。 */
function execScript2(command = "uptime"): (turn: number) => ChatDelta[] {
  return (turn) =>
    turn === 0
      ? [
          {
            text: "我先看两样",
            toolCalls: [
              toolCall("call_1", "ottr_exec_command", JSON.stringify({ command })),
              toolCall("call_2", "ottr_exec_command", JSON.stringify({ command: "df -h" })),
            ],
          },
        ]
      : [{ text: "已收悉" }];
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  requests = [];
  turnIndex = 0;
  script = () => [{ text: "最终回答" }];
  runResult = {};
  execSeq = 0;
  upgradeResult = {};
  upgradeSeq = 0;
  useAiStore.setState({ sessions: {} });
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 0, focused: () => false, system: async () => {} });
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

describe("manual 档：登记即挂起（零执行）", () => {
  it("模型发起 exec → 步骤待确认、run_step 零调用、本轮挂起", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    // 只登记、**一个字节都没执行**
    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(calls("ai_scope_exec")[0]?.[1]).toMatchObject({ command: "uptime", mode: "manual" });
    expect(calls("ai_scope_run_step")).toHaveLength(0);

    // 计划步骤：待确认 + 绑定了登记时的 scope/action（目标绑定）
    const plan = slice()?.plan ?? [];
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      id: "step-1",
      command: "uptime",
      status: "planned",
      scopeId: "scope-pane-a",
      target: "ssh:pty-a",
    });
    expect(plan[0].actionId).toBeTruthy();
    // 这次 tool call 还没被回答（处置时才回灌 tool 轮）
    expect(plan[0].toolCallIds).toEqual(["call_1"]);
    // 本轮只发了一次请求（模型续跑等用户处置）
    expect(requests).toHaveLength(1);
  });

  it("待处置时追问输入被挡住（run 不开新链）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));
    await useAiStore.getState().run("pane-a", "再问一句");
    expect(requests).toHaveLength(1); // 没有新链
  });
});

describe("manual 档：执行路径", () => {
  it("点「执行」→ 调 run_step → 结果回灌模型 → 续跑 → 步骤 done", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // run_step：参数 = 登记时的 scope + stepId + actionId（前端不传命令原文）
    const runCalls = calls("ai_scope_run_step");
    expect(runCalls).toHaveLength(1);
    const step = slice()!.plan![0];
    expect(runCalls[0]?.[1]).toMatchObject({
      scopeId: "scope-pane-a",
      stepId: "step-1",
      actionId: step.actionId,
    });
    expect(runCalls[0]?.[1]).not.toHaveProperty("command");

    // 结果作为 tool 轮回灌模型（对应那次 ottr_exec_command 调用）
    const toolTurn = slice()!.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toContain("hello from host");
    expect(toolTurn?.toolCallId).toBe("call_1");
    expect(toolTurn?.toolName).toBe("ottr_exec_command");

    // 模型续跑（第二轮请求带着 tool 轮）
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m) => m.role === "tool")).toBe(true);
    expect(slice()?.answer).toContain("已收悉");

    // 步骤状态 done + 结果就地回填
    expect(slice()?.plan?.[0].status).toBe("done");
    expect(slice()?.plan?.[0].result).toMatchObject({
      exitCode: 0,
      stdout: "hello from host",
      truncated: false,
    });
  });

  it("退出码非 0 → 步骤 failed（但命令确实跑了）", async () => {
    mockBackend();
    seedLivePanes();
    runResult = {
      outcome: {
        executed: true,
        stepId: "step-1",
        exitCode: 2,
        stdout: "",
        stderr: "no such file",
        truncated: false,
        message: "executed (manual mode)",
      },
    };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.exitCode).toBe(2);
    expect(slice()?.plan?.[0].result?.stderr).toContain("no such file");
    const toolTurn = slice()!.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toContain("no such file");
  });

  it("消费侧硬超时 → 单独标超时（不能只靠「退出码 -」让人猜）", async () => {
    // 真机取证发现（2026-11-04）：超时与「服务端没回退出码」在退出码上
    // 都是 null —— 不单独给结论，模型会把超时当成「跑完了但没退出码」。
    mockBackend();
    seedLivePanes();
    runResult = {
      outcome: {
        executed: true,
        stepId: "step-1",
        exitCode: null,
        stdout: "partial output",
        stderr: "",
        truncated: false,
        timedOut: true,
        message: "command timed out after 30s and the channel was closed (no exit code)",
      },
    };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.timedOut).toBe(true);
    // 回灌模型的内容必须带**后端摘要**（说清是超时，不是「跑完了」）。
    const toolTurn = slice()!.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toContain("timed out");
    expect(toolTurn?.content).toContain("partial output");
  });

  it("后端拒绝 → 步骤 failed + 失败原因回灌模型", async () => {
    mockBackend();
    seedLivePanes();
    runResult = { error: "AI run_step rejected: scope revoked" };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.error).toContain("scope revoked");
    const toolTurn = slice()!.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toContain("scope revoked");
  });

  it("重复点击只执行一次（执行中状态挡住第二击）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    // 不 await 第一击，连点第二击
    const first = useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    const second = useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    expect(calls("ai_scope_run_step")).toHaveLength(1);
  });

  it("已执行/已拒绝的步骤不可重复执行（前端这一道闸）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    // 再点一次 → 无效（步骤已 done）
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    expect(calls("ai_scope_run_step")).toHaveLength(1);
  });
});

describe("manual 档：拒绝路径", () => {
  it("点「拒绝」→ 「已拒绝」回灌 → 续跑 → 步骤 rejected（零执行）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", false);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 拒绝 = 命令没跑
    expect(calls("ai_scope_run_step")).toHaveLength(0);
    expect(slice()?.plan?.[0].status).toBe("rejected");
    const toolTurn = slice()!.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toContain("拒绝");
    expect(toolTurn?.toolCallId).toBe("call_1");
    // 模型续跑
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m) => m.role === "tool")).toBe(true);
  });
});

describe("plan 档：不提供执行入口", () => {
  it("plan 档下不调 run_step（后端也会拒，前端不暴露）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本测试专测「plan 档」语义：显式切到 plan（面板下拉已不提供，内部保留）
    useAiStore.getState().setMode("pane-a", "plan");
    expect(slice()?.mode).toBe("plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(calls("ai_scope_run_step")).toHaveLength(0);
    // plan 档：步骤登记即入清单（当轮就答了模型 → 继续把计划列全）
    expect(slice()?.plan).toHaveLength(1);
    expect(slice()?.plan?.[0].status).toBe("planned");
    expect(slice()?.plan?.[0].toolCallIds).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("plan 档下即使直接调 resolvePlanStep 也不执行", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    expect(calls("ai_scope_run_step")).toHaveLength(0);
    expect(slice()?.plan?.[0].status).toBe("planned");
  });
});

describe("跨目标绑定", () => {
  it("切到别的终端后，原对话的步骤执行仍打原 scope（不是当前焦点）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript("uptime");
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice("pane-a")?.status).toBe("awaiting_tool_approval"));

    // 切到另一个终端（另一个 pane 会话）开新对话
    useAiStore.getState().openAsk(ASK_B);
    expect(slice("pane-b")?.plan ?? []).toHaveLength(0);

    // 原对话的步骤照常执行 → 打的是原 scope
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice("pane-a")?.status).toBe("done"));

    const runCalls = calls("ai_scope_run_step");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.[1]).toMatchObject({ scopeId: "scope-pane-a" });
    // 结果回灌**原对话**
    expect(slice("pane-a")?.messages.some((m) => m.role === "tool")).toBe(true);
    expect(slice("pane-b")?.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("模式切换：步骤不丢", () => {
  it("plan → manual → plan：同一条步骤一直在清单里（只是形态变）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan).toHaveLength(1);

    useAiStore.getState().setMode("pane-a", "manual");
    expect(slice()?.mode).toBe("manual");
    expect(slice()?.plan).toHaveLength(1);

    useAiStore.getState().setMode("pane-a", "plan");
    expect(slice()?.mode).toBe("plan");
    expect(slice()?.plan).toHaveLength(1);
    expect(slice()?.plan?.[0].command).toBe("uptime");
  });

  it("plan 档登记的步骤切到 manual → 仍打**原 scope**（不换成当前焦点目标）", async () => {
    // 后端按**登记时落账的档位**判定执行权：plan 档登记的步骤后端会拒——所以
    // 前端在点「执行」时先让**后端升档**（见下方「档位升级」一组）。
    // 前端这一层始终守着的纪律：**不自己改写命令、不换成当前焦点目标**。
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(calls("ai_scope_run_step")).toHaveLength(1));
    // 打的仍是登记时那个 scope（不是当前焦点终端）
    expect(calls("ai_scope_run_step")[0]?.[1]).toMatchObject({
      scopeId: "scope-pane-a",
    });
    // 升档也用同一个 scope（不换目标）
    expect(calls("ai_scope_upgrade_step")[0]?.[1]).toMatchObject({ scopeId: "scope-pane-a" });
    // 命令原文不随执行/升档请求上送（执行对象 = 后端登记簿里那条）
    expect(calls("ai_scope_run_step")[0]?.[1]).not.toHaveProperty("command");
    expect(calls("ai_scope_upgrade_step")[0]?.[1]).not.toHaveProperty("command");
  });
});

// ---------------------------------------------------------------------------
// 2026-11-04 修补 I-1：档位升级（plan 档登记 → manual 档）
//
// 断裂：后端 `ai_scope_run_step` 按**登记时落账的档位**判定执行权——plan 档
// 登记的步骤一律拒「plan mode does not execute」。用户在 plan 档提问 → 看到
// 计划清单 → 切到「手动」档 → 点「执行」必然失败（手动档的意义就是「我来
// 确认执行」）。修法：点「执行」的那一刻先让**后端**把这条步骤升到 manual
// 档（`ai_scope_upgrade_step`：**命令原文只从后端登记簿里取**，前端不传
// 命令），再执行升级后那条。
// ---------------------------------------------------------------------------

describe("档位升级：plan 档登记的步骤在手动档可执行", () => {
  it("点「执行」→ 先调后端升级（命令原文由后端取）→ 再 runStep 升级后那条", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    // plan 档提问 → 清单里一条
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const before = slice()!.plan![0];
    expect(before.id).toBe("step-1");
    expect(before.registeredMode).toBe("plan");
    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(calls("ai_scope_exec")[0]?.[1]).toMatchObject({ mode: "plan" });

    // 切到手动档 → 点「执行」
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);

    // --- 两步，顺序不可换：先升级（后端取命令原文），再 runStep ---
    const upgradeCalls = calls("ai_scope_upgrade_step");
    expect(upgradeCalls).toHaveLength(1);
    expect(upgradeCalls[0]?.[1]).toMatchObject({
      scopeId: "scope-pane-a",
      stepId: "step-1", // 待升级的那条
    });
    // **命令原文不上送**（前端不传命令——执行对象 = 后端登记簿里那条）。
    expect(upgradeCalls[0]?.[1]).not.toHaveProperty("command");
    const newActionId = (upgradeCalls[0]?.[1] as { actionId: string }).actionId;
    expect(newActionId).toBeTruthy();
    expect(newActionId).not.toBe(before.actionId);
    // **不再**用前端手里的命令副本重新登记（那条路径已撤掉）。
    expect(calls("ai_scope_exec")).toHaveLength(1);

    const runCalls = calls("ai_scope_run_step");
    expect(runCalls).toHaveLength(1);
    // 执行的是**升级后新登记的那条**（新 stepId + 新 actionId 配对）
    expect(runCalls[0]?.[1]).toMatchObject({
      scopeId: "scope-pane-a",
      stepId: "upgraded-1",
      actionId: newActionId,
    });
    // 命令原文仍不随执行请求上送（执行对象 = 后端登记簿里那条）
    expect(runCalls[0]?.[1]).not.toHaveProperty("command");

    // 清单里那一条改指新步骤（重复点不再用旧 id）
    const after = slice()!.plan![0];
    expect(after.id).toBe("upgraded-1");
    expect(after.actionId).toBe(newActionId);
    expect(after.registeredMode).toBe("manual");
    expect(after.status).toBe("done");

    // 结果回灌模型（plan 档登记的步骤没有待答 call id → 以用户轮告知）
    expect(slice()!.messages.some((m) => m.content.includes("hello from host"))).toBe(true);
  });

  it("升档**不再**用前端手里的命令副本重新登记（命令原文由后端从登记簿取）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(calls("ai_scope_run_step")).toHaveLength(1));

    // 全程**只有一次** ai_scope_exec（模型那次登记，mode=plan）——升档走的是
    // 后端 ai_scope_upgrade_step，**不把命令副本再送一遍**。
    const execCalls = calls("ai_scope_exec");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.[1]).toMatchObject({ mode: "plan" });
    expect(
      execCalls.some(([, args]) => (args as { mode?: string })?.mode === "manual"),
      "前端不得再以 manual 档重新登记（那条路径已撤掉）",
    ).toBe(false);
    // 升档载荷里没有命令原文。
    const upgradeArgs = calls("ai_scope_upgrade_step")[0]?.[1] as Record<string, unknown>;
    expect(upgradeArgs).not.toHaveProperty("command");
  });

  it("manual 档登记的步骤 → 直接 runStep，不多一次登记/升级调用", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().run("pane-a", "看看负载");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(slice()?.plan?.[0].registeredMode).toBe("manual");

    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // **没有第二次登记**（直路）：仍是一次 exec 登记 + 一次 run_step
    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(calls("ai_scope_upgrade_step")).toHaveLength(0);
    expect(calls("ai_scope_run_step")).toHaveLength(1);
    expect(calls("ai_scope_run_step")[0]?.[1]).toMatchObject({ stepId: "step-1" });
  });

  it("升级用的 actionId 唯一（不复用已消费的 id）", async () => {
    // 纯函数层：同一个 runId + 同一个 stepId 连调两次 → 两个不同的 id
    const a = newRearmActionId("run-1", "step-1");
    const b = newRearmActionId("run-1", "step-1");
    expect(a).not.toBe(b);
    expect(a).toContain("run-1:rearm:step-1:");
    expect(b).toContain("run-1:rearm:step-1:");

    // 集成层：两条 plan 档登记的步骤各自升级 → 两个互不相同的 actionId，
    // 且都与原登记的 actionId 不同（后端按 actionId 一次性消费，复用即拒）。
    mockBackend();
    seedLivePanes();
    script = execScript2();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan).toHaveLength(2);
    const origA = slice()!.plan![0].actionId;
    const origB = slice()!.plan![1].actionId;

    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await useAiStore.getState().resolvePlanStep("pane-a", "step-2", true);

    const upgradeCalls = calls("ai_scope_upgrade_step");
    expect(upgradeCalls).toHaveLength(2); // 两条步骤各升级一次
    const rearmA = (upgradeCalls[0]?.[1] as { actionId: string }).actionId;
    const rearmB = (upgradeCalls[1]?.[1] as { actionId: string }).actionId;
    expect(rearmA).not.toBe(rearmB);
    expect(rearmA).not.toBe(origA);
    expect(rearmB).not.toBe(origB);
    expect(rearmA).not.toBe(origB);
    expect(rearmB).not.toBe(origA);
    // 升级**不重新登记**（命令原文由后端从登记簿里取）。
    expect(calls("ai_scope_exec")).toHaveLength(2);
  });

  it("连点两次「执行」→ 只升级一次（actionId 不被复用）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    useAiStore.getState().setMode("pane-a", "manual");

    // 不 await 第一击，连点第二击（第二击被「执行中」状态挡下）
    const first = useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    const second = useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    await Promise.all([first, second]);

    // 一次登记 + 一次升级 + 一次执行（没有第二次升级 = 没有第二个 actionId）
    expect(calls("ai_scope_exec")).toHaveLength(1);
    expect(calls("ai_scope_upgrade_step")).toHaveLength(1);
    expect(calls("ai_scope_run_step")).toHaveLength(1);
  });

  it("升级失败 → 步骤 failed + 原因可见（命令没跑，不吞错）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 升级被后端拒
    upgradeResult = { error: "AI upgrade rejected: vault locked" };
    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);

    // 命令**没跑**
    expect(calls("ai_scope_run_step")).toHaveLength(0);
    // 步骤 failed + 失败原因可见
    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.error).toContain("vault locked");
    // 失败原因回灌模型（不静默成功）
    expect(slice()!.messages.some((m) => m.content.includes("vault locked"))).toBe(true);
  });

  it("升级成功但 runStep 失败 → 步骤 failed + 原因可见", async () => {
    mockBackend();
    seedLivePanes();
    runResult = { error: "AI run rejected: scope revoked" };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    useAiStore.getState().setMode("pane-a", "manual");
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);

    expect(calls("ai_scope_upgrade_step")).toHaveLength(1); // 升级过了
    expect(calls("ai_scope_run_step")).toHaveLength(1);
    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.error).toContain("scope revoked");
    expect(slice()!.messages.some((m) => m.content.includes("scope revoked"))).toBe(true);
  });

  it("plan 档下仍不调 run_step、也不重新登记（零执行保证不变）", async () => {
    mockBackend();
    seedLivePanes();
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    // 本组测「plan 档登记 → 升档执行」链路：显式置 plan（默认已改逐条确认）
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // plan 档直接调 resolvePlanStep → 什么都不发生（连登记都不做）
    await useAiStore.getState().resolvePlanStep("pane-a", "step-1", true);
    expect(calls("ai_scope_run_step")).toHaveLength(0);
    expect(calls("ai_scope_exec")).toHaveLength(1); // 只有原登记那次
    expect(slice()?.plan?.[0].status).toBe("planned");
  });
});
