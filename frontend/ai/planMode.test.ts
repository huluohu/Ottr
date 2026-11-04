// Ask Ottr 执行模式（第一步：Plan）store 层测试：
//   * 默认 mode = plan；模式随会话保持；新对话复位到 plan；
//   * plan 下模型发起 ottr_exec_command → **只记入计划、不执行**，
//     并把「已记入计划，暂不执行」作为 tool 轮回灌给模型（模型继续出计划）；
//   * 只读工具（ottr_read_file / ottr_list_dir / ottr_read_output）在 plan 下
//     **照常执行**（读上下文是安全的）；
//   * 跨目标隔离：切到别的终端（另一个 pane 会话）后，原对话的步骤仍属原目标。
// 2026-11-04 修补批次：A1（本地会话不开放主机文件读取）/ A4（失败不进计划
//   清单）/ B1（executed 与 planned 分别回灌）/ B2（去重键含绑定目标）/
//   B3（AI 只读探查总开关）/ B5（actionId 格式断言）。
//
// provider 层 mock（按轮次脚本产出工具调用/最终回答）；invoke 全量 mock。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ChatDelta, ChatRequest, ToolCall } from "./provider";
import i18n from "../i18n";
import { useAiStore, type AskRequest, type SessionAiState } from "./aiStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { resetRateLimiter, setNotifyPorts } from "../notify/core";
import { AI_READ_PROBE_STORAGE_KEY } from "./aiReadProbe";

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

/** 本地终端目标（A1 用：本地会话不开放主机文件读取面）。 */
const TARGET_LOCAL = {
  paneSessionId: "pane-local",
  rootTabId: "pane-local",
  rustId: "pty-local",
  connectionEpoch: 1,
  kind: "local" as const,
  hostId: null,
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

const ASK_LOCAL: AskRequest = {
  kind: "ask",
  sessionId: "pane-local",
  rustId: "pty-local",
  hostId: null,
  hostName: "local",
  target: { ...TARGET_LOCAL },
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
      fakeSession({
        id: "pane-b",
        hostId: 9,
        hostName: "db-01",
        rustId: "pty-b",
      }),
    ],
    activeId: "pane-a",
    activePane: {},
  });
}

/** ai_scope_exec 的回包策略（按用例改写；默认 = plan 档零执行）。 */
let execResult: { outcome?: Record<string, unknown>; error?: string } = {};

