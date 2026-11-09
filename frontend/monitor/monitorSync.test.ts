// monitorSync 单测（2026-11-08 功能审计 C2）：monitor_enabled 落库成功后，
// 活会话的采样起停即时同步——此前只落库，已连接主机开监控要等重连才真正
// 起采样（总览卡片误显「未连接」），主机表单里关掉则采样照跑到会话消亡。
// Rust monitor_start 幂等（重复 start = Ok），无活会话 = no-op。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../session/SessionStore";
import { useSessionStore } from "../session/SessionStore";
import { syncMonitorSampling } from "./monitorSync";

const mockedInvoke = invoke as unknown as Mock;

function makeSession(over: Partial<Session> & Pick<Session, "id" | "hostId">): Session {
  return {
    hostName: "h",
    address: "10.0.0.1",
    port: 2222,
    username: null,
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: null,
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    ...over,
  } as Session;
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(null);
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
});

describe("syncMonitorSampling（2026-11-08 审计 C2）", () => {
  it("开启 + 在册根会话 → 对根会话 rustId 发 monitor_start", () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: "t1", hostId: 7, rustId: "pty-1" })],
    });
    syncMonitorSampling(7, true);
    expect(mockedInvoke).toHaveBeenCalledWith("monitor_start", { id: "pty-1" });
  });

  it("关闭 + 在册根会话 → monitor_stop", () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: "t1", hostId: 7, rustId: "pty-1" })],
    });
    syncMonitorSampling(7, false);
    expect(mockedInvoke).toHaveBeenCalledWith("monitor_stop", { id: "pty-1" });
  });

  it("分屏 pane 不算根会话（多份采样纯浪费）→ 不发", () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: "p1", hostId: 7, rustId: "pty-9", paneOf: "t1" })],
    });
    syncMonitorSampling(7, true);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("主机无活会话 → no-op（下次 attach 按开关重走）", () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: "t1", hostId: 7, rustId: null })],
    });
    syncMonitorSampling(7, true);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("起停失败静默（不阻断开关落库后的 UI 流程）", () => {
    mockedInvoke.mockRejectedValue(new Error("gone"));
    useSessionStore.setState({
      sessions: [makeSession({ id: "t1", hostId: 7, rustId: "pty-1" })],
    });
    expect(() => syncMonitorSampling(7, true)).not.toThrow();
  });
});
