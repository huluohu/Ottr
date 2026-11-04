// 终端聚焦请求总线单测：nonce 递增语义（0 = 从未请求）+ 定向请求
// （Ask Ottr Task 2：request(sessionId) 只指名会话；泛型 request() 维持既有
// 「谁聚焦谁自判」语义，且清空定向目标）。
import { describe, expect, it, beforeEach } from "vitest";
import { useTerminalFocus } from "./terminalFocus";

beforeEach(() => useTerminalFocus.setState({ nonce: 0, targetSessionId: null }));

describe("useTerminalFocus", () => {
  it("request 递增 nonce；初始为 0（从未请求）", () => {
    expect(useTerminalFocus.getState().nonce).toBe(0);
    useTerminalFocus.getState().request();
    expect(useTerminalFocus.getState().nonce).toBe(1);
    useTerminalFocus.getState().request();
    expect(useTerminalFocus.getState().nonce).toBe(2);
  });

  it("request(sessionId)：定向请求记录目标会话，nonce 照常递增", () => {
    useTerminalFocus.getState().request("tab-1");
    expect(useTerminalFocus.getState().nonce).toBe(1);
    expect(useTerminalFocus.getState().targetSessionId).toBe("tab-1");
    useTerminalFocus.getState().request("tab-2");
    expect(useTerminalFocus.getState().nonce).toBe(2);
    expect(useTerminalFocus.getState().targetSessionId).toBe("tab-2");
  });

  it("泛型 request()：清空定向目标（既有调用面零回归——回退到「当前聚焦 pane」语义）", () => {
    useTerminalFocus.getState().request("tab-1");
    expect(useTerminalFocus.getState().targetSessionId).toBe("tab-1");
    useTerminalFocus.getState().request();
    expect(useTerminalFocus.getState().nonce).toBe(2);
    expect(useTerminalFocus.getState().targetSessionId).toBeNull();
  });
});
