// PromptDialog + SessionStore 交互式认证面测试（2026-11-02 批次二）。
//
// 钉住五件事：
// 1. 提问逐条渲染，**TOTP 建议值预填**（Rust 侧算好的 suggestion）；
// 2. 提交 → invoke `kbd_interactive_answer`，**答案条数等于提问条数**；
// 3. Esc / 取消 → 回**空答案**（= 放弃 = 认证失败，fail-closed）；
// 4. 验证码**有效期倒计时**展示（Rust 下发的剩余秒数）；
// 5. 码过期 → 自动换一个码（真机 E2E 抓到的缺陷：提交旧码必被服务端拒）；
//    但用户手改过输入框时**不覆盖**他的手输值。
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
      credential_id: 42,
      prompts: [
        { text: "Password:" },
        { text: "Verification code:", suggestion: "123456", suggestion_expires_in: 12 },
      ],
      hop: 0,
      origin_host_id: 7,
      sessionId: "",
    },
    ...over,
  });
  useModalStore.setState({ active: "promptAsk" });
}

/** 让 `credential_totp_code` 返回一个可预期的新码。 */
function mockTotp(code: string, remaining = 25) {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "credential_totp_code") {
      return Promise.resolve({ code, remaining_seconds: remaining });
    }
    return Promise.resolve(null);
  });
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

  it("展示验证码剩余有效秒数", () => {
    seedAsk();
    render(<PromptDialog />);
    expect(screen.getByTestId("prompt-code-countdown").textContent).toContain("12");
  });

  it("码已过期 → 自动换一个码并显示过期提示", async () => {
    mockTotp("654321");
    seedAsk({
      promptAsk: {
        ask_id: "7:1",
        host_id: 7,
        host_name: "bastion-a",
        credential_id: 42,
        prompts: [
          { text: "Password:" },
          { text: "Verification code:", suggestion: "123456", suggestion_expires_in: 0 },
        ],
        hop: 0,
        origin_host_id: 7,
        sessionId: "",
      },
    });
    render(<PromptDialog />);
    // 过期 → 向 Rust 要一个新码
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === "credential_totp_code");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ credentialId: 42 });
    });
    // 新码落到输入框
    await waitFor(() => {
      expect((screen.getByTestId("prompt-input-1") as HTMLInputElement).value).toBe("654321");
    });
  });

  it("用户手改过输入框 → 过期时不覆盖他的手输值", async () => {
    vi.useFakeTimers();
    try {
      mockTotp("654321");
      seedAsk();
      render(<PromptDialog />);
      // 用户立刻改成自己的码（此后 Ottr 不再自动覆盖）
      fireEvent.change(screen.getByTestId("prompt-input-1"), { target: { value: "999888" } });
      // 时钟推过一整个 TOTP 窗
      await vi.advanceTimersByTimeAsync(15000);
      expect((screen.getByTestId("prompt-input-1") as HTMLInputElement).value).toBe("999888");
      // 不该去要新码
      expect(
        mockedInvoke.mock.calls.find(([cmd]) => cmd === "credential_totp_code"),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("提交时码已过期 → 先换新码再提交（提交的是新码）", async () => {
    mockTotp("654321");
    seedAsk({
      promptAsk: {
        ask_id: "7:1",
        host_id: 7,
        host_name: "bastion-a",
        credential_id: 42,
        prompts: [
          { text: "Password:" },
          { text: "Verification code:", suggestion: "123456", suggestion_expires_in: 0 },
        ],
        hop: 0,
        origin_host_id: 7,
        sessionId: "",
      },
    });
    render(<PromptDialog />);
    fireEvent.click(screen.getByTestId("prompt-submit"));
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === "kbd_interactive_answer");
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({ askId: "7:1", answers: ["", "654321"] });
    });
  });

  it("手动「刷新验证码」按钮 → 取一个新码", async () => {
    mockTotp("654321");
    seedAsk();
    render(<PromptDialog />);
    fireEvent.click(screen.getByTestId("prompt-code-refresh"));
    await waitFor(() => {
      expect((screen.getByTestId("prompt-input-1") as HTMLInputElement).value).toBe("654321");
    });
  });
});
