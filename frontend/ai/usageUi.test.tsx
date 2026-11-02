// 用量透明化的 **UI 面**测试（2026-11-02 批次一 B 项）。
//
// 三条钉死的行为：
// 1. done 态显示「模型 · token · 耗时」信息条；
// 2. 端点不给 usage → **不显示 token 数**，但模型与耗时照常（降级不空白）；
// 3. 面板仍在跑（running）时不显示该条（避免半截数据误导）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAiStore } from "./aiStore";
import { useNlStore } from "./nl2cmd";
import { DiagnosePanel } from "./DiagnosePanel";
import { NLCommandPanel } from "./NLCommandPanel";

vi.mock("../terminal/terminalFocus", () => ({
  useTerminalFocus: { getState: () => ({ request: vi.fn() }) },
}));

beforeEach(() => {
  cleanup();
  useAiStore.setState({ sessions: {} });
});

describe("诊断面板用量行", () => {
  it("done 态显示模型 · token · 耗时", () => {
    useAiStore.setState({
      sessions: {
        "tab-1": {
          request: {
            kind: "diagnose",
            sessionId: "tab-1",
            rustId: "pty-9",
            hostId: 1,
            hostName: "web-01",
            exitCode: 1,
            command: "df -h",
          },
          status: "done",
          answer: "因为磁盘满了",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: true,
          usage: { inputTokens: 120, outputTokens: 45 },
          modelUsed: "deepseek-chat",
          elapsedMs: 1234,
          messages: [],
        },
      },
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const row = screen.getByTestId("ai-usage");
    expect(row.textContent).toContain("deepseek-chat");
    expect(screen.getByTestId("ai-usage-tokens").textContent).toContain("120");
    expect(screen.getByTestId("ai-usage-tokens").textContent).toContain("45");
    expect(screen.getByTestId("ai-usage-elapsed").textContent).toContain("1234");
  });

  it("端点不给 usage → 不显示 token 数，但模型与耗时照常（降级）", () => {
    useAiStore.setState({
      sessions: {
        "tab-1": {
          request: {
            kind: "diagnose",
            sessionId: "tab-1",
            rustId: "pty-9",
            hostId: 1,
            hostName: "web-01",
            exitCode: 1,
            command: "df -h",
          },
          status: "done",
          answer: "因为磁盘满了",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: true,
          usage: null,
          modelUsed: "local-model",
          elapsedMs: 800,
          messages: [],
        },
      },
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-usage-tokens")).toBeNull();
    expect(screen.getByTestId("ai-usage").textContent).toContain("local-model");
    expect(screen.getByTestId("ai-usage-elapsed").textContent).toContain("800");
  });

  it("running 态不显示用量行（半截数据误导）", () => {
    useAiStore.setState({
      sessions: {
        "tab-1": {
          request: {
            kind: "diagnose",
            sessionId: "tab-1",
            rustId: "pty-9",
            hostId: 1,
            hostName: "web-01",
            exitCode: 1,
            command: "df -h",
          },
          status: "running",
          answer: "因为",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: false,
          usage: { inputTokens: 10, outputTokens: 2 },
          modelUsed: "m",
          elapsedMs: null,
          messages: [],
        },
      },
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.queryByTestId("ai-usage")).toBeNull();
  });
});

describe("⌘J 面板用量行", () => {
  it("done 态显示 token 与耗时", () => {
    useNlStore.setState({
      status: "done",
      answer: "df -h",
      command: "df -h",
      level: "green",
      errorKind: null,
      error: null,
      input: "",
      settingsUsed: null,
      cwd: null,
      hostId: null,
      rounds: [],
      usage: { inputTokens: 30, outputTokens: 9 },
      modelUsed: "glm-4-flash",
      elapsedMs: 420,
    });
    render(<NLCommandPanel open onClose={() => {}} onOpenSettings={() => {}} />);
    const row = screen.getByTestId("nl2cmd-usage");
    expect(row.textContent).toContain("glm-4-flash");
    expect(screen.getByTestId("nl2cmd-usage-tokens").textContent).toContain("30");
    expect(screen.getByTestId("nl2cmd-usage-elapsed").textContent).toContain("420");
  });
});