/** 后端桩：设置 / key / scope / 主机工具。 */
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
      case "ai_scope_read_file":
        return Promise.resolve({
          path: args?.path,
          size: 12,
          content: "root:x:0:0",
          truncated: false,
        });
      case "ai_scope_list_dir":
        return Promise.resolve({
          path: args?.path,
          entries: [{ name: "etc", isDir: true, size: 0 }],
        });
      case "ai_scope_exec":
        // plan 档：后端**零执行**，只登记计划步骤 id（用例可改写成
        // 「已执行」/「被拒」/抛错——2026-11-04 修补 B1/A4 的回灌面）。
        if (execResult.error) return Promise.reject(new Error(execResult.error));
        return Promise.resolve(
          execResult.outcome ?? {
            executed: false,
            planned: true,
            stepId: "step-1",
            message: "recorded in the plan; not executed (plan mode)",
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

beforeEach(async () => {
  mockedInvoke.mockReset();
  requests = [];
  turnIndex = 0;
  script = () => [{ text: "最终回答" }];
  execResult = {};
  useAiStore.setState({ sessions: {} });
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 0, focused: () => false, system: async () => {} });
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

describe("执行模式（会话级）", () => {
  it("默认 mode = plan；面板切片里 mode 缺省也按 plan 读", async () => {
    mockBackend();
    seedLivePanes();
    useAiStore.getState().openAsk(ASK_A);
    expect(slice()?.mode).toBe("plan");
    expect(slice()?.plan).toEqual([]);
  });

  it("模式随会话保持（切到 manual 后追问轮仍是 manual）；新对话复位为 plan", async () => {
    mockBackend();
    seedLivePanes();
    script = () => [{ text: "回答" }];
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "manual");
    expect(slice()?.mode).toBe("manual");
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    // 追问轮：模式仍在（会话级）
    await useAiStore.getState().run("pane-a", "追问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.mode).toBe("manual");
    // 新对话 → 复位到默认档（plan）
    useAiStore.getState().newConversation("pane-a");
    expect(slice()?.mode).toBe("plan");
    expect(slice()?.plan).toEqual([]);
  });

  it("setMode 非法值归一到 plan（绝不落到更宽松的档）", () => {
    seedLivePanes();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "bogus" as never);
    expect(slice()?.mode).toBe("plan");
  });
});

describe("plan 模式：执行类动作只产计划", () => {
  it("模型发起 ottr_exec_command → 记入计划清单 + 未执行 + 「已记入计划」回灌", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "我先看磁盘",
              toolCalls: [
                toolCall("call_1", "ottr_exec_command", '{"command":"rm -rf /tmp/build"}'),
              ],
            },
          ]
        : [{ text: "计划如下" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "清理构建目录");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 后端收到的是 plan 档（闸门在后端），且是唯一一次执行类调用
    const execCalls = calls("ai_scope_exec");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.[1]).toMatchObject({ command: "rm -rf /tmp/build", mode: "plan" });
    // 计划清单：命令 + 危险等级 + 状态
    expect(slice()?.plan).toHaveLength(1);
    expect(slice()?.plan?.[0]).toMatchObject({
      id: "step-1",
      command: "rm -rf /tmp/build",
      danger: "red",
      status: "planned",
    });
    // tool 轮回灌「已记入计划，暂不执行」，模型据此续跑给出最终回答
    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("已记入计划");
    expect(toolTurn.toolName).toBe("ottr_exec_command");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m) => m.role === "tool")).toBe(true);
    expect(slice()?.answer).toContain("计划如下");
  });

  it("同一对话多次提问 → 计划步骤按命令去重累积", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn % 2 === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall(`call_${turn}`, "ottr_exec_command", '{"command":"df -h"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    await useAiStore.getState().run("pane-a", "第二问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan).toHaveLength(1);
  });

  it("plan 下只读工具照常执行（读文件 → 结果回灌模型）", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "我读一下用户表",
              toolCalls: [toolCall("call_1", "ottr_read_file", '{"path":"/etc/passwd"}')],
            },
          ]
        : [{ text: "读到了" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "看看用户表");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const readCalls = calls("ai_scope_read_file");
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]?.[1]).toMatchObject({ path: "/etc/passwd" });
    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("root:x:0:0");
    // 只读动作**不进计划清单**（计划只登记执行类动作）
    expect(slice()?.plan ?? []).toHaveLength(0);
    // 不需要用户点头：没有挂起待确认
    expect(slice()?.pendingToolCalls ?? []).toHaveLength(0);
  });

  it("plan 下只读工具照常执行（列目录 / 读输出尾 → 结果回灌模型）", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "看看目录和输出",
              toolCalls: [
                toolCall("call_1", "ottr_list_dir", '{"path":"/etc"}'),
                toolCall("call_2", "ottr_read_output", '{"bytes":2048}'),
              ],
            },
          ]
        : [{ text: "看到了" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "列一下 /etc");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    expect(calls("ai_scope_list_dir")).toHaveLength(1);
    expect(calls("ai_scope_list_dir")[0]?.[1]).toMatchObject({ path: "/etc" });
    // 读输出尾走 scope 上下文通道（同一作用域，不另开通道）
    const ctxCalls = calls("ai_scope_context");
    expect(ctxCalls.some(([, a]) => (a as { bytes?: number })?.bytes === 2048)).toBe(true);
    const toolTurns = slice()!.messages.filter((m) => m.role === "tool");
    expect(toolTurns).toHaveLength(2);
    expect(toolTurns[0].content).toContain("etc");
    // 只读动作不进计划清单
    expect(slice()?.plan ?? []).toHaveLength(0);
  });

  it("没有活目标时不提供内建主机工具（模型看不到 ottr_* 工具）", async () => {
    mockBackend();
    seedLivePanes();
    script = () => [{ text: "回答" }];
    // 无绑定目标的会话（旧入口路径）
    useAiStore.getState().openAsk({ ...ASK_A, target: null });
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const toolNames = (requests[0].tools ?? []).map((t) => t.name);
    expect(toolNames.some((n) => n.startsWith("ottr_"))).toBe(false);
  });

  it("有活目标时内建主机工具进入工具目录（绑定随请求快照走）", async () => {
    mockBackend();
    seedLivePanes();
    script = () => [{ text: "回答" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const toolNames = (requests[0].tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "ottr_read_output",
        "ottr_read_file",
        "ottr_list_dir",
        "ottr_exec_command",
      ]),
    );
    // 系统提示词说清主机工具的语义（只读直接跑 / 执行类按模式登记计划）
    expect(requests[0].system).toContain("主机工具");
  });
});

