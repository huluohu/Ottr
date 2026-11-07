// Ask Ottr 执行模式（第一步：Plan）面板层测试：
//   * 状态行的模式切换（SegmentedControl：role=group + aria-pressed + roving
//     tabindex——**不裸写 checkbox**，全仓守卫 ui-no-native-controls.test.ts）；
//   * auto 档的「尚未启用」提示（本步不假装能用）；
//   * 计划清单渲染：命令 + 危险徽章 + 状态点。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("执行方式下拉（2026-11-07 用户反馈：tabs 改选择框，不让用户切模式才能操作）", () => {
  it("下拉两档（逐条确认 / 自动执行），当前值即会话档位", () => {
    seed({ mode: "manual" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    const select = screen.getByTestId("ai-mode-switch") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.map((o) => o.value)).toEqual(["manual", "auto"]);
    expect(options.map((o) => o.textContent)).toEqual(["逐条确认", "自动执行"]);
    expect(select.value).toBe("manual");
    // 「规划」档不再出现在面板（确认卡本身就是计划）。
    expect(options.some((o) => o.value === "plan")).toBe(false);
  });

  it("切到「自动执行」→ setMode(sessionId, auto)", () => {
    const setModeSpy = vi.fn();
    useAiStore.setState({ setMode: setModeSpy });
    seed({ mode: "manual" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    fireEvent.change(screen.getByTestId("ai-mode-switch"), { target: { value: "auto" } });
    expect(setModeSpy).toHaveBeenCalledWith("pane-a", "auto");
  });

  it("auto 档且该主机未授权 → 提示未授权（不假装能自动跑）", async () => {
    // 第三步：自动档的前提是主机被授权（授权表默认全拒）——未授权时要说清。
    seed({ mode: "auto" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-mode-auto-hint").textContent).toContain("未授权"),
    );
  });

  it("未授权主机上逐条确认档也提示（下拉里「自动执行」置灰，原因必须常显）", async () => {
    // 2026-11-07 档位改下拉：自动执行选项常驻可见，未授权时置灰——原因不能
    // 只在选中后才出现（旧段控懒查询的坑）。授权查询失败/拒绝 → 视为未授权。
    seed({ mode: "manual" });
    render(<DiagnosePanel sessionId="pane-a" onOpenSettings={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("ai-mode-auto-hint").textContent).toContain("未授权"),
    );
    expect((screen.getByTestId("ai-mode-switch") as HTMLSelectElement).value).toBe("manual");
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
