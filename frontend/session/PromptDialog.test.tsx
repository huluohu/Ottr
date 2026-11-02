// PromptDialog + SessionStore 交互式认证面测试（2026-11-02 批次二）。
//
// 钉住三件事：
// 1. 提问逐条渲染，**TOTP 建议值预填**（Rust 侧算好的 suggestion）；
// 2. 提交 → invoke `kbd_interactive_answer`，**答案条数等于提问条数**；
// 3. Esc / 取消 → 回**空答案**（= 放弃 = 认证失败，fail-closed）。
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "@tauri-apps/api/core";
import "../i18n";
import i18n from "../i18n";
import { PromptDialog } from "./PromptDialog";
import { useSessionStore } from "./SessionStore";
import { useModalStore } from "../ui/modalStore";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn> as ReturnType<typeof vi.fn> & {
  mock: { calls: unknown[][]; reset: () => void; mockResolvedValue: (v: unknown) => void };
};

function seedAsk(over: Record<string, unknown> = {}) {
  useSessionStore.setState({
    promptAsk: {
      ask_id: "7:1",
      host_id: 7,
      host_name: "bastion-a",
      prompts: [
        { text: "Password:" },
        { text: "Verification code:", suggestion: "123456" },
      ],
      hop: 0,
      origin_host_id: 7,
      sessionId: "",
    },
    ...over,
  });
  useModalStore.setState({ active: "promptAsk" });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(null);
  useSessionStore.setState({ promptAsk: null });
  useModalStore.setState({ active: null });
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ promptAsk: null });
  useModalStore.setState({ active: null });
  void i18n.changeLanguage("en-US");
});

describe("PromptDialog", () => {
  it("无问询不渲染", () => {
    render(<PromptDialog />);
    expect(screen.queryByTestId("prompt-dialog")).toBeNull();
  });

  it("逐条渲染提问；TOTP 建议值预填输入框", () => {
    seedAsk();
    render(<PromptDialog />);
    expect(screen.getByTestId("prompt-dialog")).toBeTruthy();
    expect(screen.getByText("Password:")).toBeTruthy();
    expect(screen.getByText("Verification code:")).toBeTruthy();
    // 验证码位预填 Rust 侧算好的码
    expect((screen.getByTestId("prompt-input-1") as HTMLInputElement).value).toBe("123456");
    // 密码位无建议 → 空
    expect((screen.getByTestId("prompt-input-0") as HTMLInputElement).value).toBe("");
    // 有建议 → 展示「已自动填入」说明
    expect(screen.getByTestId("prompt-autofill-hint")).toBeTruthy();
  });

  it("提交 → invoke kbd_interactive_answer，答案条数等于提问条数", async () => {
    seedAsk();
    render(<PromptDialog />);
    fireEvent.change(screen.getByTestId("prompt-input-0"), { target: { value: "pw123" } });
    fireEvent.click(screen.getByTestId("prompt-submit"));
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === "kbd_interactive_answer");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ askId: "7:1", answers: ["pw123", "123456"] });
    });
  });

  it("取消 → 回空答案（放弃 = 认证失败，fail-closed）", async () => {
    seedAsk();
    render(<PromptDialog />);
    fireEvent.click(screen.getByTestId("prompt-cancel"));
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === "kbd_interactive_answer");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ askId: "7:1", answers: [] });
    });
  });

  it("链式问询带「第 N 跳」标识", () => {
    seedAsk();
    render(<PromptDialog />);
    expect(screen.getByText(/第 1 跳/)).toBeTruthy();
  });
});