describe("跨目标隔离", () => {
  it("切到别的终端后，原对话的计划步骤仍属原目标（另一对话步骤为空）", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice("pane-a")?.status).toBe("done"));
    expect(slice("pane-a")?.plan).toHaveLength(1);

    // 切到另一个终端（另一个 pane 会话）开新对话
    useAiStore.getState().openAsk(ASK_B);
    expect(slice("pane-b")?.plan ?? []).toHaveLength(0);
    expect(slice("pane-b")?.target).toEqual(TARGET_B);
    // 原对话的步骤与目标绑定不变（没有换绑到新终端）
    expect(slice("pane-a")?.plan).toHaveLength(1);
    expect(slice("pane-a")?.target).toEqual(TARGET_A);
    expect(slice("pane-a")?.plan?.[0].command).toBe("uptime");
  });
});

// ---------------------------------------------------------------------------
// 2026-11-04 修补批次（A1/A4/B1/B2/B3/B5）
// ---------------------------------------------------------------------------

describe("修补批次（2026-11-04）", () => {
  // B1：前端必须**分别**读 `executed` 与 `planned`——第二步 manual 真执行时
  // 不能再向模型谎报「已记入计划，暂不执行」。
  it("B1：后端回 executed=true → 回灌「已执行」，且不进待执行清单", async () => {
    mockBackend();
    seedLivePanes();
    execResult = {
      outcome: {
        executed: true,
        planned: true,
        stepId: "step-exec",
        message: "executed (manual mode)",
      },
    };
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("已执行");
    expect(toolTurn.content).not.toContain("已记入计划");
    // 已执行的命令不是「待执行」步骤 → 不进计划清单
    expect(slice()?.plan ?? []).toHaveLength(0);
  });

  it("B1：后端回 executed=false + planned=true → 回灌「已记入计划，暂不执行」并进清单", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "规划一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("已记入计划");
    expect(toolTurn.content).not.toContain("已执行");
    expect(slice()?.plan).toHaveLength(1);
  });

  // A4：只有**真正登记进计划**的命令才进清单——失败/被拒的命令不进。
  it("A4：后端拒绝（抛错）→ 回灌「未执行（后端拒绝…）」，且不进计划清单", async () => {
    mockBackend();
    seedLivePanes();
    execResult = { error: "AI exec rejected: auto mode is not enabled yet" };
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "自动跑");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("未执行");
    expect(toolTurn.content).not.toContain("已记入计划");
    // 被拒的命令**不进**「待执行」清单（清单不是执行日志）
    expect(slice()?.plan ?? []).toHaveLength(0);
  });

  it("A4：后端回 executed=false + planned=false → 不进清单，回灌后端消息", async () => {
    mockBackend();
    seedLivePanes();
    execResult = {
      outcome: {
        executed: false,
        planned: false,
        stepId: "",
        message: "AI exec rejected: not registered",
      },
    };
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    expect(slice()?.plan ?? []).toHaveLength(0);
    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("not registered");
  });

  // B5：actionId 格式 = `${runId}:exec:${toolCallId}`（后端按它做一次性消费）。
  it("B5：actionId 格式 = `${runId}:exec:${toolCallId}`", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall("call_1", "ottr_exec_command", '{"command":"uptime"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const execCalls = calls("ai_scope_exec");
    expect(execCalls).toHaveLength(1);
    const actionId = (execCalls[0]?.[1] as { actionId: string }).actionId;
    // 发起工具调用的那一轮 assistant turn 带 runId —— actionId 必须由它派生
    const turn = slice()!.messages.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(turn?.runId).toBeTruthy();
    expect(actionId).toBe(`${turn?.runId}:exec:call_1`);
  });

  // B3：AI 只读探查总开关关闭 → 读文件 / 列目录**不进工具目录**。
  it("B3：只读探查关闭 → ottr_read_file / ottr_list_dir 不进工具目录（其余照旧）", async () => {
    localStorage.setItem(AI_READ_PROBE_STORAGE_KEY, "off");
    mockBackend();
    seedLivePanes();
    script = () => [{ text: "回答" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolNames = (requests[0].tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("ottr_read_file");
    expect(toolNames).not.toContain("ottr_list_dir");
    expect(toolNames).toEqual(
      expect.arrayContaining(["ottr_read_output", "ottr_exec_command"]),
    );
  });

  it("B3：只读探查默认开 → 四个工具都在目录里", async () => {
    mockBackend();
    seedLivePanes();
    script = () => [{ text: "回答" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "问题");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolNames = (requests[0].tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "ottr_read_output",
        "ottr_read_file",
        "ottr_list_dir",
        "ottr_exec_command",
      ]),
    );
  });

  // A1：本地终端会话**不开放主机文件读取面**——不打后端，回灌本地化拒绝。
  it("A1：本地会话读文件 / 列目录 → 不打后端，回灌本地化拒绝文案", async () => {
    mockBackend();
    useSessionStore.setState({
      sessions: [
        fakeSession({
          id: "pane-local",
          kind: "local",
          rustId: "pty-local",
        }),
      ],
      activeId: "pane-local",
      activePane: {},
    });
    script = (turn) =>
      turn === 0
        ? [
            {
              text: "",
              toolCalls: [
                toolCall("call_1", "ottr_read_file", '{"path":"/etc/passwd"}'),
                toolCall("call_2", "ottr_list_dir", '{"path":"/etc"}'),
              ],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_LOCAL);
    await useAiStore.getState().run("pane-local", "读一下文件");
    await vi.waitFor(() => expect(slice("pane-local")?.status).toBe("done"));

    // 一次都没打后端（本地会话没有主机文件读取面）
    expect(calls("ai_scope_read_file")).toHaveLength(0);
    expect(calls("ai_scope_list_dir")).toHaveLength(0);
    const toolTurns = slice("pane-local")!.messages.filter((m) => m.role === "tool");
    expect(toolTurns).toHaveLength(2);
    for (const turn of toolTurns) {
      expect(turn.content).toContain("本地终端会话不开放主机文件读取");
    }
  });

  // B2：计划去重键含绑定目标 → 同一条命令在不同目标下各自成步。
  it("B2：同一条命令在两个目标下 → 两步都在（去重键含绑定目标）", async () => {
    mockBackend();
    seedLivePanes();
    script = (turn) =>
      turn % 2 === 0
        ? [
            {
              text: "",
              toolCalls: [toolCall(`call_${turn}`, "ottr_exec_command", '{"command":"df -h"}')],
            },
          ]
        : [{ text: "好" }];
    useAiStore.getState().openAsk(ASK_A);
    await useAiStore.getState().run("pane-a", "第一问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan).toHaveLength(1);

    // 连接被替换（同一 pane、换了 runtime）→ 目标换代，同一条命令另成一步
    useSessionStore.setState((st) => ({
      ...st,
      sessions: st.sessions.map((s) =>
        s.id === "pane-a" ? fakeSession({ rustId: "pty-a2" }) : s,
      ),
    }));
    useAiStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        "pane-a": {
          ...st.sessions["pane-a"],
          target: { ...TARGET_A, rustId: "pty-a2" },
        },
      },
    }));
    await useAiStore.getState().run("pane-a", "第二问");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const plan = slice()?.plan ?? [];
    expect(plan).toHaveLength(2);
    expect(plan.map((s) => s.command)).toEqual(["df -h", "df -h"]);
    expect(plan.map((s) => s.target)).toEqual(["ssh:pty-a", "ssh:pty-a2"]);
  });
});
