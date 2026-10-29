// DiagnoseGate（诊断取消宽限）测试：失败上报 → 挂起；宽限期内 Ctrl+C → 收回；
// 到期未撤销 → 照常弹；卸载 → 收回。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DIAGNOSE_GRACE_MS, DiagnoseGate } from "./DiagnoseGate";
import type { DiagnoseRequest } from "../ai/aiStore";

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "s1",
  rustId: "pty-1",
  hostId: 7,
  hostName: "web-01",
  exitCode: 127,
  command: "web01:~$ rm -rf /nope",
};

describe("DiagnoseGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("失败上报先挂起，宽限期满才弹面板", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen });
    gate.schedule(REQ);
    expect(onOpen).not.toHaveBeenCalled();
    expect(gate.isPending).toBe(true);
    vi.advanceTimersByTime(DEFAULT_DIAGNOSE_GRACE_MS);
    expect(onOpen).toHaveBeenCalledWith(REQ);
    expect(gate.isPending).toBe(false);
  });

  it("宽限期内撤销（Ctrl+C）→ 诊断收回，面板不弹", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen });
    gate.schedule(REQ);
    gate.cancel();
    vi.advanceTimersByTime(DEFAULT_DIAGNOSE_GRACE_MS * 3);
    expect(onOpen).not.toHaveBeenCalled();
    expect(gate.isPending).toBe(false);
  });

  it("撤销发生在宽限期边界之前才算数（到期后再撤不追溯）", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen });
    gate.schedule(REQ);
    vi.advanceTimersByTime(DEFAULT_DIAGNOSE_GRACE_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);
    gate.cancel();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("新的失败取代旧的挂起（只弹最近一次）", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen });
    gate.schedule(REQ);
    const second = { ...REQ, exitCode: 1, command: "web01:~$ false" };
    gate.schedule(second);
    vi.advanceTimersByTime(DEFAULT_DIAGNOSE_GRACE_MS);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(second);
  });

  it("卸载（dispose）→ 挂起的诊断收回，不在会话没了之后弹面板", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen });
    gate.schedule(REQ);
    gate.dispose();
    vi.advanceTimersByTime(DEFAULT_DIAGNOSE_GRACE_MS * 2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("自定义宽限期（注入毫秒数）", () => {
    const onOpen = vi.fn();
    const gate = new DiagnoseGate({ onOpen, graceMs: 50 });
    gate.schedule(REQ);
    vi.advanceTimersByTime(49);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
