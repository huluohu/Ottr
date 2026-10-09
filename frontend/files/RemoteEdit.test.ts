// RemoteEdit 轮询驱动器测试（Phase 2 Task 3 Step 2）：命令契约 / 回调分发 /
// gone 停轮询 / 慢链路防重入 / close 幂等。invoke 全量 mock + fake timers。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  EDIT_POLL_MS,
  remoteEdits,
  type EditPollStatus,
} from "./RemoteEdit";

const mockedInvoke = invoke as unknown as Mock;

function poll(status: EditPollStatus["status"]) {
  return Promise.resolve({ status });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  remoteEdits.resetForTests();
});

afterEach(() => {
  remoteEdits.resetForTests();
  vi.useRealTimers();
});

describe("RemoteEditManager", () => {
  it("open：下载成功后才起轮询（remote_edit_open 契约 + isActive/activeRemotes）", async () => {
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/ottr-edit/pty-0/x/f.txt" });
    await remoteEdits.open("pty-0", "/home/spike/f.txt");
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_open", {
      id: "pty-0",
      remote: "/home/spike/f.txt",
    });
    expect(remoteEdits.isActive("pty-0", "/home/spike/f.txt")).toBe(true);
    expect(remoteEdits.activeRemotes("pty-0")).toEqual(["/home/spike/f.txt"]);
    expect(remoteEdits.activeRemotes("other")).toEqual([]);

    // 下载失败（invoke reject）不得起轮询
    mockedInvoke.mockRejectedValue(new Error("no such session"));
    await expect(remoteEdits.open("pty-1", "/x")).rejects.toThrow("no such session");
    expect(remoteEdits.isActive("pty-1", "/x")).toBe(false);
  });

  it("轮询分发：quiet 无回调 / saved 触发 onSaved / conflict 触发 onConflict", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    await remoteEdits.open("pty-0", "/a");
    const onSaved = vi.fn();
    const onConflict = vi.fn();
    remoteEdits.callbacks = { onSaved, onConflict };

    mockedInvoke.mockImplementation((_cmd: string) => {
      if (_cmd === "remote_edit_poll") return poll("quiet");
      return Promise.resolve({ local_path: "/tmp/x" });
    });
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_poll", {
      id: "pty-0",
      remote: "/a",
    });
    expect(onSaved).not.toHaveBeenCalled();

    mockedInvoke.mockImplementation(() => poll("saved"));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(onSaved).toHaveBeenCalledWith("pty-0", "/a");

    mockedInvoke.mockImplementation(() => poll("conflict"));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(onConflict).toHaveBeenCalledWith("pty-0", "/a");
  });

  it("gone：Rust 侧会话消失 → 停轮询（不再发 poll）并通知订阅者", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    const onNotify = vi.fn();
    await remoteEdits.open("pty-0", "/a");
    const off = remoteEdits.subscribe(onNotify);
    off();
    mockedInvoke.mockImplementation(() => poll("gone"));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(false);
    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length;
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 3);
    // polling must stop after gone
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBe(calls);
  });

  it("remote_gone（Fix round 1 M-2）：一次性 onRemoteGone + 停轮询", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    await remoteEdits.open("pty-0", "/a");
    const onRemoteGone = vi.fn();
    remoteEdits.callbacks = { onRemoteGone };
    mockedInvoke.mockImplementation(() => poll("remote_gone"));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(onRemoteGone).toHaveBeenCalledTimes(1);
    expect(onRemoteGone).toHaveBeenCalledWith("pty-0", "/a");
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(false);
    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length;
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 2);
    // 远端已删：轮询必须停（不再打死循环）
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBe(calls);
  });

  it("慢链路防重入：poll 未返回期间 interval 再触发不再叠加 invoke", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    await remoteEdits.open("pty-0", "/a");
    let release!: (v: { status: string }) => void;
    mockedInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 2);
    // in-flight poll must suppress re-entry
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBe(1);
    release({ status: "quiet" });
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBe(2);
  });

  // --- BL-505：瞬态 stat 错误与确删边界（连续失败计数） ----------------------

  it("瞬态 Err ×1：下轮重试恢复，不判 gone、轮询不断", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    const onRemoteGone = vi.fn();
    await remoteEdits.open("pty-0", "/a");
    remoteEdits.callbacks = { onRemoteGone };
    let flips = 0;
    mockedInvoke.mockImplementation(() => {
      flips += 1;
      if (flips === 1) return Promise.reject(new Error("connection reset"));
      return poll("quiet");
    });
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS); // Err #1
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS); // 恢复 quiet
    expect(onRemoteGone).not.toHaveBeenCalled();
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(true);
    // 再走两轮照常轮询（失败计数已被成功清零）
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 2);
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBeGreaterThanOrEqual(4);
  });

  it("连续 Err ×3：判 gone 停轮询 + 一次性 onRemoteGone", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    const onRemoteGone = vi.fn();
    await remoteEdits.open("pty-0", "/a");
    remoteEdits.callbacks = { onRemoteGone };
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("conn gone")));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(true); // 2 连败仍容忍
    expect(onRemoteGone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(false); // 3 连败 → gone
    expect(onRemoteGone).toHaveBeenCalledTimes(1);
    expect(onRemoteGone).toHaveBeenCalledWith("pty-0", "/a");
    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length;
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 2);
    expect(
      mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length,
    ).toBe(calls);
  });

  it("Err ×2 后成功：计数清零，后续单次 Err 不触发 gone", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    const onRemoteGone = vi.fn();
    await remoteEdits.open("pty-0", "/a");
    remoteEdits.callbacks = { onRemoteGone };
    let round = 0;
    mockedInvoke.mockImplementation(() => {
      round += 1;
      if (round <= 2) return Promise.reject(new Error("jitter"));
      return poll("quiet");
    });
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 3); // err, err, ok
    expect(onRemoteGone).not.toHaveBeenCalled();
    // 计数已清零：再单败一次不得判 gone
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("jitter2")));
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(true);
    expect(onRemoteGone).not.toHaveBeenCalled();
  });

  it("close：停轮询 + remote_edit_close；Rust 端已清理时报错幂等吞掉", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue({ local_path: "/tmp/x" });
    await remoteEdits.open("pty-0", "/a");
    mockedInvoke.mockResolvedValue(true);
    await remoteEdits.close("pty-0", "/a");
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_close", {
      id: "pty-0",
      remote: "/a",
    });
    expect(remoteEdits.isActive("pty-0", "/a")).toBe(false);
    const polls = mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length;
    await vi.advanceTimersByTimeAsync(EDIT_POLL_MS * 2);
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === "remote_edit_poll").length).toBe(polls);

    // 会话已消失（close 报错）也视为收尾完成
    mockedInvoke.mockRejectedValue(new Error("no such edit session"));
    await expect(remoteEdits.close("pty-0", "/ghost")).resolves.toBeUndefined();
  });

  it("冲突裁定：overwrite 带 force=true；keepLocal 走 remote_edit_dismiss", async () => {
    mockedInvoke.mockResolvedValue({ status: "saved" });
    await remoteEdits.overwrite("pty-0", "/a");
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_save", {
      id: "pty-0",
      remote: "/a",
      force: true,
    });
    mockedInvoke.mockResolvedValue(undefined);
    await remoteEdits.keepLocal("pty-0", "/a");
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_dismiss", {
      id: "pty-0",
      remote: "/a",
    });
  });
});
