// Ask Ottr 执行模式（第一步：Plan）面板层测试：
//   * 状态行的模式切换（SegmentedControl：role=group + aria-pressed + roving
//     tabindex——**不裸写 checkbox**，全仓守卫 ui-no-native-controls.test.ts）；
//   * auto 档的「尚未启用」提示（本步不假装能用）；
//   * 计划清单渲染：命令 + 危险徽章 + 状态点。
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
    status: "done",
    answer: "",
    errorKind: null,
    error: null,
    redactions: [],
    settingsUsed: null,
    seen: false,
    usage: null,
    modelUsed: null,
    elapsedMs: null,
    conversationId: "conv-1",
    target: null,
    scope: null,
    runId: null,
    draft: "",
    conversationReadonly: false,
    messages: [],
    pendingToolCalls: [],
    toolRounds: 0,
    runningToolCallId: null,
    ...over,
  };
  useAiStore.setState({ sessions: { "pane-a": slice } });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useAiStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useAiStore.setState({ sessions: {} });
});

describe("状态行的模式切换", () => {
  it("渲染三档（plan / auto / manual），当前档 aria-pressed", () => {
    seed({ mode: "plan" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const group = screen.getByTestId("ai-mode-switch");
    expect(group.getAttribute("role")).toBe("group");
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["规划", "自动", "手动"]);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("缺省（字段未设）按 plan 显示", () => {
    seed();
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const buttons = Array.from(
      screen.getByTestId("ai-mode-switch").querySelectorAll("button"),
    );
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("点「手动」→ setMode(sessionId, manual)", () => {
    const setModeSpy = vi.fn();
    useAiStore.setState({ setMode: setModeSpy });
    seed({ mode: "plan" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const buttons = Array.from(
      screen.getByTestId("ai-mode-switch").querySelectorAll("button"),
    );
    fireEvent.click(buttons[2]);
    expect(setModeSpy).toHaveBeenCalledWith("pane-a", "manual");
  });

  it("auto 档显示「尚未启用」提示（不假装能用）", () => {
    seed({ mode: "auto" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-mode-auto-hint").textContent).toContain("尚未启用");
  });

  it("plan / manual 档不显示该提示", () => {
    seed({ mode: "manual" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-mode-auto-hint")).toBeNull();
  });
});

describe("计划清单渲染", () => {
  it("每行 = 命令 + 危险徽章 + 状态点", () => {
    seed({
      mode: "plan",
      plan: [
        { id: "step-1", command: "rm -rf /tmp/build", danger: "red", status: "planned" },
        { id: "step-2", command: "df -h", danger: "green", status: "planned" },
      ],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-plan")).toBeTruthy();
    expect(screen.getByTestId("ai-plan-cmd-step-1").textContent).toBe("rm -rf /tmp/build");
    // 危险徽章复用 ai.level* 词典（危险 / 安全）
    expect(screen.getByTestId("ai-plan-level-step-1").textContent).toBe("危险");
    expect(screen.getByTestId("ai-plan-level-step-2").textContent).toBe("安全");
    // 状态点 + 状态文案
    expect(screen.getByTestId("ai-plan-dot-step-1").getAttribute("data-status")).toBe("planned");
    expect(screen.getByTestId("ai-plan-status-step-1").textContent).toBe("待执行");
  });

  it("没有计划步骤时不渲染清单块", () => {
    seed({ mode: "plan", plan: [] });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-plan")).toBeNull();
  });

  it("主机工具轮用主机工具标签（不渲染成半截的「调用 .ottr_xxx」）", () => {
    seed({
      status: "done",
      messages: [
        {
          role: "tool",
          content: "已记入计划，暂不执行",
          toolCallId: "call_1",
          toolName: "ottr_exec_command",
        },
      ],
    });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const label = screen.getByTestId("ai-msg-tool-call").textContent ?? "";
    expect(label).toContain("ottr_exec_command");
    expect(label).not.toContain(".ottr_exec_command");
  });
});
