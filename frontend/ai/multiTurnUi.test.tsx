// 诊断面板多轮 UI + Markdown 渲染测试（2026-11-02 批次二 C 项）。
//
// 钉住：
// 1. 气泡流按角色渲染（user / assistant）；
// 2. 底部追问输入条：textarea——Enter 提交 → run(sessionId, 文本)；
//    Shift+Enter 换行不提交；IME 组字中的 Enter 不提交；
// 3. Markdown：**原始 HTML 不被渲染成 DOM**（不引入 rehype-raw 的安全取舍），
//    但强调/列表正常渲染。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import "../i18n";
import i18n from "../i18n";
import { DiagnosePanel } from "./DiagnosePanel";
import { useAiStore } from "./aiStore";
import type { DiagnoseRequest } from "./aiStore";

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 1,
  hostName: "web-01",
  exitCode: 1,
  command: "$ df -h",
};

function seed(over: Record<string, unknown> = {}) {
  useAiStore.setState({
    sessions: {
      "tab-1": {
        request: REQ,
        status: "done",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
        settingsUsed: null,
        seen: true,
        usage: null,
        modelUsed: null,
        elapsedMs: null,
        messages: [
          // 首轮 user 轮 = 装配后的诊断上下文（退出码 + 命令 + 输出尾 + 备注）
          // ——真实形态，不是「用户的一句话」。
          {
            role: "user",
            content:
              "Exit code: 1\nCommand:\ndf -h\nOutput tail:\n```\n/dev/sda1 92%\n```",
          },
          { role: "assistant", content: "**原因**\n\n磁盘满了。" },
          { role: "user", content: "磁盘满了怎么办" },
          { role: "assistant", content: "**原因**\n\n磁盘满了。" },
        ],
        conversationId: "",
        target: null,
        scope: null,
        runId: null,
        draft: "",
        conversationReadonly: false,
        ...over,
      },
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useAiStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  useAiStore.setState({ sessions: {} });
  void i18n.changeLanguage("en-US");
});

describe("诊断面板多轮 UI", () => {
  it("气泡流按角色渲染 user / assistant", () => {
    seed();
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    // 追问轮的用户诉求照常进气泡流
    expect(screen.getAllByTestId("ai-msg-user")[0].textContent).toContain("磁盘满了怎么办");
    expect(screen.getAllByTestId("ai-msg-assistant")[0].textContent).toContain("原因");
  });

  it("首轮诊断上下文不进气泡流（不拿 8KB 原始终端输出淹面板）", () => {
    seed();
    const { container } = render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    // 首轮 user 轮（诊断上下文）不渲染成气泡
    expect(container.textContent).not.toContain("Output tail");
    expect(container.textContent).not.toContain("/dev/sda1 92%");
  });

  it("Markdown 强调被渲染成粗体（不再是字面星号）", () => {
    seed();
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const md = screen.getAllByTestId("ai-md")[0];
    expect(md.querySelector("strong")).toBeTruthy();
    expect(md.textContent).not.toContain("**原因**");
  });

  it("Markdown：原始 HTML 不被渲染成 DOM（安全取舍）", () => {
    seed({
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: '试试 <img src=x onerror="alert(1)"> 与 <b>粗体</b>',
        },
      ],
    });
    const { container } = render(
      <DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />,
    );
    // 不引入 rehype-raw → 原始 HTML 节点不进 DOM
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("追问输入条：Enter 提交 → run(sessionId, 文本)", () => {
    seed();
    const runSpy = vi.spyOn(useAiStore.getState(), "run").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "不对，请用 truncate" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runSpy).toHaveBeenCalledWith("tab-1", "不对，请用 truncate");
  });

  it("首个流式片段到达前允许输入，但不接受打断发送（发送钮短暂禁用）", () => {
    seed({
      status: "running",
      runId: "run-preparing",
      streamStartedRunId: null,
      draft: "补充问题",
    });
    const interruptSpy = vi.spyOn(useAiStore.getState(), "interrupt").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect((screen.getByTestId("ai-followup-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(input.value).toBe("补充问题");
  });

  it("运行中 Enter 打断时携带渲染快照的 runId", () => {
    seed({ status: "running", runId: "run-current", streamStartedRunId: "run-current" });
    const interruptSpy = vi.spyOn(useAiStore.getState(), "interrupt").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "先别删" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(interruptSpy).toHaveBeenCalledWith("tab-1", "先别删", "run-current");
  });

  it("运行中点「发送」即打断并插话（按钮文案恒为发送，2026-11-07 用户反馈）", () => {
    seed({
      status: "running",
      runId: "run-current",
      streamStartedRunId: "run-current",
      draft: "先别删",
    });
    const interruptSpy = vi.spyOn(useAiStore.getState(), "interrupt").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const send = screen.getByTestId("ai-followup-send") as HTMLButtonElement;
    expect(send.textContent).toBe("发送");
    fireEvent.click(send);
    expect(interruptSpy).toHaveBeenCalledWith("tab-1", "先别删", "run-current");
  });

  it("追问输入条是 textarea（多行可写：Shift+Enter 换行）", () => {
    seed();
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-followup-input").tagName).toBe("TEXTAREA");
  });

  it("追问输入条：Shift+Enter 不提交（换行，不发请求）", () => {
    seed();
    const runSpy = vi.spyOn(useAiStore.getState(), "run").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(runSpy).not.toHaveBeenCalled();
    // 内容不丢（换行留在框里）
    expect(input.value).toBe("第一行");
  });

  it("追问输入条：IME 组字中的 Enter 不提交（候选词上屏 ≠ 发送）", () => {
    seed();
    const runSpy = vi.spyOn(useAiStore.getState(), "run").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("追问输入条：空文本不提交", () => {
    seed();
    const runSpy = vi.spyOn(useAiStore.getState(), "run").mockResolvedValue(undefined);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const input = screen.getByTestId("ai-followup-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("运行中：输入可用、按钮恒为「发送」（2026-11-07 用户反馈：不再变「打断并插入」）", () => {
    seed({
      status: "running",
      streamStartedRunId: "run-live",
      runId: "run-live",
      draft: "先看看",
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect((screen.getByTestId("ai-followup-input") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId("ai-followup-stop")).toBeNull();
    expect(screen.queryByTestId("ai-followup-interrupt")).toBeNull();
    const send = screen.getByTestId("ai-followup-send") as HTMLButtonElement;
    expect(send.textContent).toBe("发送");
    expect(send.disabled).toBe(false);
  });

  it("运行中草稿为空 → 发送钮禁用（有内容才能点）", () => {
    seed({
      status: "running",
      runId: "run-current",
      streamStartedRunId: "run-current",
      draft: "",
    });
    const { unmount } = render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const btn = screen.getByTestId("ai-followup-send") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // 有草稿即可点。
    unmount();
    seed({
      status: "running",
      runId: "run-current",
      streamStartedRunId: "run-current",
      draft: "先停一下",
    });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(
      (screen.getByTestId("ai-followup-send") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("挂起外部工具确认 → 输入仍禁用（打断会丢待处置的 tool call，协议缺消息 400）", () => {
    seed({ status: "awaiting_tool_approval", pendingToolCalls: [
      { id: "call-1", name: "srv.tool", args: "{}", serverId: "s1", serverName: "s1", toolName: "tool" },
    ] });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect((screen.getByTestId("ai-followup-input") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("内建主机工具执行中仍禁用输入（避免截断未完成的 tool 轮）", () => {
    seed({ status: "running", runningHostToolCallId: "call-exec" });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect((screen.getByTestId("ai-followup-input") as HTMLTextAreaElement).disabled).toBe(true);
  });
});

// 2026-11-08 审计 A2 回归：Ask 首轮气泡只显示用户的问题。
describe("Ask 轮气泡（2026-11-08 审计 A2）", () => {
  const ASK_REQ = {
    kind: "ask",
    sessionId: "tab-1",
    rustId: "pty-9",
    hostId: 1,
    hostName: "web-01",
  } as const;

  function seedAsk(messages: unknown[]) {
    seed({
      request: ASK_REQ,
      messages,
    } as Record<string, unknown>);
  }

  it("Ask 首轮 content = 问题 + 输出尾 + 备注（装配面），气泡只显示原问题（retryContent）", () => {
    seedAsk([
      {
        role: "user",
        // 真实装配形态：问题在前，输出尾 + 主机备注在后（给模型的 prompt）
        content: "还剩多少内存？\n\nOutput tail:\n```\n8KB 的终端输出尾……\n```\n\n主机备注……",
        retryContent: "还剩多少内存？",
      },
      { role: "assistant", content: "还有 4GB。" },
    ]);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const bubble = screen.getAllByTestId("ai-msg-user")[0];
    expect(bubble.textContent).toContain("还剩多少内存？");
    // 装配面（输出尾/备注）不进气泡——正是 8KB 输出淹面板的那条路径
    expect(bubble.textContent).not.toContain("Output tail");
    expect(bubble.textContent).not.toContain("8KB 的终端输出尾");
  });

  it("Ask 追问轮（retryContent == content）照常显示；诊断首轮维持整体隐藏", () => {
    // 追问轮：retryContent 与 content 同值（纯问题），显示不受影响
    seedAsk([
      { role: "user", content: "还剩多少内存？", retryContent: "还剩多少内存？" },
      { role: "assistant", content: "还有 4GB。" },
      { role: "user", content: "swap 呢？", retryContent: "swap 呢？" },
      { role: "assistant", content: "swap 2GB。" },
    ]);
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    const users = screen.getAllByTestId("ai-msg-user");
    expect(users).toHaveLength(2);
    expect(users[1].textContent).toBe("swap 呢？");

    // 诊断首轮（无 retryContent 概念）维持既有行为：整轮不进气泡
    seed();
    const { container } = render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect(container.textContent).not.toContain("/dev/sda1 92%");
  });
});
