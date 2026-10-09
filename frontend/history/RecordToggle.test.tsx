// RecordToggle 测试（Task 5 Step 3）：idle 点击 = recording_start、录制中点击 =
// recording_stop、无会话禁用、rustId 切换（断线重连）本地状态清账回 idle。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { RecordToggle } from "./RecordToggle";

const mockedInvoke = invoke as unknown as Mock;

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});
beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue("/data/recordings/x.cast");
});
afterEach(() => {
  cleanup();
});

describe("RecordToggle", () => {
  it("无会话（rustId null）禁用", () => {
    render(<RecordToggle rustId={null} hostId={1} />);
    expect((screen.getByTestId("record-toggle") as HTMLButtonElement).disabled).toBe(true);
  });

  it("idle 点击 = recording_start 并点亮；再点 = recording_stop 回 idle", async () => {
    const { rerender } = render(<RecordToggle rustId="pty-1" hostId={3} />);
    const btn = screen.getByTestId("record-toggle");
    expect(btn.dataset.active).toBe("false");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("recording_start", { rustId: "pty-1", hostId: 3 });
    expect(btn.dataset.active).toBe("true");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("recording_stop", { rustId: "pty-1" });
    expect(btn.dataset.active).toBe("false");
    void rerender;
  });

  it("rustId 切换（断线重连）→ 本地状态清账（按钮回 idle，Rust 侧已自动收尾）", async () => {
    const { rerender } = render(<RecordToggle rustId="pty-1" hostId={3} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("record-toggle"));
    });
    expect(screen.getByTestId("record-toggle").dataset.active).toBe("true");
    // 重连 = 新 rustId：旧录制已由 Rust auto-finalize，按钮回 idle
    rerender(<RecordToggle rustId="pty-2" hostId={3} />);
    expect(screen.getByTestId("record-toggle").dataset.active).toBe("false");
  });
});
