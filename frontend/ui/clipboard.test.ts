// 全局剪贴板自动清空（2026-10-20 用户裁定）：所有前端复制走 copyText，
// 读 security.clipboard_clear_secs 定时清空，只认最后一次复制。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  clipboardClearSecsFrom,
  copyText,
  resetClipboardForTests,
} from "./clipboard";

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  resetClipboardForTests();
  writeText.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    if (cmd === "settings_get" && args?.key === "security.clipboard_clear_secs")
      return Promise.resolve(30);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("clipboardClearSecsFrom", () => {
  it("0/负数 = 关闭；非法 = 默认 30；越界收敛到上限", () => {
    expect(clipboardClearSecsFrom(0)).toBeNull();
    expect(clipboardClearSecsFrom(-5)).toBeNull();
    expect(clipboardClearSecsFrom(undefined)).toBe(30);
    expect(clipboardClearSecsFrom("abc")).toBe(30);
    expect(clipboardClearSecsFrom(5)).toBe(5);
    expect(clipboardClearSecsFrom(99_999)).toBe(3600);
  });
});

describe("copyText", () => {
  it("写入后按配置秒数清空（配置 30s → 30 秒后写空串）", async () => {
    await copyText("secret-1");
    expect(writeText).toHaveBeenCalledWith("secret-1");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(writeText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    // 清空走 Rust 命令（WebKitGTK 下 navigator 定时清空会被拒）
    expect(mockedInvoke).toHaveBeenCalledWith("clipboard_clear");
    expect(writeText).not.toHaveBeenCalledWith("");
  });

  it("配置 0 = 关闭：永不清空", async () => {
    mockedInvoke.mockImplementation(() => Promise.resolve(0));
    await copyText("keep-me");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writeText).toHaveBeenCalledTimes(1); // 只有写入，无清空
  });

  it("连续复制只认最后一次：先复制的不清后复制的内容", async () => {
    await copyText("first");
    await vi.advanceTimersByTimeAsync(10_000);
    await copyText("second"); // 旧计时器作废
    await vi.advanceTimersByTimeAsync(20_000); // 距 first 30s，但 first 已作废
    expect(mockedInvoke).not.toHaveBeenCalledWith("clipboard_clear");
    await vi.advanceTimersByTimeAsync(10_000); // 距 second 30s
    expect(mockedInvoke).toHaveBeenCalledWith("clipboard_clear");
  });
});
