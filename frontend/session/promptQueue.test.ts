// 交互式认证**并发问询**的归属与不丢测试（2026-11-02 审计）。
//
// 场景：同一主机开两个标签（或分屏 pane + 根标签同主机）→ 两个会话各自进入
// 认证 → Rust 侧先后下发两个问询。弹窗是模态唯一槽（一次只能显示一个），
// 但两个问询**都不能丢**：
//   * 后来的问询不能把前者的 ask_id 顶掉（否则前者的超时事件找不到归属，
//     「未作答」这个真因丢失，用户只看到无信息量的「认证被服务端拒绝」）；
//   * 作答完第一个，第二个要自动顶上；
//   * 归属要落到**最近发起 connect** 的会话，不能靠数组顺序。
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { useSessionStore, type Session } from "./SessionStore";
import { useModalStore } from "../ui/modalStore";

const mockedInvoke = invoke as unknown as Mock;

function seedSession(id: string, hostId: number): Session {
  return {
    id,
    kind: "ssh",
    hostId,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connecting",
    rustId: null,
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
  };
}

function askPayload(askId: string, hostId = 1) {
  return {
    ask_id: askId,
    host_id: hostId,
    host_name: "web-01",
    credential_id: 42,
    prompts: [{ text: "Verification code:", suggestion: "123456" }],
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(null);
  useSessionStore.setState({
    sessions: [seedSession("tab-a", 1), seedSession("tab-b", 1)],
    activeId: "tab-a",
    promptAsk: null,
    promptAskQueue: [],
  });
  useModalStore.setState({ active: null });
});

afterEach(() => {
  useSessionStore.setState({ sessions: [], activeId: null, promptAsk: null, promptAskQueue: [] });
  useModalStore.setState({ active: null });
});

describe("交互式认证并发问询", () => {
  it("后到的问询进队列，不覆盖正在显示的问询", () => {
    useSessionStore.getState().onPromptAsk(askPayload("1:1"));
    expect(useSessionStore.getState().promptAsk?.ask_id).toBe("1:1");
    useSessionStore.getState().onPromptAsk(askPayload("1:2"));
    // 显示中的仍是第一个，第二个在队列里
    expect(useSessionStore.getState().promptAsk?.ask_id).toBe("1:1");
    expect(useSessionStore.getState().promptAskQueue.map((a) => a.ask_id)).toEqual(["1:2"]);
  });

  it("队列里的问询超时 → 归到它自己的会话，不影响显示中的弹窗", () => {
    useSessionStore.getState().onPromptAsk(askPayload("1:1"));
    useSessionStore.getState().onPromptAsk(askPayload("1:2"));
    const queued = useSessionStore.getState().promptAskQueue[0];
    useSessionStore.getState().onPromptTimeout({
      ask_id: "1:2",
      host_id: 1,
      host_name: "web-01",
      seconds: 180,
    });
    // 显示中的弹窗不受影响
    expect(useSessionStore.getState().promptAsk?.ask_id).toBe("1:1");
    expect(useModalStore.getState().active).toBe("promptAsk");
    // 队列里那个被摘掉
    expect(useSessionStore.getState().promptAskQueue).toHaveLength(0);
    // 真因记到它自己的会话
    const s = useSessionStore
      .getState()
      .sessions.find((x) => x.id === queued.sessionId)!;
    expect(s.lastError).toContain("prompt ask timed out");
  });

  it("作答完当前问询 → 队列里的下一个自动顶上", async () => {
    useSessionStore.getState().onPromptAsk(askPayload("1:1"));
    useSessionStore.getState().onPromptAsk(askPayload("1:2"));
    await useSessionStore.getState().answerPrompt(["123456"]);
    expect(useSessionStore.getState().promptAsk?.ask_id).toBe("1:2");
    expect(useModalStore.getState().active).toBe("promptAsk");
    // 第一个已回传给 Rust
    expect(
      mockedInvoke.mock.calls.some(
        ([cmd, args]) =>
          cmd === "kbd_interactive_answer" && (args as { askId: string }).askId === "1:1",
      ),
    ).toBe(true);
  });

  it("两个问询归属到不同会话（同主机多标签）", () => {
    useSessionStore.getState().onPromptAsk(askPayload("1:1"));
    const first = useSessionStore.getState().promptAsk?.sessionId;
    useSessionStore.getState().onPromptAsk(askPayload("1:2"));
    const second = useSessionStore.getState().promptAskQueue[0]?.sessionId;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });
});
