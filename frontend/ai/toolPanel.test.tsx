// AI 面板的工具调用呈现测试（批次五 P2）：
//   * 待确认卡片：服务器名 + 工具名 + 参数 + 执行/拒绝两钮；
//   * 两个按钮分别走「执行 / 拒绝」分支（**AI 不自动执行**——没有自动开关）；
//   * 执行中：按钮置灰 + 显示「执行中…」；
//   * 工具结果作为一轮显示在气泡流里（user 侧「调用 <server>.<tool>」，
//     assistant 侧工具返回文本，长文本在面板里截断）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import i18n from "../i18n";
import { useAiStore, type DiagnoseRequest, type SessionAiState } from "./aiStore";
import { DiagnosePanel, truncateToolResult } from "./DiagnosePanel";

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 1,
  hostName: "web-01",
  exitCode: 1,
  command: "$ cat /etc/hosts",
};

/** 播种会话切片（工具轮次相关字段）。 */
function seed(over: Partial<SessionAiState> = {}) {
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
    ...over,
  };
  useAiStore.setState({ sessions: { "tab-1": slice } });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useAiStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useAiStore.setState({ sessions: {} });
});

describe("待确认工具调用卡片", () => {
  it("渲染服务器名 + 工具名 + 参数 + 执行/拒绝两钮", () => {
    seed({
      pendingToolCalls: [
        {
          id: "call_1",
          serverId: "srv-1",
          serverName: "files",
          tool: "read_file",
          args: '{"path":"/etc/hosts"}',
        },
      ],
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-tool-card-call_1")).toBeTruthy();
    expect(screen.getByTestId("ai-tool-server-call_1").textContent).toBe("files");
    expect(screen.getByTestId("ai-tool-name-call_1").textContent).toBe("read_file");
    expect(screen.getByTestId("ai-tool-args-call_1").textContent).toContain("/etc/hosts");
    expect(screen.getByTestId("ai-tool-approve-call_1")).toBeTruthy();
    expect(screen.getByTestId("ai-tool-reject-call_1")).toBeTruthy();
    // 有待确认项时追问输入禁用（用户得先处置工具调用）
    expect((screen.getByTestId("ai-followup-input") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("点「执行」→ resolveToolCall(id, true)；点「拒绝」→ resolveToolCall(id, false)", () => {
    const resolveSpy = vi.fn().mockResolvedValue(undefined);
    useAiStore.setState({ resolveToolCall: resolveSpy });
    seed({
      pendingToolCalls: [
        { id: "call_1", serverId: "srv-1", serverName: "files", tool: "read_file", args: "{}" },
      ],
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("ai-tool-approve-call_1"));
    expect(resolveSpy).toHaveBeenCalledWith("tab-1", "call_1", true);
    fireEvent.click(screen.getByTestId("ai-tool-reject-call_1"));
    expect(resolveSpy).toHaveBeenCalledWith("tab-1", "call_1", false);
  });

  it("执行中：按钮置灰且显示「执行中…」", () => {
    seed({
      runningToolCallId: "call_1",
      pendingToolCalls: [
        { id: "call_1", serverId: "srv-1", serverName: "files", tool: "read_file", args: "{}" },
      ],
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const approve = screen.getByTestId("ai-tool-approve-call_1") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain("执行中");
    expect((screen.getByTestId("ai-tool-reject-call_1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("没有待确认项时不渲染卡片", () => {
    seed({ status: "done" });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-tool-pending")).toBeNull();
  });
});

describe("工具结果在气泡流里的呈现", () => {
  it("user 侧显示「调用 <server>.<tool>」，assistant 侧显示工具返回文本", () => {
    seed({
      status: "done",
      messages: [
        { role: "user", content: "诊断上下文" },
        {
          role: "assistant",
          content: "我需要读文件",
          toolCalls: [{ id: "call_1", name: "mcp__srv-1__read_file", arguments: "{}" }],
        },
        {
          role: "tool",
          content: "127.0.0.1 localhost",
          toolCallId: "call_1",
          toolName: "read_file",
          serverName: "files",
        },
      ],
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-msg-tool-call").textContent).toContain("调用");
    expect(screen.getByTestId("ai-msg-tool-call").textContent).toContain("files.read_file");
    expect(screen.getByTestId("ai-tool-result-text").textContent).toContain("127.0.0.1 localhost");
  });

  it("超长工具返回在面板里截断显示（发给模型的完整文本不受影响）", () => {
    const long = "x".repeat(5000);
    seed({
      status: "done",
      messages: [
        {
          role: "tool",
          content: long,
          toolCallId: "call_1",
          toolName: "read_file",
          serverName: "files",
        },
      ],
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const text = screen.getByTestId("ai-tool-result-text").textContent ?? "";
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("已截断");
  });

  it("truncateToolResult：未超限原样返回", () => {
    expect(truncateToolResult("短文本")).toBe("短文本");
  });
});
