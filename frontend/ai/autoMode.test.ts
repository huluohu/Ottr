// Ask Ottr 执行模式（第三步：Auto 档）store 层测试：
//   * 白名单命令：后端**当场执行** → 结果（输出 + 退出码）如实回灌模型 → 续跑；
//   * 非白名单命令：后端**降级**为逐条确认 → 挂起本轮 + 生成待确认卡
//     （档位标成 manual —— 降级产出的步骤后端已按手动档登记，点击「执行」
//     直接跑，不需要再升档）；
//   * 后端拒绝（红档命令 / 主机未授权）：零执行、零计划登记 → 失败原因回灌；
//   * 执行护栏：单轮命令步数到顶 → 不再发起执行类调用，如实回灌「已到上限」。
//
// provider 层 mock（按轮次脚本产出工具调用/最终回答）；invoke 全量 mock。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ChatDelta, ChatRequest, ToolCall } from "./provider";
import i18n from "../i18n";
import { useAiStore, type AskRequest, type SessionAiState } from "./aiStore";
import { useSessionStore, type Session } from "../session/SessionStore";

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

const ASK_A: AskRequest = {
  kind: "ask",
  sessionId: "pane-a",
  rustId: "pty-a",
  hostId: 7,
  hostName: "web-01",
  target: { ...TARGET_A },
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

function seedLivePanes(): void {
  useSessionStore.setState({
    sessions: [fakeSession()],
    activeId: "pane-a",
    activePane: {},
  });
}

/** ai_scope_exec 的回包策略（按用例改写）。 */
let execResult: { outcome?: Record<string, unknown>; error?: string } = {};
/** 护栏三键（按用例改写）。 */
let guardrails: { steps?: number; duration?: number } = {};

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
        if (args?.key === "ai.exec.timeout_secs") return Promise.resolve(guardrails.duration ?? 30);
        if (args?.key === "ai.auto.max_steps") return Promise.resolve(guardrails.steps ?? 10);
        if (args?.key === "ai.auto.max_duration_secs") {
          return Promise.resolve(guardrails.duration ?? 300);
        }
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "ai_scope_open":
        return Promise.resolve({
          ...(args?.target as Record<string, unknown>),
          scopeId: "scope-pane-a",
          endpoint: "10.0.0.1:22",
          username: "deploy",
        });
      case "ai_scope_context":
        return Promise.resolve({ tail: "终端输出尾部", notes: null });
      case "ai_scope_exec":
        if (execResult.error) return Promise.reject(new Error(execResult.error));
        return Promise.resolve(
          execResult.outcome ?? {
            executed: false,
            planned: true,
            stepId: "step-1",
            message: "recorded for confirmation; not executed yet",
          },
        );
      case "ai_scope_run_step":
        return Promise.resolve({
          executed: true,
          stepId: "step-1",
          exitCode: 0,
          stdout: "ran",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "ok",
        });
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

/** 首轮脚本：模型发起执行类调用（第二轮给最终回答）。 */
function execScript(command = "ls -la"): (turn: number) => ChatDelta[] {
  return (turn) =>
    turn === 0
      ? [
          {
            text: "",
            toolCalls: [toolCall("call_1", "ottr_exec_command", JSON.stringify({ command }))],
          },
        ]
      : [{ text: "已收悉" }];
}

/** 首轮脚本：模型一轮里发起**两条**执行类调用。 */
function execScript2(command = "ls -la"): (turn: number) => ChatDelta[] {
  return (turn) =>
    turn === 0
      ? [
          {
            text: "",
            toolCalls: [
              toolCall("call_1", "ottr_exec_command", JSON.stringify({ command })),
              toolCall("call_2", "ottr_exec_command", JSON.stringify({ command: "df -h /" })),
            ],
          },
        ]
      : [{ text: "已收悉" }];
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, name, arguments: args };
}

beforeEach(async () => {
  turnIndex = 0;
  requests = [];
  script = () => [{ text: "最终回答" }];
  execResult = {};
  guardrails = {};
  mockedInvoke.mockReset();
  useAiStore.getState().close?.("pane-a");
  useAiStore.setState({ sessions: {} });
  mockBackend();
  seedLivePanes();
});

describe("auto 档：白名单命令直接执行", () => {
  it("后端回 executed=true + 结果 → 结果如实回灌模型（输出 + 退出码），不进待执行清单", async () => {
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto mode executed the command (read-only command ls)",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: 0,
          stdout: "total 8\ndrwxr-xr-x 2 root root",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "command completed successfully (exit code 0)",
        },
      },
    };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "看看目录");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    // ★ 结果**必须**带真实输出与退出码——只回「已执行」等于让模型瞎猜。
    expect(toolTurn.content).toContain("total 8");
    expect(toolTurn.content).toContain("exit code: 0");
    // ★ 自动跑过的命令要**进清单**（状态=已完成）——用户必须看得到 AI 在
    // 自己主机上自动跑了什么、结果如何（自动档的信任面）。
    const step = slice()?.plan?.[0];
    expect(step?.status).toBe("done");
    expect(step?.command).toBe("ls -la");
    expect(step?.result?.exitCode).toBe(0);
    expect(step?.result?.stdout).toContain("total 8");
    // 模型续跑（拿到结果后继续）
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it("非零退出码 → 清单里标「失败」（「已完成」只给真跑成功的）", async () => {
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto mode executed the command",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: 2,
          stdout: "",
          stderr: "no such file",
          truncated: false,
          timedOut: false,
          message: "command failed (exit code 2)",
        },
      },
    };
    script = execScript("ls /nope");
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    expect(slice()?.plan?.[0].status).toBe("failed");
    expect(slice()?.plan?.[0].result?.exitCode).toBe(2);
  });

  it("超时结果也如实回灌（带超时标记，不是「跑完了没退出码」）", async () => {
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto mode executed the command",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: true,
          message: "command timed out after 30s and the channel was closed (no exit code)",
        },
      },
    };
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain(i18n.t("ai.plan.timedOut"));
    expect(toolTurn.content).not.toContain("exit code: 0");
  });
});

