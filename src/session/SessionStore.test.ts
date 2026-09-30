// SessionStore 状态机测试（Task 7 Step 1）：重连退避序列、手动断开不重连、
// 首连失败不自动重连、host key 问询/裁定、会话恢复（不自动连接）、标签持久化。
// invoke/Channel 全量 mock（真后端命令已在 Rust 侧接线，store 测试隔离 IPC）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  OPEN_TABS_KEY,
  reconnectDelayMs,
  registerSink,
  toBytes,
  unregisterSink,
  useSessionStore,
  type Session,
} from "./SessionStore";
import type { Host } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const hostA: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  credential_id: 7,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};
const hostB: Host = { ...hostA, id: 2, name: "db-01", address: "10.0.0.2", credential_id: 8 };
const hostC: Host = { ...hostA, id: 3, name: "cache-01", address: "10.0.0.3", credential_id: 9 };

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    hostKeyAsk: null,
    settings: { maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS },
    trees: {},
    activePane: {},
    searchSessionId: null,
  });
  localStorage.clear();
}

/** 拿到 store 里最后一个 connect 触发的 attach 参数（断言 hostId 传递）。 */
function attachCalls(): Array<[string, Record<string, unknown>]> {
  return (mockedInvoke.mock.calls as Array<[string, Record<string, unknown>]>).filter(
    ([cmd]) => cmd === "attach_host_session",
  );
}

/** 手动把会话推到 connected（模拟一次成功 attach 后的状态，避免异步驱动）。 */
function markConnected(id: string, rustId: string): void {
  useSessionStore.setState((st) => ({
    sessions: st.sessions.map((s) =>
      s.id === id ? { ...s, status: "connected", rustId, attempt: 0 } : s,
    ),
  }));
}

