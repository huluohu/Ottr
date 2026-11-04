// 计划步骤并入清单（`upsertPlanStep`）的语义分流测试：
//
//   * 自动档**当场执行**的那条（done / failed）**不被旧的规划档条目吞掉**——
//     面板上要显示「已自动执行」与结果，不是「待执行」；
//   * 自动档**降级**（后端按 manual 档登记）的那条与旧的规划档条目合并后，
//     **执行入口仍然可用**（登记档位 = manual，scope / action 取当前登记事实）；
//   * 旧的已定事实（done / failed / rejected / executing）不被后到的条目覆盖
//     （历史不覆盖，后到的另起一行）。
//
// 后半段是 store 层端到端：同一对话里**先规划档登记过**一条命令，**再在自动
// 档**跑 / 降级同一条——清单里那一条的状态、登记事实与执行入口都要对得上
// （旧条目的 scope 可能已被撤销，不能沿用）。
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
import { upsertPlanStep, type PlanStep } from "./aiModes";

/* ---------------------------------------------------------------------------
 * 一、纯函数层：合并的分流规则
 * ------------------------------------------------------------------------- */

const TARGET = "ssh:pty-a";

/** 规划档登记的旧条目（登记在**上一轮**的 scope 上——那个 scope 可能已撤销）。 */
function oldPlanned(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "old-step",
    command: "ls -la",
    danger: "green",
    status: "planned",
    target: TARGET,
    scopeId: "scope-old",
    actionId: "action-old",
    registeredMode: "plan",
    ...over,
  };
}

describe("upsertPlanStep：自动档已执行的步骤不被旧的待执行条目吞掉", () => {
  it("新的条目 done → 替换旧的 planned 条目（状态 / 结果 / 登记事实都用新的）", () => {
    const out = upsertPlanStep(
      [oldPlanned()],
      {
        id: "new-step",
        command: "ls -la",
        danger: "green",
        status: "done",
        target: TARGET,
        scopeId: "scope-new",
        actionId: "action-new",
        registeredMode: "auto",
        result: { exitCode: 0, stdout: "total 8", stderr: "", truncated: false },
      },
    );
    // 同一目标同一条命令仍只有一行
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "new-step",
      status: "done",
      scopeId: "scope-new",
      actionId: "action-new",
      registeredMode: "auto",
    });
    expect(out[0].result?.stdout).toBe("total 8");
  });

  it("新的条目 failed（自动档跑了但退出码非 0）→ 同样替换旧的 planned 条目", () => {
    const out = upsertPlanStep(
      [oldPlanned()],
      {
        id: "new-step",
        command: "ls -la",
        danger: "green",
        status: "failed",
        target: TARGET,
        scopeId: "scope-new",
        actionId: "action-new",
        registeredMode: "auto",
        result: { exitCode: 2, stdout: "", stderr: "no such file", truncated: false },
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("failed");
    expect(out[0].result?.exitCode).toBe(2);
    // 旧条目的登记事实（可能已撤销的 scope）不能沿用
    expect(out[0].scopeId).toBe("scope-new");
    expect(out[0].actionId).toBe("action-new");
  });

  it("旧的已定事实不被后到的条目覆盖（done / failed / rejected / executing）", () => {
    for (const status of ["done", "failed", "rejected", "executing"] as const) {
      const out = upsertPlanStep(
        [oldPlanned({ id: "old-step", status })],
        {
          id: "new-step",
          command: "ls -la",
          danger: "green",
          status: "planned",
          target: TARGET,
          scopeId: "scope-new",
          actionId: "action-new",
          registeredMode: "manual",
        },
      );
      // 旧的那一条原样留着，后到的另起一行
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ id: "old-step", status });
      expect(out[1]).toMatchObject({ id: "new-step", status: "planned" });
    }
  });
});

