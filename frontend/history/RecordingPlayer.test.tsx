// RecordingPlayer 组件测试（Task 5 Step 3）：加载即渲染 header 尺寸 xterm、
// 时间 0 事件先写、播放推进写事件块、倍速按钮、时间轴 seek（后跳 reset+重放）、
// 导出默认脱敏 / 原文两段式确认。xterm 用捕获子类（Terminal.test 同款惯例），
// invoke 全量 mock。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@xterm/xterm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xterm/xterm")>();
  const captured: InstanceType<typeof mod.Terminal>[] = [];
  const writes: string[] = [];
  let resetCount = 0;
  class Terminal extends mod.Terminal {
    constructor(...args: ConstructorParameters<typeof mod.Terminal>) {
      super(...args);
      captured.push(this);
    }
    static __captured = captured;
    static __writes = writes;
    static __resetCount = () => resetCount;
    static __clear() {
      writes.length = 0;
      resetCount = 0;
    }
    write(data: string | Uint8Array): void {
      writes.push(typeof data === "string" ? data : "");
      super.write(data);
    }
    reset(): void {
      resetCount += 1;
      super.reset();
    }
  }
  return { ...mod, Terminal };
});

import { Terminal as XTermClass } from "@xterm/xterm";
import { assembleExportEvents, RecordingPlayer } from "./RecordingPlayer";
import type { RecordingData } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

function recording(): RecordingData {
  return {
    entry: {
      id: 7,
      host_id: 1,
      path: "/data/recordings/rec-1.cast",
      duration: 2.5,
      text_index_path: "recordings_fts:7",
      created_at: 1_760_000_000,
    },
    header: { version: 2, width: 100, height: 30, timestamp: 1_760_000_000 },
    events: [
      { time: 0, data: "root@web:~$ " },
      { time: 0.5, data: "echo hi\r\nhi\r\n" },
      { time: 1.5, data: "password=hunter2\r\n" },
      { time: 2.4, data: "root@web:~$ " },
    ],
    duration: 2.5,
  };
}

function capturedTerms(): InstanceType<typeof XTermClass>[] {
  return (XTermClass as unknown as { __captured?: InstanceType<typeof XTermClass>[] })
    .__captured ?? [];
}

function writes(): string[] {
  return (XTermClass as unknown as { __writes: string[] }).__writes;
}

function resetCount(): number {
  return (XTermClass as unknown as { __resetCount: () => number }).__resetCount();
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});
beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue("/tmp/out.cast");
  (XTermClass as unknown as { __clear: () => void }).__clear();
  // xterm open() 在 jsdom 需要 matchMedia（含 addListener 旧 API）/ ResizeObserver
  // （Terminal.test 同款 stub 口径 + addListener 补齐）
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
});

function renderPlayer(props: Partial<Parameters<typeof RecordingPlayer>[0]> = {}) {
  const onClose = vi.fn();
  render(<RecordingPlayer data={recording()} onClose={onClose} {...props} />);
  return { onClose };
}

describe("RecordingPlayer", () => {
  it("打开即建只读 xterm（header 尺寸）并写入时间 0 事件", async () => {
    renderPlayer();
    await act(async () => {});
    const terms = capturedTerms();
    expect(terms.length).toBe(1);
    expect((terms[0] as unknown as { options: { cols: number; rows: number; disableStdin: boolean } }).options).toMatchObject({
      cols: 100,
      rows: 30,
      disableStdin: true,
    });
    expect(writes()).toEqual(["root@web:~$ "]);
  });

  it("播放推进：tick 写后续事件块，结束自动停", async () => {
    vi.useFakeTimers();
    renderPlayer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("player-play"));
    // 1s（20 tick × 1× 50ms）后 t≈1.0：时间 0 与 0.5 事件已写，1.5 未到
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1050);
    });
    const all = writes().join("");
    expect(all).toContain("echo hi");
    expect(all).not.toContain("password=hunter2");
    // 再 2s：越过末事件（2.5s）→ ended 自动停（播放按钮回到 ▶）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(writes().join("")).toContain("password=hunter2");
    expect(screen.getByTestId("player-time").textContent).toBe("00:02");
    expect(screen.getByTestId("player-play").textContent).toBe("▶");
    vi.useRealTimers();
  });

  it("时间轴 seek：后跳 reset + 全量重放；倍速按钮切换", async () => {
    vi.useFakeTimers();
    renderPlayer();
    await act(async () => {});
    const seek = screen.getByTestId("player-seek") as HTMLInputElement;
    // 前跳到 2.0：增量写 0.5/1.5/2.0 前事件
    fireEvent.change(seek, { target: { value: "2" } });
    await act(async () => {});
    expect(writes().join("")).toContain("password=hunter2");
    // 后跳到 0：reset + 从 0 重放（时间 0 事件）
    fireEvent.change(seek, { target: { value: "0" } });
    await act(async () => {});
    expect(resetCount()).toBeGreaterThanOrEqual(1);
    expect(writes()[writes().length - 1]).toBe("root@web:~$ ");
    // 倍速
    fireEvent.click(screen.getByTestId("player-speed-2"));
    expect(screen.getByTestId("player-speed-2").dataset.active).toBe("true");
    vi.useRealTimers();
  });

  it("导出默认脱敏（redact 引擎过事件流）；原文需两段式确认", async () => {
    renderPlayer({ savePath: async (name) => `/tmp/${name}` });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("player-export-redacted"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("recording_export", {
        id: 7,
        events: expect.any(Array),
        path: "/tmp/ottr-recording-7.cast",
      });
    });
    const events = mockedInvoke.mock.calls[0][1].events as { time: number; data: string }[];
    expect(events).toHaveLength(4);
    expect(events[2].data).toContain("[REDACTED_PASSWORD_1]");
    expect(events[2].data).not.toContain("hunter2");
    expect(events[0].data).toBe("root@web:~$ ");
    // 时间轴保真
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1.5, 2.4]);
    expect(screen.getByTestId("player-export-msg").textContent).toBe("/tmp/out.cast");

    // 原文：第一次点击 = 确认态，不导出
    fireEvent.click(screen.getByTestId("player-export-raw"));
    expect(screen.getByTestId("player-export-raw").textContent).toContain("确认导出原文");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    // 第二次点击 = 真导出，原文原样
    fireEvent.click(screen.getByTestId("player-export-raw"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledTimes(2);
    });
    const rawEvents = mockedInvoke.mock.calls[1][1].events as { data: string }[];
    expect(rawEvents[2].data).toContain("hunter2");
  });

  it("save 取消（null）即中止导出——不 invoke 不落默认名（fix round 1/5 M-3）", async () => {
    renderPlayer({ savePath: async () => null });
    await act(async () => {});
    // 脱敏导出取消
    fireEvent.click(screen.getByTestId("player-export-redacted"));
    await waitFor(() => {
      expect(screen.getByTestId("player-export-msg").textContent).toContain("已取消导出");
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
    // 原文导出：确认后取消同样中止（未脱敏文件绝不写出）
    fireEvent.click(screen.getByTestId("player-export-raw"));
    fireEvent.click(screen.getByTestId("player-export-raw"));
    await waitFor(() => {
      expect(screen.getByTestId("player-export-msg").textContent).toContain("已取消导出");
    });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("Esc 关闭回放", async () => {
    const { onClose } = renderPlayer();
    await act(async () => {});
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("assembleExportEvents", () => {
  it("raw 模式原样透传", () => {
    const data = recording();
    const out = assembleExportEvents(data, "raw");
    expect(out.map((e) => e.data)).toEqual(data.events.map((e) => e.data));
  });
});
