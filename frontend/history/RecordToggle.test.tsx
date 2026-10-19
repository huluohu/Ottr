// RecordToggle 测试（Task 5 Step 3）：idle 点击 = recording_start、录制中点击 =
// recording_stop、无会话禁用、rustId 切换（断线重连）本地状态清账回 idle。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../files/api", () => ({
  revealLocalFile: vi.fn().mockResolvedValue(undefined),
  openLocalFile: vi.fn().mockResolvedValue(undefined),
}));
import { RecordToggle } from "./RecordToggle";
import { revealLocalFile } from "../files/api";
import { useToastStore } from "../ui/toastStore";

const mockedInvoke = invoke as unknown as Mock;
const mockedReveal = vi.mocked(revealLocalFile);

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

describe("录制完成 toast 的「打开所在目录」（2026-10-19 用户需求）", () => {
  it("stop 返回 saved_path → toast 带动作；点动作 reveal 该路径", async () => {
    useToastStore.setState({ toasts: [] });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "recording_stop")
        return Promise.resolve({ id: 1, saved_path: "/data/recordings/saved.cast" });
      return Promise.resolve(null);
    });
    render(<RecordToggle rustId="pty-9" hostId={1} />);
    const btn = screen.getByTestId("record-toggle");
    await act(async () => {
      fireEvent.click(btn);
    });
    await act(async () => {
      fireEvent.click(btn); // 第二次 = stop
    });
    const list = useToastStore.getState().toasts;
    const toast = list[list.length - 1];
    expect(toast?.message).toContain("/data/recordings/saved.cast");
    expect(toast?.action?.label).toBeTruthy();
    await act(async () => {
      toast?.action?.run();
    });
    expect(mockedReveal).toHaveBeenCalledWith("/data/recordings/saved.cast");
  });
});
