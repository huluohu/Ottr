// 命令历史入库（Task 15）测试：payload 组装过滤 + fire-and-forget 容错。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { historyPayload, isIntegrationNoise, recordCommand } from "./record";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);
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
});

describe("recordCommand（fire-and-forget）", () => {
  it("正常命令 → invoke history_insert 一次；失败静默不抛", async () => {
    recordCommand(ctx, { exitCode: 1, command: "grep x /nope", cwd: null });
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
      recordCommand(ctx, { exitCode: 0, command: "ls", cwd: null }),
    ).not.toThrow();
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2));
  });

  it("噪声/空白命令不发 invoke", () => {
    recordCommand(ctx, { exitCode: 0, command: "  ", cwd: null });
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