describe("upsertPlanStep：自动档降级（登记为 manual）与旧的 planned 条目并存", () => {
  it("合并成一行，登记档位取新的（manual）→ 执行入口仍然可用", () => {
    const out = upsertPlanStep(
      [oldPlanned()],
      {
        id: "new-step",
        command: "ls -la",
        danger: "green",
        status: "planned",
        target: TARGET,
        scopeId: "scope-new",
        actionId: "action-new",
        registeredMode: "manual",
        toolCallIds: ["call_2"],
      },
    );
    // 同一目标同一条命令不出现两行
    expect(out).toHaveLength(1);
    const step = out[0];
    // ★ 登记档位 = manual（不是旧条目的 plan）——自动档下这一条给执行入口
    expect(step.registeredMode).toBe("manual");
    expect(step.status).toBe("planned");
    // 登记事实取新的：当前 scope + 当前 action（旧的 scope 可能已被撤销）
    expect(step.scopeId).toBe("scope-new");
    expect(step.actionId).toBe("action-new");
    // 后端登记簿里那条 = 新的那条（与 actionId 同源：后端 stepId 由
    // actionId 派生，两者成对）——执行面按它取命令原文。
    expect(step.backendStepId).toBe("new-step");
    // 行标识沿用首次登记的那条（清单里这一行不换身份）
    expect(step.id).toBe("old-step");
  });

  it("两边都是待执行 → 合并成一行，待答的 tool call id 取并集", () => {
    const out = upsertPlanStep(
      [oldPlanned({ toolCallIds: ["call_1"], registeredMode: "manual" })],
      {
        id: "new-step",
        command: "ls -la",
        danger: "green",
        status: "planned",
        target: TARGET,
        scopeId: "scope-new",
        actionId: "action-new",
        registeredMode: "manual",
        toolCallIds: ["call_2"],
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].toolCallIds).toEqual(["call_1", "call_2"]);
    expect(out[0].id).toBe("old-step");
    expect(out[0].backendStepId).toBe("new-step");
  });

  it("不同目标的同一条命令各自成步（不合并）", () => {
    const out = upsertPlanStep(
      [oldPlanned()],
      {
        id: "new-step",
        command: "ls -la",
        danger: "green",
        status: "planned",
        target: "ssh:pty-b",
        scopeId: "scope-new",
        actionId: "action-new",
        registeredMode: "manual",
      },
    );
    expect(out).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------------------
 * 二、store 层端到端：规划档登记过 → 自动档再跑 / 再降级
 * ------------------------------------------------------------------------- */

/** 每轮 provider 的产出脚本（按轮次索引）。 */
let script: (turn: number, req: ChatRequest) => ChatDelta[] = () => [{ text: "最终回答" }];
let turnIndex = 0;

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => ({
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        const turn = turnIndex++;
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

/** ai_scope_exec 的回包队列（按调用顺序取；用完回落到「只登记」）。 */
let execOutcomes: Record<string, unknown>[] = [];
/** scope 序号（每轮 run 现开一个 scope——真实后端每轮换一个）。 */
let scopeSeq = 0;

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
        if (args?.key === "ai.exec.timeout_secs") return Promise.resolve(30);
        if (args?.key === "ai.auto.max_steps") return Promise.resolve(10);
        if (args?.key === "ai.auto.max_duration_secs") return Promise.resolve(300);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "ai_scope_open": {
        scopeSeq += 1;
        const target = args?.target as Record<string, unknown>;
        return Promise.resolve({
          ...target,
          scopeId: `scope-${scopeSeq}`,
          endpoint: "10.0.0.1:22",
          username: "deploy",
        });
      }
      case "ai_scope_context":
        return Promise.resolve({ tail: "终端输出尾部", notes: null });
      case "ai_scope_exec": {
        const next = execOutcomes.shift();
        return Promise.resolve(
          next ?? {
            executed: false,
            planned: true,
            stepId: `step-fallback-${scopeSeq}`,
            message: "recorded for confirmation; not executed yet",
          },
        );
      }
      case "ai_scope_run_step":
        return Promise.resolve({
          executed: true,
          stepId: (args?.stepId as string) ?? "step-1",
          exitCode: 0,
          stdout: "hello from host",
          stderr: "",
          truncated: false,
          timedOut: false,
          message: "executed",
        });
      case "ai_scope_upgrade_step":
        return Promise.resolve({
          stepId: "upgraded-1",
          actionId: (args?.actionId as string) ?? "",
          mode: "manual",
          message: "upgraded to manual mode",
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

function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, name, arguments: args };
}

/** 每轮 run 的首轮都发起**同一条**执行类调用（续跑轮给最终回答）。 */
function sameCommandScript(command = "ls -la"): (turn: number) => ChatDelta[] {
  return (turn) =>
    turn % 2 === 0
      ? [
          {
            text: "",
            toolCalls: [toolCall(`call_${turn}`, "ottr_exec_command", JSON.stringify({ command }))],
          },
        ]
      : [{ text: "已收悉" }];
}

/** 规划档登记的回包（只登记、零执行）。 */
const PLAN_OUTCOME = {
  executed: false,
  planned: true,
  stepId: "step-plan",
  message: "recorded in the plan; not executed (plan mode)",
  result: null,
  downgradeReason: null,
};

/** 自动档当场执行的回包。 */
const AUTO_EXECUTED_OUTCOME = {
  executed: true,
  planned: false,
  stepId: "step-auto",
  message: "auto mode executed the command (read-only command ls)",
  result: {
    executed: true,
    stepId: "step-auto",
    exitCode: 0,
    stdout: "total 8\ndrwxr-xr-x 2 root root",
    stderr: "",
    truncated: false,
    timedOut: false,
    message: "command completed successfully (exit code 0)",
  },
  downgradeReason: null,
};

/** 自动档降级为逐条确认的回包（后端已按 manual 档登记）。 */
const AUTO_DOWNGRADED_OUTCOME = {
  executed: false,
  planned: true,
  stepId: "step-downgraded",
  message: "auto mode downgraded this command to manual confirmation — it has NOT been executed",
  result: null,
  downgradeReason: 'interpreter/privileged command "sh": downgraded to confirmation',
};

beforeEach(async () => {
  turnIndex = 0;
  script = () => [{ text: "最终回答" }];
  execOutcomes = [];
  scopeSeq = 0;
  mockedInvoke.mockReset();
  useAiStore.getState().close?.("pane-a");
  useAiStore.setState({ sessions: {} });
  mockBackend();
  seedLivePanes();
  resetRateLimiter();
  setNotifyPorts({ now: () => 0, focused: () => false, system: async () => {} });
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

describe("store 层：规划档登记过的命令，自动档再跑同一条", () => {
  it("清单里那一条显示「已自动执行」（不是旧的「待执行」）", async () => {
    execOutcomes.push(PLAN_OUTCOME, AUTO_EXECUTED_OUTCOME);
    script = sameCommandScript();

    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "看看目录");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // 规划档登记的那一条：待执行
    expect(slice()?.plan).toHaveLength(1);
    expect(slice()?.plan?.[0].status).toBe("planned");
    const planScope = calls("ai_scope_exec")[0]?.[1]?.scopeId as string;

    // 切到自动档，同一条命令再跑一次（后端当场执行）
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "再跑一次");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));

    // ★ 自动跑过的事实不被旧的「待执行」盖住
    const plan = slice()?.plan ?? [];
    expect(plan).toHaveLength(1);
    expect(plan[0].status).toBe("done");
    expect(plan[0].result?.stdout).toContain("total 8");
    // 登记事实 = 当前那一轮的 scope（旧 scope 可能已被撤销，不能沿用）
    const autoScope = calls("ai_scope_exec")[1]?.[1]?.scopeId as string;
    expect(autoScope).not.toBe(planScope);
    expect(plan[0].scopeId).toBe(autoScope);
    // 这一行改指当前那次登记（后端登记簿里那条 = 自动档那条）
    expect(plan[0].id).toBe("step-auto");
  });
});

describe("store 层：规划档登记过的命令，自动档降级同一条", () => {
  it("那一条仍是待确认卡（登记档位 = manual）→ 点「执行」直接跑", async () => {
    execOutcomes.push(PLAN_OUTCOME, AUTO_DOWNGRADED_OUTCOME);
    script = sameCommandScript("sh -c ls");

    useAiStore.getState().openAsk(ASK_A);
    useAiStore.getState().setMode("pane-a", "plan");
    await useAiStore.getState().run("pane-a", "看看目录");
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    expect(slice()?.plan).toHaveLength(1);
    expect(slice()?.plan?.[0].status).toBe("planned");

    // 自动档：后端把这条降级为逐条确认（并已按 manual 档登记）
    useAiStore.getState().setMode("pane-a", "auto");
    await useAiStore.getState().run("pane-a", "再跑一次");
    await vi.waitFor(() => expect(slice()?.status).toBe("awaiting_tool_approval"));

    // ★ 合并后那一条的登记档位是 manual（不是旧条目的 plan）→ 自动档下
    //   给执行入口（否则降级成了死路）
    const plan = slice()?.plan ?? [];
    expect(plan).toHaveLength(1);
    expect(plan[0].status).toBe("planned");
    expect(plan[0].registeredMode).toBe("manual");
    const autoScope = calls("ai_scope_exec")[1]?.[1]?.scopeId as string;
    expect(plan[0].scopeId).toBe(autoScope);
    // 行标识沿用首次登记的那条；后端登记簿里那条 = 自动档降级登记的那条
    // （两者成对：stepId 与 actionId 同源）。
    expect(plan[0].id).toBe("step-plan");
    expect(plan[0].backendStepId).toBe("step-downgraded");

    // 点「执行」→ 走 run_step（不再升档）→ 步骤 done
    await useAiStore.getState().resolvePlanStep("pane-a", plan[0].id, true);
    await vi.waitFor(() => expect(slice()?.status).toBe("done"));
    const runCalls = calls("ai_scope_run_step");
    expect(runCalls).toHaveLength(1);
    expect(calls("ai_scope_upgrade_step")).toHaveLength(0);
    // 执行的正是当前那一轮登记的那条（scope / stepId / actionId 配套）
    expect(runCalls[0]?.[1]).toMatchObject({
      scopeId: autoScope,
      stepId: "step-downgraded",
      actionId: plan[0].actionId,
    });
    expect(slice()?.plan?.[0].status).toBe("done");
  });
});