beforeEach(() => {
  mockedInvoke.mockReset();
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconnectDelayMs（简报：1/2/4/8/16/30s 封顶）", () => {
  it("指数退避且 30s 封顶", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("连接与断线重连", () => {
  it("openTab → attach_host_session(hostId) → connected；同主机重复开只激活", async () => {
    mockedInvoke.mockResolvedValue("pty-1");
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    expect(attachCalls()).toHaveLength(1);
    expect(attachCalls()[0][1]).toMatchObject({ hostId: 1, cols: 80, rows: 24 });
    expect(useSessionStore.getState().sessions[0].status).toBe("connected");
    expect(useSessionStore.getState().sessions[0].rustId).toBe("pty-1");

    // 双击同一主机 → 激活现有标签，不再 attach（已连接）
    const id2 = useSessionStore.getState().openTab(hostA);
    expect(id2).toBe(id);
    expect(useSessionStore.getState().activeId).toBe(id);
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(attachCalls()).toHaveLength(1);
  });

  it("断线（session-closed closed）→ 退避序列 1/2/4/8/16s，第 6 次超上限转 disconnected", async () => {
    let fail = false;
    mockedInvoke.mockImplementation((_cmd: string) =>
      fail ? Promise.reject(new Error("connection refused")) : Promise.resolve("pty-ok"),
    );
    const store = useSessionStore.getState();
    const id = store.openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    markConnected(id, "pty-ok");

    // 连接丢失（对端 RST / keepalive 超时）
    act(() =>
      useSessionStore.getState().onSessionClosed({ id: "pty-ok", reason: "closed" }),
    );
    const delays: number[] = [];
    let prev = Date.now();
    for (let i = 0; i < 5; i++) {
      const s = useSessionStore.getState().sessions[0];
      expect(s.status).toBe("reconnecting");
      delays.push((s.nextRetryAt as number) - prev);
      prev = s.nextRetryAt as number;
      fail = true;
      await vi.advanceTimersByTimeAsync(reconnectDelayMs(i + 1));
    }
    // 退避序列 = 1/2/4/8/16s（封顶值出现在配置上限更高的场景）
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);

    // 循环内第 5 次 advance 已触发第 5 次重连（失败）→ attempt 6 > 5 → disconnected
    expect(useSessionStore.getState().sessions[0].status).toBe("disconnected");
    expect(useSessionStore.getState().sessions[0].nextRetryAt).toBeNull();
    const attemptsSeen = attachCalls().length - 1; // 减去首连
    expect(attemptsSeen).toBe(5);
  });

  it("手动断开不重连：disconnect 后 session-closed / 定时器均不再触发 attach", async () => {
    mockedInvoke.mockResolvedValue("pty-1");
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    markConnected(id, "pty-1");

    useSessionStore.getState().disconnect(id);
    expect(useSessionStore.getState().sessions[0].status).toBe("disconnected");
    // 迟到的关闭事件（reason=closed）不得触发重连
    useSessionStore.getState().onSessionClosed({ id: "pty-1", reason: "closed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachCalls()).toHaveLength(1); // 只有过首连
    expect(useSessionStore.getState().sessions[0].status).toBe("disconnected");
  });

  it("cancelled 关闭原因（drop_session 主动断开）不触发重连", async () => {
    mockedInvoke.mockResolvedValue("pty-1");
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    markConnected(id, "pty-1");
    useSessionStore.getState().onSessionClosed({ id: "pty-1", reason: "cancelled" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachCalls()).toHaveLength(1);
  });

  it("首连失败 → disconnected 终态（不自动重连），重试由手动 connect 发起", async () => {
    mockedInvoke.mockRejectedValue(new Error("AuthRejected"));
    useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe("disconnected");
    expect(s.lastError).toContain("AuthRejected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachCalls()).toHaveLength(1);
  });

  it("孤儿收尾（评审 I-1）：connecting 期间关标签，迟到的 attach 成功也必须 drop_session", async () => {
    let resolveAttach: (v: string) => void = () => {};
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "attach_host_session") {
        return new Promise<string>((res) => (resolveAttach = res));
      }
      if (cmd === "drop_session") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    expect(useSessionStore.getState().sessions).toHaveLength(1);

    // 复现路径：接受 TOFU 前后立即点 ×（attach 仍在途、rustId 尚未落地）
    useSessionStore.getState().closeTab(id);
    expect(useSessionStore.getState().sessions).toHaveLength(0);

    // 迟到的成功解析：若无守卫收尾，Rust 会话/服务端 shell 永久泄漏
    resolveAttach("pty-orphan");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-orphan" });
    // 且不得把已关标签复活
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });

  it("孤儿收尾（generation 失配变体）：connecting 期间手动断开，迟到成功同样 drop_session", async () => {
    let resolveAttach: (v: string) => void = () => {};
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "attach_host_session") {
        return new Promise<string>((res) => (resolveAttach = res));
      }
      if (cmd === "drop_session") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    useSessionStore.getState().disconnect(id); // generation +1，attach 未解析
    resolveAttach("pty-orphan-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedInvoke).toHaveBeenCalledWith("drop_session", { id: "pty-orphan-2" });
    expect(useSessionStore.getState().sessions[0].status).toBe("disconnected");
    expect(useSessionStore.getState().sessions[0].rustId).toBeNull();
  });
});

describe("host key 问询（TOFU）", () => {
  function hangAttach(): void {
    mockedInvoke.mockImplementation(
      (cmd: string) =>
        cmd === "attach_host_session" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
  }

  it("ottr://host-key-ask → waiting_host_key + 弹窗态；accept → host_key_decision → attach 成功转 connected", async () => {
    let resolveAttach: (v: string) => void = () => {};
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "attach_host_session") {
        return new Promise<string>((res) => (resolveAttach = res));
      }
      if (cmd === "host_key_decision") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    const id = useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    expect(useSessionStore.getState().sessions[0].status).toBe("connecting");

    useSessionStore.getState().onHostKeyAsk({
      host_id: 1,
      host_name: "web-01",
      fingerprint: "SHA256:abc",
      kind: "first",
    });
    expect(useSessionStore.getState().sessions[0].status).toBe("waiting_host_key");
    expect(useSessionStore.getState().hostKeyAsk).toMatchObject({
      sessionId: id,
      fingerprint: "SHA256:abc",
      kind: "first",
    });

    await useSessionStore.getState().decideHostKey(true);
    expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
      hostId: 1,
      fingerprint: "SHA256:abc",
      accept: true,
    });
    expect(useSessionStore.getState().hostKeyAsk).toBeNull();

    resolveAttach("pty-9");
    await vi.advanceTimersByTimeAsync(0);
    expect(useSessionStore.getState().sessions[0].status).toBe("connected");
    expect(useSessionStore.getState().sessions[0].rustId).toBe("pty-9");
  });

  it("reject → disconnected 终态（host key 拒绝不重连）", async () => {
    hangAttach();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "attach_host_session") return new Promise(() => {});
      if (cmd === "host_key_decision") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    useSessionStore.getState().openTab(hostA);
    await vi.advanceTimersByTimeAsync(0);
    useSessionStore.getState().onHostKeyAsk({
      host_id: 1,
      host_name: "web-01",
      fingerprint: "SHA256:abc",
      kind: "changed",
    });
    await useSessionStore.getState().decideHostKey(false);
    expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
      hostId: 1,
      fingerprint: "SHA256:abc",
      accept: false,
    });
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attachCalls()).toHaveLength(1); // 无自动重连
  });
});

