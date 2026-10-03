// 命令历史入库（Task 15）测试：payload 组装过滤 + fire-and-forget 容错。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { historyPayload, isIntegrationNoise, recordCommand, resetDedupForTests } from "./record";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);
  resetDedupForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = { hostId: 3, sessionId: "tab-abc" };

describe("historyPayload", () => {
  const ev = {
    exitCode: 0,
    command: "root@web01:~$ docker ps",
    cwd: "/srv/ottr",
    integrated: true,
  };

  it("正常命令 → 完整载荷（host_id/command/cwd/exit_code/session_id）", () => {
    expect(historyPayload(ctx, ev)).toEqual({
      host_id: 3,
      command: "root@web01:~$ docker ps",
      cwd: "/srv/ottr",
      exit_code: 0,
      session_id: "tab-abc",
    });
  });

  it("空白命令 → null（提示符噪声/纯回车不入库）", () => {
    expect(historyPayload(ctx, { ...ev, command: "   " })).toBeNull();
    expect(historyPayload(ctx, { ...ev, command: "" })).toBeNull();
  });

  it("shell 集成注入行回声 → null（attach 首窗噪声）", () => {
    const injection =
      "export PROMPT_COMMAND='printf \"\\e]133;D;%s\\a\\e]133;A\\a\" \"$?\"; printf \"\\e]7;file://%s%s\\a\" \"$HOSTNAME\" \"$PWD\"'";
    expect(historyPayload(ctx, { ...ev, command: injection })).toBeNull();
    expect(isIntegrationNoise("__osc133_preexec(){ ... }")).toBe(true);
    expect(isIntegrationNoise("precmd(){ print -Pn ... }")).toBe(true);
    expect(isIntegrationNoise("docker ps")).toBe(false);
  });

  it("exit_code null（shell 未上报）照常入库", () => {
    expect(historyPayload(ctx, { ...ev, exitCode: null })?.exit_code).toBeNull();
  });

  it("缺陷 45：integrated=false（无完整 shell 集成的会话）→ null（保守停用历史入库）", () => {
    // 宁缺勿污：D-without-C 会话的「命令」实为输出行/提示符行——不入库。
    expect(historyPayload(ctx, { ...ev, integrated: false })).toBeNull();
    // integrated=true 照常入库，且 integrated 字段不进 HistoryInput 载荷
    expect(historyPayload(ctx, { ...ev, integrated: true, command: "docker ps" })).toMatchObject({
      host_id: 3,
      command: "docker ps",
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        historyPayload(ctx, { ...ev, integrated: true }),
        "integrated",
      ),
    ).toBe(false);
  });
});

describe("recordCommand（fire-and-forget）", () => {
  it("正常命令 → invoke history_insert 一次；失败静默不抛", async () => {
    recordCommand(ctx, { exitCode: 1, command: "grep x /nope", cwd: null, integrated: true });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("history_insert", {
      input: {
        host_id: 3,
        command: "grep x /nope",
        cwd: null,
        exit_code: 1,
        session_id: "tab-abc",
      },
    });

    mockedInvoke.mockRejectedValueOnce(new Error("vault closed"));
    expect(() =>
      recordCommand(ctx, { exitCode: 0, command: "ls", cwd: null, integrated: true }),
    ).not.toThrow();
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2));
  });

  it("噪声/空白命令不发 invoke", () => {
    recordCommand(ctx, { exitCode: 0, command: "  ", cwd: null, integrated: true });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("缺陷 45：D-only 会话（integrated=false）不发 invoke（历史入库保守停用）", () => {
    recordCommand(ctx, { exitCode: 0, command: "12:00 INFO tick", cwd: null, integrated: false });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

describe("双 D 去重（fix 1/5：注入幂等盲区的双集成重复完成事件）", () => {
  const ev = { exitCode: 0, command: "docker ps", cwd: null, integrated: true };

  it("同 host+command 同秒重复完成事件只入一条（双 D 间隔毫秒级必同秒）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    recordCommand(ctx, ev);
    recordCommand(ctx, ev);
    recordCommand(ctx, ev);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it("跨秒的同命令照常入库（真人重跑不去重）；不同 host 互不影响", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    recordCommand(ctx, ev);
    vi.setSystemTime(new Date("2026-09-30T12:00:02Z"));
    recordCommand(ctx, ev);
    expect(mockedInvoke).toHaveBeenCalledTimes(2);

    recordCommand({ hostId: 9, sessionId: "tab-other" }, ev);
    expect(mockedInvoke).toHaveBeenCalledTimes(3);
  });

  it("FIFO 有界：超容量后最老键被驱逐（同键可再次入库）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    // 灌 16 个不同键
    for (let i = 0; i < 16; i++) {
      recordCommand(ctx, { ...ev, command: `cmd-${i}` });
    }
    expect(mockedInvoke).toHaveBeenCalledTimes(16);
    // 第 17 个键驱逐 cmd-0；cmd-0 再来（同秒）可重新入库
    recordCommand(ctx, { ...ev, command: "cmd-16" });
    recordCommand(ctx, { ...ev, command: "cmd-0" });
    expect(mockedInvoke).toHaveBeenCalledTimes(18);
  });
});
