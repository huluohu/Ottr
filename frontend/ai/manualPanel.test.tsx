// Ask Ottr 执行模式（第二步：Manual 档）面板层测试：
//   * manual 档：计划步骤渲染成**待确认卡**（命令原文 + 危险徽章 + 状态点 +
//     执行/拒绝两钮）；plan 档：同一条步骤只是清单，**没有执行钮**；
//   * 执行中：钮置灰 + 状态 executing；已执行/已拒绝：不再给入口；
//   * 点「执行」/「拒绝」分别走 resolvePlanStep(true/false)；
//   * 执行结果就地展示（退出码 + 输出）；
//   * 模式切换 plan ↔ manual：步骤不丢（只是形态变）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import i18n from "../i18n";
import { useAiStore, type AskRequest, type SessionAiState } from "./aiStore";
import { DiagnosePanel } from "./DiagnosePanel";

const REQ: AskRequest = {
  kind: "ask",
  sessionId: "pane-a",
  rustId: "pty-a",
  hostId: 7,
  hostName: "web-01",
};

/** 播种会话切片（模式 + 计划清单相关字段）。 */
function seed(over: Partial<SessionAiState> = {}): void {
  const slice: SessionAiState = {
    request: REQ,
    status: "awaiting_tool_approval",
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
    pendingToolCalls: [],
    toolRounds: 0,
    runningToolCallId: null,
    conversationId: "conv-1",
    target: null,
    scope: null,
    runId: null,
    draft: "",
    conversationReadonly: false,
    mode: "manual",
    plan: [],
    ...over,
  };
  useAiStore.setState({ sessions: { "pane-a": slice } });
}

/** 一条待确认的计划步骤（manual 档登记面）。 */
const PENDING_STEP = {
  id: "step-1",
  command: "rm -rf /tmp/build",
  danger: "red" as const,
  status: "planned" as const,
  scopeId: "scope-pane-a",
  actionId: "run-1:exec:call_1",
  toolCallIds: ["call_1"],
};

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useAiStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useAiStore.setState({ sessions: {} });
});

