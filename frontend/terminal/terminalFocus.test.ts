// 终端聚焦请求总线单测：nonce 递增语义（0 = 从未请求）。
import { describe, expect, it, beforeEach } from "vitest";
import { useTerminalFocus } from "./terminalFocus";

beforeEach(() => useTerminalFocus.setState({ nonce: 0 }));

describe("useTerminalFocus", () => {
  it("request 递增 nonce；初始为 0（从未请求）", () => {
    expect(useTerminalFocus.getState().nonce).toBe(0);
    useTerminalFocus.getState().request();
    expect(useTerminalFocus.getState().nonce).toBe(1);
    useTerminalFocus.getState().request();
    expect(useTerminalFocus.getState().nonce).toBe(2);
  });
});