describe("标签持久化与恢复（open_host_ids）", () => {
  it("开/关标签写 localStorage；restoreTabs 还原为 disconnected 且不 attach（安全：不自动连接）", () => {
    const store = useSessionStore.getState();
    const a = store.openTab(hostA, { autoConnect: false });
    store.openTab(hostB, { autoConnect: false });
    store.openTab(hostC, { autoConnect: false });
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([1, 2, 3]);

    useSessionStore.getState().closeTab(hostB.id === 2 ? useSessionStore.getState().sessions[1].id : "");
    expect(JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]")).toEqual([1, 3]);

    // 模拟重启：清空会话，按持久化还原
    useSessionStore.setState({ sessions: [], activeId: null });
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify([1, 3, 42])); // 42 = 已删除主机
    const restored = useSessionStore.getState().restoreTabs([hostA, hostB, hostC]);
    expect(restored).toBe(2);
    const sessions = useSessionStore.getState().sessions;
    expect(sessions.map((s: Session) => s.hostId)).toEqual([1, 3]);
    expect(sessions.every((s: Session) => s.status === "disconnected")).toBe(true);
    expect(attachCalls()).toHaveLength(0);
    void a;
  });
});

describe("toBytes 通道解码", () => {
  it("ArrayBuffer 直传；base64 字符串 fallback 解码", () => {
    const src = new Uint8Array([1, 2, 3, 250]);
    const buf = src.slice().buffer;
    expect(toBytes(buf)).toEqual(src);
    expect(toBytes(btoa("\x01\x02\x03\xfa"))).toEqual(src);
  });
});