describe("manual 档：待确认卡", () => {
  it("渲染命令原文 + 危险徽章 + 状态点 + 执行/拒绝两钮", () => {
    seed({ plan: [PENDING_STEP] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan")).toBeTruthy();
    expect(screen.getByTestId("ai-plan-cmd-step-1").textContent).toBe("rm -rf /tmp/build");
    expect(screen.getByTestId("ai-plan-level-step-1").textContent).toBe("危险");
    expect(screen.getByTestId("ai-plan-dot-step-1").getAttribute("data-status")).toBe("planned");
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("待执行");
    // 两钮：执行（主钮）/ 拒绝（次钮）
    const run = screen.getByTestId("ai-plan-run-step-1") as HTMLButtonElement;
    const reject = screen.getByTestId("ai-plan-reject-step-1") as HTMLButtonElement;
    expect(run.textContent).toBe("执行");
    expect(reject.textContent).toBe("拒绝");
    expect(run.disabled).toBe(false);
    expect(reject.disabled).toBe(false);
  });

  it("状态点对读屏隐藏（装饰元素），命令与状态有文本", () => {
    seed({ plan: [PENDING_STEP] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-dot-step-1").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).not.toBe("");
  });

  it("点「执行」→ resolvePlanStep(sessionId, stepId, true)；点「拒绝」→ false", () => {
    const resolveSpy = vi.fn().mockResolvedValue(undefined);
    useAiStore.setState({ resolvePlanStep: resolveSpy });
    seed({ plan: [PENDING_STEP] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("ai-plan-run-step-1"));
    expect(resolveSpy).toHaveBeenCalledWith("pane-a", "step-1", true);
    fireEvent.click(screen.getByTestId("ai-plan-reject-step-1"));
    expect(resolveSpy).toHaveBeenCalledWith("pane-a", "step-1", false);
  });

  it("执行中：钮置灰 + 状态 executing + 钮文案变「执行中…」", () => {
    seed({ plan: [{ ...PENDING_STEP, status: "executing" }] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const run = screen.getByTestId("ai-plan-run-step-1") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.textContent).toContain("执行中");
    expect((screen.getByTestId("ai-plan-reject-step-1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("执行中");
    expect(screen.getByTestId("ai-plan-dot-step-1").getAttribute("data-status")).toBe("executing");
  });

  it("已执行 / 已拒绝：不再给执行入口（不可重复执行）", () => {
    seed({ plan: [{ ...PENDING_STEP, status: "done" }] });
    const { unmount } = render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("已完成");
    unmount();
    seed({ plan: [{ ...PENDING_STEP, status: "rejected" }] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("已拒绝");
  });

  it("执行结果就地展示（退出码 + 输出）", () => {
    seed({
      plan: [
        {
          ...PENDING_STEP,
          status: "done",
          result: { exitCode: 0, stdout: "removed 12 items", stderr: "", truncated: false },
        },
      ],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-result-step-1").textContent).toContain("退出码 0");
    expect(screen.getByTestId("ai-plan-output-step-1").textContent).toContain("removed 12 items");
    // 结果区是可播报的状态区（读屏能知道「执行完了」）
    expect(screen.getByTestId("ai-plan-result-step-1").getAttribute("role")).toBe("status");
  });

  it("超时结果单独标出「超时」（不靠「退出码 -」让人猜）", () => {
    // 真机取证发现（2026-11-04）：超时与「服务端没回退出码」在退出码上
    // 都是「-」——用户分不出「命令被中止」与「跑完了没退出码」。
    seed({
      plan: [
        {
          ...PENDING_STEP,
          status: "failed",
          result: {
            exitCode: null,
            stdout: "partial",
            stderr: "",
            truncated: false,
            timedOut: true,
          },
        },
      ],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-timeout-step-1").textContent).toContain("超时");
  });

  it("失败结果展示错误原因", () => {
    seed({
      plan: [
        {
          ...PENDING_STEP,
          status: "failed",
          result: { exitCode: null, stdout: "", stderr: "", truncated: false, error: "scope revoked" },
        },
      ],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("失败");
    expect(screen.getByTestId("ai-plan-error-step-1").textContent).toContain("scope revoked");
  });
});

describe("plan 档：不提供执行入口", () => {
  it("plan 档：步骤仍是清单，没有执行/拒绝钮", () => {
    seed({ mode: "plan", plan: [PENDING_STEP] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-cmd-step-1").textContent).toBe("rm -rf /tmp/build");
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();
    expect(screen.queryByTestId("ai-plan-reject-step-1")).toBeNull();
  });

  it("plan 档下有待确认的命令 → 提示切到手动档", () => {
    seed({ mode: "plan", plan: [PENDING_STEP] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-mode-hint").textContent).toContain("手动");
  });

  it("plan 档登记的步骤（无执行钮）也提示切到手动档（出路可见）", () => {
    // plan 档登记的步骤在手动档点「执行」时会先由后端升档再执行——所以 plan
    // 档下要把这条出路说清楚，而不是让用户以为卡死了。
    seed({
      mode: "plan",
      plan: [{ ...PENDING_STEP, registeredMode: "plan", toolCallIds: undefined }],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();
    expect(screen.getByTestId("ai-plan-mode-hint").textContent).toContain("手动");
  });
});

describe("模式切换：步骤不丢", () => {
  it("plan → manual：同一条步骤从清单变成待确认卡", () => {
    seed({ mode: "plan", plan: [PENDING_STEP] });
    const { rerender } = render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();

    // 切到 manual（store 侧改档 + 重渲染）
    useAiStore.setState((st) => ({
      sessions: { ...st.sessions, "pane-a": { ...st.sessions["pane-a"], mode: "manual" } },
    }));
    rerender(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-cmd-step-1").textContent).toBe("rm -rf /tmp/build");
    expect(screen.getByTestId("ai-plan-run-step-1")).toBeTruthy();

    // 切回 plan → 收回清单（步骤仍在）
    useAiStore.setState((st) => ({
      sessions: { ...st.sessions, "pane-a": { ...st.sessions["pane-a"], mode: "plan" } },
    }));
    rerender(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan-cmd-step-1").textContent).toBe("rm -rf /tmp/build");
    expect(screen.queryByTestId("ai-plan-run-step-1")).toBeNull();
  });
});
