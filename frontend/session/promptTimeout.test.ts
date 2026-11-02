// 交互式认证「未作答」超时路径测试（2026-11-02）。
//
// 钉住三件事：
// 1. Rust 侧问询等满时限 → 发 `ottr://kbd-interactive-timeout` → 前端**关掉
//    弹窗**（别让用户对着一个已经不会有人听的输入框敲码），并把**真因**
//    （未作答）记到会话错误面；
// 2. 随后的连接失败（"authentication rejected by server" 这种症状）**不得**
//    盖掉真因；
// 3. 用户在槽位失效后才提交 → 记「未作答」，而不是把 Rust 内部报错
//    （"no pending prompt ask for 7:1 …"）直接甩给用户看。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  // store 建 attach 通道要用 Channel（真后端由 Tauri 提供）
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import {
  PROMPT_TIMEOUT_MARKER,
  isPromptTimeout,
  useSessionStore,
  type Session,
} from "./SessionStore";
import { useModalStore } from "../ui/modalStore";
import type { Host } from "../vault/api";

const hostA: Host = {
  id: 1,
  name: "bastion-a",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  protocol: "ssh",
  credential_id: 7,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

const mockedInvoke = invoke as unknown as Mock;

function seedSession(id = "tab-1"): Session {
  const session: Session = {
    id,
    kind: "ssh",
    hostId: 1,
    hostName: "bastion-a",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "waiting_prompt",
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
  useSessionStore.setState({ sessions: [session], activeId: id });
  return session;
}

function seedAsk(askId = "1:7") {
  useSessionStore.setState({
    promptAsk: {
      ask_id: askId,
      host_id: 1,
      host_name: "bastion-a",
      credential_id: 42,
      prompts: [{ text: "Verification code:", suggestion: "123456", suggestion_expires_in: 12 }],
      sessionId: "tab-1",
    },
  });
  useModalStore.setState({ active: "promptAsk" });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(null);
  useSessionStore.setState({ sessions: [], activeId: null, promptAsk: null });
  useModalStore.setState({ active: null });
});

afterEach(() => {
  useSessionStore.setState({ sessions: [], activeId: null, promptAsk: null });
  useModalStore.setState({ active: null });
});

describe("交互式认证问询的会话归属", () => {
  it("TOFU 接受后（状态仍 waiting_host_key）来的问询 → 归属到会话，不当孤儿", () => {
    // 真机 192.168.9.102 实测（2026-11-02）：TOFU 接受后状态**不复位**
    // （decideHostKey 注释明说），紧接着的交互式认证问询若只认 "connecting"
    // 就会被误判成孤儿 → 会话不进 waiting_prompt → attach 看门狗 100s 后
    // 误报「后端无响应」，而用户明明在答题。
    const s = seedSession();
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((x) =>
        x.id === s.id ? { ...x, status: "waiting_host_key" } : x,
      ),
    }));
    useSessionStore.getState().onPromptAsk({
      ask_id: "1:7",
      host_id: 1,
      host_name: "bastion-a",
      credential_id: 42,
      prompts: [{ text: "Verification code:", suggestion: "123456" }],
    });
    const st = useSessionStore.getState();
    expect(st.promptAsk?.sessionId).toBe("tab-1");
    expect(st.sessions[0].status).toBe("waiting_prompt");
  });

  it("直连（connecting）来的问询 → 同样归属到会话", () => {
    const s = seedSession();
    useSessionStore.setState((st) => ({
      sessions: st.sessions.map((x) =>
        x.id === s.id ? { ...x, status: "connecting" } : x,
      ),
    }));
    useSessionStore.getState().onPromptAsk({
      ask_id: "1:7",
      host_id: 1,
      host_name: "bastion-a",
      credential_id: 42,
      prompts: [{ text: "Verification code:", suggestion: "123456" }],
    });
    const st = useSessionStore.getState();
    expect(st.promptAsk?.sessionId).toBe("tab-1");
    expect(st.sessions[0].status).toBe("waiting_prompt");
  });
});

describe("交互式认证未作答（超时）", () => {
  it("超时通知 → 关弹窗 + 会话记真因（未作答）", () => {
    seedSession();
    seedAsk("1:7");
    useSessionStore.getState().onPromptTimeout({
      ask_id: "1:7",
      host_id: 1,
      host_name: "bastion-a",
      seconds: 180,
    });
    // 弹窗关闭（模态槽也释放）
    expect(useSessionStore.getState().promptAsk).toBeNull();
    expect(useModalStore.getState().active).not.toBe("promptAsk");
    // 会话：断开 + 错误面是「未作答」标记（不是原始 Rust 报错）
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe("disconnected");
    expect(isPromptTimeout(s.lastError ?? "")).toBe(true);
  });

  it("迟到的超时通知（ask_id 不匹配）→ 忽略，不动当前弹窗", () => {
    seedSession();
    seedAsk("1:7");
    useSessionStore.getState().onPromptTimeout({
      ask_id: "1:8", // 另一个问询
      host_id: 1,
      host_name: "bastion-a",
      seconds: 180,
    });
    expect(useSessionStore.getState().promptAsk?.ask_id).toBe("1:7");
    expect(useModalStore.getState().active).toBe("promptAsk");
    expect(useSessionStore.getState().sessions[0].status).toBe("waiting_prompt");
  });

  it("随后到达的连接失败不得盖掉「未作答」真因", async () => {
    vi.useFakeTimers();
    try {
      // attach 挂起，等我们先落下真因再让它失败（复现真实时序：
      // 超时通知先到，连接失败后到）
      let rejectAttach: (e: Error) => void = () => {};
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === "attach_host_session") {
          return new Promise((_res, rej) => {
            rejectAttach = rej;
          });
        }
        return Promise.resolve(null);
      });
      const id = useSessionStore.getState().openTab(hostA);
      await vi.advanceTimersByTimeAsync(0);
      // 真因先到：会话错误面记「未作答」
      useSessionStore.setState((st) => ({
        sessions: st.sessions.map((s) =>
          s.id === id ? { ...s, lastError: PROMPT_TIMEOUT_MARKER } : s,
        ),
      }));
      // 症状后到：连接失败（服务端拒绝认证）
      rejectAttach(new Error("authentication rejected by server"));
      await vi.advanceTimersByTimeAsync(0);
      const s = useSessionStore.getState().sessions.find((x) => x.id === id)!;
      // 真因保住（渲染面据此说人话），而不是被症状盖掉
      expect(isPromptTimeout(s.lastError ?? "")).toBe(true);
      expect(s.lastError).not.toContain("authentication rejected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("槽位失效后才提交 → 记「未作答」而非 Rust 内部报错串", async () => {
    seedSession();
    seedAsk("1:7");
    mockedInvoke.mockRejectedValue(
      new Error("no pending prompt ask for 1:7 (expired or already answered)"),
    );
    await useSessionStore.getState().answerPrompt(["123456"]);
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe("disconnected");
    expect(isPromptTimeout(s.lastError ?? "")).toBe(true);
    expect(s.lastError).not.toContain("no pending prompt ask");
  });
});
