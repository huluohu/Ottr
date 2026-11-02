// 诊断面板多轮 UI + Markdown 渲染测试（2026-11-02 批次二 C 项）。
//
// 钉住：
// 1. 气泡流按角色渲染（user / assistant）；
// 2. 底部追问输入条：Enter 提交 → run(sessionId, 文本)；
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
    const input = screen.getByTestId("ai-followup-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "不对，请用 truncate" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runSpy).toHaveBeenCalledWith("tab-1", "不对，请用 truncate");
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

  it("运行中：追问输入禁用、显示停止钮", () => {
    seed({ status: "running" });
    render(<DiagnosePanel sessionId="tab-1" onOpenSettings={() => {}} />);
    expect((screen.getByTestId("ai-followup-input") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("ai-followup-stop")).toBeTruthy();
  });
});