describe("auto 档：非白名单命令降级为逐条确认", () => {
  it("后端回 planned + 降级原因 → 挂起本轮 + 生成待确认卡（档位=manual）", async () => {
    execResult = {
      outcome: {
        executed: false,
        planned: true,
        stepId: "step-9",
        message: "auto mode downgraded this command to manual confirmation",
        result: null,
        downgradeReason: "interpreter/privileged command \"sh\": downgraded to confirmation",
      },
    };
    script = execScript("sh -c ls");
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    // 降级产出的卡：登记为**手动档**（后端已按手动档登记 → 点「执行」直接跑）
    const step = slice()?.plan?.[0];
    expect(step?.registeredMode).toBe("manual");
    expect(step?.status).toBe("planned");
    expect(step?.command).toBe("sh -c ls");
    // 降级**不是**执行：后端执行面一次都没被调
    expect(calls("ai_scope_run_step")).toHaveLength(0);
  });

  it("点「执行」→ 走 run_step（不再升档）→ 结果回灌 → 续跑", async () => {
    execResult = {
      outcome: {
        executed: false,
        planned: true,
        stepId: "step-9",
        message: "auto mode downgraded this command to manual confirmation",
        result: null,
        downgradeReason: "downgraded to confirmation",
      },
    };
    script = execScript("sh -c ls");
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "跑一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    await useAiStore.getState().resolvePlanStep("pane-a", "step-9", true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(calls("ai_scope_run_step")).toHaveLength(1);
    // 降级步骤已是手动档 → **不调**升档面
    expect(calls("ai_scope_upgrade_step")).toHaveLength(0);
    expect(slice()?.plan?.[0].status).toBe("done");
  });
});

describe("auto 档：后端拒绝（红档命令 / 主机未授权）", () => {
  it("后端拒 → 零执行、零计划登记 → 失败原因回灌模型", async () => {
    execResult = { error: "AI exec rejected: blocked by the auto-mode safety rules" };
    script = execScript("rm -rf /");
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "清理一下");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 红的命令**不进**待执行清单（用户会以为它等着被跑）
    expect(slice()?.plan ?? []).toHaveLength(0);
    const toolTurn = slice()!.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("safety rules");
  });
});

describe("auto 档：执行护栏", () => {
  it("单轮命令步数到顶 → 不再发起执行类调用，如实回灌「已到上限」", async () => {
    // 上限设为 1：第二条命令不该再发起。
    guardrails = { steps: 1 };
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto mode executed the command",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "command completed successfully (exit code 0)",
        },
      },
    };
    script = execScript2();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "跑两个");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 只发起了一次执行类调用（第二条被护栏挡住）
    expect(calls("ai_scope_exec")).toHaveLength(1);
    const toolTurns = slice()!.messages.filter((m) => m.role === "tool");
    expect(toolTurns.some((t) => t.content.includes(i18n.t("ai.auto.stepLimitReached", { count: 1 })))).toBe(
      true,
    );
  });
});

// 2026-11-08 审计 A3 回归
describe("auto 档：执行记录保全（2026-11-08 审计 A3）", () => {
  it("执行中被停止：已跑完的命令记录仍进清单（信任面不丢；不复活进新对话）", async () => {
    // ai_scope_exec（= auto 档的登记+执行一步）挂起 → abort → 放行：
    // executed 结果的 done 记录此前被 alive() 检查丢弃，现在迟到也落库。
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto mode executed the command (read-only command ls)",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: 0,
          stdout: "total 8",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "ok",
        },
      },
    };
    let release!: (v: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((res) => {
      release = res;
    });
    const base = mockedInvoke.getMockImplementation()!;
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "ai_scope_exec" ? gate : base(cmd, args),
    );
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    const runPromise = useAiStore.getState().run("pane-a", "看看目录");
    await vi.waitFor(() => expect(calls("ai_scope_exec")).toHaveLength(1));

    useAiStore.getState().abort("pane-a");
    release(execResult.outcome!);
    await runPromise;

    const step = slice()?.plan?.[0];
    expect(step?.status).toBe("done");
    expect(step?.result?.stdout).toContain("total 8");
    // 面板回到非 running 态（不因迟到回包卡「生成中」）
    expect(slice()?.status).not.toBe("running");
  });

  it("新对话换代：迟到的执行记录不复活进新对话的空清单", async () => {
    execResult = {
      outcome: {
        executed: true,
        planned: false,
        stepId: "step-1",
        message: "auto executed",
        result: {
          executed: true,
          stepId: "step-1",
          exitCode: 0,
          stdout: "out",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "ok",
        },
      },
    };
    let release!: (v: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>((res) => {
      release = res;
    });
    const base = mockedInvoke.getMockImplementation()!;
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
      cmd === "ai_scope_exec" ? gate : base(cmd, args),
    );
    script = execScript();
    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "auto");
    const runPromise = useAiStore.getState().run("pane-a", "看看目录");
    await vi.waitFor(() => expect(calls("ai_scope_exec")).toHaveLength(1));

    // 换代：新对话（conversationId 换新、计划清空）后再放行迟到结果
    useAiStore.getState().newConversation("pane-a");
    release(execResult.outcome!);
    await runPromise;

    expect(slice()?.plan ?? []).toHaveLength(0);
  });
});