describe("会话编码（Task 9，A9）", () => {
  const gbkHost: Host = { ...hostA, id: 9, name: "gbk-box", encoding_override: "gbk" };
  const big5Host: Host = { ...hostA, id: 10, name: "big5-box", encoding_override: "big5" };

  it("openTab：encoding_override 进初值（支持集内）；不支持集兜底 utf-8", () => {
    const store = useSessionStore.getState();
    store.openTab(gbkHost, { autoConnect: false });
    store.openTab(big5Host, { autoConnect: false });
    const sessions = useSessionStore.getState().sessions;
    expect(sessions[0].encoding).toBe("gbk");
    expect(sessions[1].encoding).toBe("utf-8"); // big5 无 Rust 解码器，兜底
  });

  it("connect 成功后把会话编码下发新 rust 会话（重连不丢手动切换）", async () => {
    mockedInvoke.mockResolvedValue("pty-enc");
    const store = useSessionStore.getState();
    const id = store.openTab(gbkHost, { autoConnect: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedInvoke).toHaveBeenCalledWith("set_session_encoding", {
      id: "pty-enc",
      encoding: "gbk",
    });
    expect(useSessionStore.getState().sessions[0].encoding).toBe("gbk");
    void id;
  });

  it("setSessionEncoding：状态即变 + 已连接下发 Rust + 残字结算写回终端", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "set_session_encoding"
        ? Promise.resolve("\u{FFFD}") // 模拟切换瞬间的残字结算文本
        : Promise.resolve("pty-1"),
    );
    const store = useSessionStore.getState();
    const id = store.openTab(hostA, { autoConnect: false });
    const writes: Uint8Array[] = [];
    registerSink(id, {
      write: (b) => writes.push(b),
      getSize: () => ({ cols: 80, rows: 24 }),
    });
    // 未连接：只记状态，不 invoke
    store.setSessionEncoding(id, "gbk");
    expect(useSessionStore.getState().sessions[0].encoding).toBe("gbk");
    expect(mockedInvoke).not.toHaveBeenCalledWith("set_session_encoding", expect.anything());

    markConnected(id, "pty-1");
    store.setSessionEncoding(id, "gb18030");
    expect(mockedInvoke).toHaveBeenCalledWith("set_session_encoding", {
      id: "pty-1",
      encoding: "gb18030",
    });
    await vi.advanceTimersByTimeAsync(0);
    // 残字结算文本写回终端 sink
    expect(writes.map((w) => new TextDecoder().decode(w))).toEqual(["\u{FFFD}"]);
    unregisterSink(id);
  });

  it("onEncodingHint：按 rustId 反查；非 utf-8 编码不提示", () => {
    mockedInvoke.mockResolvedValue("");
    const store = useSessionStore.getState();
    const id = store.openTab(hostA, { autoConnect: false });
    markConnected(id, "pty-h");
    useSessionStore.getState().onEncodingHint({ id: "pty-h", encoding: "gbk" });
    expect(useSessionStore.getState().sessions[0].encodingHint).toBe("gbk");

    // 已切 GBK 后再来的提示被忽略
    useSessionStore.getState().setSessionEncoding(id, "gbk");
    useSessionStore.getState().onEncodingHint({ id: "pty-h", encoding: "gbk" });
    expect(useSessionStore.getState().sessions[0].encodingHint).toBeNull();

    // 未知 rustId 忽略
    useSessionStore.getState().onEncodingHint({ id: "pty-ghost", encoding: "gbk" });
    expect(useSessionStore.getState().sessions).toHaveLength(1);
  });

  it("accept：切编码 + 同 host 记一次性可关；dismiss：只记不再提示", () => {
    mockedInvoke.mockResolvedValue("");
    const store = useSessionStore.getState();
    const id = store.openTab(hostA, { autoConnect: false });
    markConnected(id, "pty-a");
    useSessionStore.getState().onEncodingHint({ id: "pty-a", encoding: "gbk" });

    useSessionStore.getState().acceptEncodingHint(id);
    expect(useSessionStore.getState().sessions[0].encoding).toBe("gbk");
    expect(useSessionStore.getState().sessions[0].encodingHint).toBeNull();
    expect(JSON.parse(localStorage.getItem("ottr.encoding.hintDismissed") ?? "[]")).toEqual([1]);
    expect(mockedInvoke).toHaveBeenCalledWith("set_session_encoding", {
      id: "pty-a",
      encoding: "gbk",
    });

    // 同 host 重连后再来提示 → 已记「不再提示」，不再弹
    useSessionStore.getState().onEncodingHint({ id: "pty-a", encoding: "gbk" });
    expect(useSessionStore.getState().sessions[0].encodingHint).toBeNull();

    // dismiss 路径：另一个 host
    const id2 = useSessionStore.getState().openTab(hostB, { autoConnect: false });
    markConnected(id2, "pty-b");
    useSessionStore.getState().onEncodingHint({ id: "pty-b", encoding: "gbk" });
    useSessionStore.getState().dismissEncodingHint(id2);
    expect(useSessionStore.getState().sessions[1].encodingHint).toBeNull();
    expect(useSessionStore.getState().sessions[1].encoding).toBe("utf-8");
    expect(
      JSON.parse(localStorage.getItem("ottr.encoding.hintDismissed") ?? "[]").sort(),
    ).toEqual([1, 2]);
  });
});

// act 兼容 shim（store 直驱时其实不需要 React act；保留直接调用形式）
function act<T>(fn: () => T): T {
  return fn();
}
