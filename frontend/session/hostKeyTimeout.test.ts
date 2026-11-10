// host-key 问询两层生命周期测试（2026-11-11 审计，kbd-interactive 超时/并发
// 队列同族）：Rust 侧 60s 超时摘槽 + `ottr://host-key-timeout`，前端侧并发
// hostKeyAsk 队列。钉住五件事：
// 1. 并发 host-key-ask 排队逐个展示，不互相顶掉（原单槽覆盖 = 第一条 UI 永久
//    消失、其会话卡到 Rust 超时）；
// 2. 超时事件 → 关弹窗 + 会话记真因（未裁定），随后的连接失败不盖掉真因；
// 3. 显示中/队列里的问询都能被超时事件归位，迟到的超时通知忽略；
// 4. 关标签：显示中与队列里属于被关会话的问询回拒绝，幸存队头接棒弹窗；
// 5. 裁定后队头接棒，弹窗槽不空转。
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
  HOST_KEY_TIMEOUT_MARKER,
  isHostKeyTimeout,
  useSessionStore,
  type HostKeyAsk,
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
const hostB: Host = { ...hostA, id: 2, name: "db-01", address: "10.0.0.2" };

const mockedInvoke = invoke as unknown as Mock;

function seedSession(id: string, host: Host, status: Session["status"] = "connecting"): Session {
  const session: Session = {
    id,
    kind: "ssh",
    hostId: host.id,
    hostName: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    protocol: "ssh",
    jumpChainId: null,
    status,
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
  useSessionStore.setState((st) => ({ sessions: [...st.sessions, session], activeId: id }));
  return session;
}

function seedAsk(ask: HostKeyAsk): void {
  useSessionStore.setState({ hostKeyAsk: ask });
  useModalStore.setState({ active: "hostKey" });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(null);
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    hostKeyAsk: null,
    hostKeyAskQueue: [],
  });
  useModalStore.setState({ active: null });
});

afterEach(() => {
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    hostKeyAsk: null,
    hostKeyAskQueue: [],
  });
  useModalStore.setState({ active: null });
});

describe("并发 host-key 问询（队列）", () => {
  it("两个标签同时首连：第二条排队不顶掉第一条；逐个裁定后队头接棒", async () => {
    vi.useFakeTimers();
    try {
      mockedInvoke.mockImplementation((cmd: string) =>
        cmd === "attach_host_session" ? new Promise(() => {}) : Promise.resolve(null),
      );
      const idA = useSessionStore.getState().openTab(hostA);
      const idB = useSessionStore.getState().openTab(hostB);
      await vi.advanceTimersByTimeAsync(0);

      useSessionStore.getState().onHostKeyAsk({
        host_id: 1,
        host_name: "bastion-a",
        fingerprint: "SHA256:abc",
        kind: "first",
      });
      useSessionStore.getState().onHostKeyAsk({
        host_id: 2,
        host_name: "db-01",
        fingerprint: "SHA256:def",
        kind: "first",
      });

      // 第一条显示、第二条排队；两个会话都进 waiting_host_key。
      const st = useSessionStore.getState();
      expect(st.hostKeyAsk).toMatchObject({ fingerprint: "SHA256:abc", sessionId: idA });
      expect(st.hostKeyAskQueue).toEqual([
        expect.objectContaining({ fingerprint: "SHA256:def", sessionId: idB }),
      ]);
      expect(st.sessions.map((s) => s.status)).toEqual(["waiting_host_key", "waiting_host_key"]);
      expect(useModalStore.getState().active).toBe("hostKey");

      // 裁定第一条 → 队头接棒显示（弹窗槽不空转）。
      await useSessionStore.getState().decideHostKey(true);
      expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
        hostId: 1,
        fingerprint: "SHA256:abc",
        accept: true,
      });
      expect(useSessionStore.getState().hostKeyAsk).toMatchObject({
        fingerprint: "SHA256:def",
        sessionId: idB,
      });
      expect(useSessionStore.getState().hostKeyAskQueue).toEqual([]);
      expect(useModalStore.getState().active).toBe("hostKey");

      // 裁定第二条 → 槽清空、弹窗关闭。
      await useSessionStore.getState().decideHostKey(true);
      expect(mockedInvoke).toHaveBeenCalledWith("host_key_decision", {
        hostId: 2,
        fingerprint: "SHA256:def",
        accept: true,
      });
      expect(useSessionStore.getState().hostKeyAsk).toBeNull();
      expect(useModalStore.getState().active).not.toBe("hostKey");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("host-key 确认框超时（ottr://host-key-timeout）", () => {
  it("显示中的问询超时 → 关弹窗 + 会话记真因（未裁定）", () => {
    seedSession("tab-1", hostA, "waiting_host_key");
    seedAsk({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:abc",
      kind: "first",
      sessionId: "tab-1",
    });
    useSessionStore.getState().onHostKeyTimeout({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:abc",
      seconds: 60,
    });
    // 弹窗关闭（模态槽也释放）
    expect(useSessionStore.getState().hostKeyAsk).toBeNull();
    expect(useModalStore.getState().active).not.toBe("hostKey");
    // 会话：断开 + 错误面是真因标记（不是 "host key rejected" 症状）
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe("disconnected");
    expect(isHostKeyTimeout(s.lastError ?? "")).toBe(true);
    expect(s.lastError).toBe(HOST_KEY_TIMEOUT_MARKER);
  });

  it("队列里的问询超时 → 从队列摘掉 + 它的会话记真因；显示中的问询不受影响", () => {
    seedSession("tab-1", hostA, "waiting_host_key");
    seedSession("tab-2", hostB, "waiting_host_key");
    seedAsk({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:abc",
      kind: "first",
      sessionId: "tab-1",
    });
    useSessionStore.setState({
      hostKeyAskQueue: [
        {
          host_id: 2,
          host_name: "db-01",
          fingerprint: "SHA256:def",
          kind: "first",
          sessionId: "tab-2",
        },
      ],
    });
    useSessionStore.getState().onHostKeyTimeout({
      host_id: 2,
      host_name: "db-01",
      fingerprint: "SHA256:def",
      seconds: 60,
    });
    const st = useSessionStore.getState();
    expect(st.hostKeyAsk?.fingerprint).toBe("SHA256:abc"); // 显示中的不动
    expect(st.hostKeyAskQueue).toEqual([]);
    expect(useModalStore.getState().active).toBe("hostKey"); // 弹窗不受影响
    expect(st.sessions[0].status).toBe("waiting_host_key"); // tab-1 不受影响
    expect(st.sessions[1].status).toBe("disconnected"); // tab-2 记真因
    expect(isHostKeyTimeout(st.sessions[1].lastError ?? "")).toBe(true);
  });

  it("迟到的超时通知（host_id/fingerprint 不匹配）→ 忽略，不动当前弹窗", () => {
    seedSession("tab-1", hostA, "waiting_host_key");
    seedAsk({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:abc",
      kind: "first",
      sessionId: "tab-1",
    });
    useSessionStore.getState().onHostKeyTimeout({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:other", // 另一个问询
      seconds: 60,
    });
    expect(useSessionStore.getState().hostKeyAsk?.fingerprint).toBe("SHA256:abc");
    expect(useModalStore.getState().active).toBe("hostKey");
    expect(useSessionStore.getState().sessions[0].status).toBe("waiting_host_key");
  });

  it("孤儿问询（sessionId 空哨兵）超时 → 关弹窗，无会话动作", () => {
    useSessionStore.getState().onHostKeyAsk({
      host_id: 3,
      host_name: "cache-01",
      fingerprint: "SHA256:t",
      kind: "pending",
    });
    expect(useSessionStore.getState().hostKeyAsk).toMatchObject({ sessionId: "" });
    useSessionStore.getState().onHostKeyTimeout({
      host_id: 3,
      host_name: "cache-01",
      fingerprint: "SHA256:t",
      seconds: 60,
    });
    expect(useSessionStore.getState().hostKeyAsk).toBeNull();
    expect(useModalStore.getState().active).not.toBe("hostKey");
  });

  it("随后到达的连接失败（host key rejected 症状）不得盖掉「未裁定」真因", async () => {
    vi.useFakeTimers();
    try {
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
      // 真因先到：超时事件把「未裁定」落进错误面
      useSessionStore.getState().onHostKeyAsk({
        host_id: 1,
        host_name: "bastion-a",
        fingerprint: "SHA256:abc",
        kind: "first",
      });
      useSessionStore.getState().onHostKeyTimeout({
        host_id: 1,
        host_name: "bastion-a",
        fingerprint: "SHA256:abc",
        seconds: 60,
      });
      // 症状后到：连接失败（Rust 侧超时按拒绝收尾 → HostKeyRejected）
      rejectAttach(new Error("host key rejected by policy (server fingerprint: SHA256:abc)"));
      await vi.advanceTimersByTimeAsync(0);
      const s = useSessionStore.getState().sessions.find((x) => x.id === id)!;
      // 真因保住（渲染面据此说人话），而不是被症状盖掉
      expect(isHostKeyTimeout(s.lastError ?? "")).toBe(true);
      expect(s.lastError).not.toContain("host key rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("关标签的 host-key 队列收尾", () => {
  it("显示中与队列里属于被关会话的问询回拒绝；幸存队头接棒弹窗", async () => {
    seedSession("tab-1", hostA);
    seedSession("tab-2", hostB);
    seedAsk({
      host_id: 1,
      host_name: "bastion-a",
      fingerprint: "SHA256:abc",
      kind: "first",
      sessionId: "tab-1",
    });
    useSessionStore.setState({
      hostKeyAskQueue: [
        {
          host_id: 2,
          host_name: "db-01",
          fingerprint: "SHA256:def",
          kind: "first",
          sessionId: "tab-2",
        },
        {
          host_id: 1,
          host_name: "bastion-a",
          fingerprint: "SHA256:abc2",
          kind: "pending",
          sessionId: "tab-1",
        },
      ],
    });

    useSessionStore.getState().closeTab("tab-1");

    // tab-1 的两条问询（显示中 abc + 队列里 abc2）都同步回拒绝，别让 Rust 白挂 60s。
    const declines = (mockedInvoke.mock.calls as Array<[string, Record<string, unknown>]>).filter(
      ([cmd, args]) => cmd === "host_key_decision" && args.accept === false,
    );
    expect(declines).toEqual([
      ["host_key_decision", { hostId: 1, fingerprint: "SHA256:abc", accept: false }],
      ["host_key_decision", { hostId: 1, fingerprint: "SHA256:abc2", accept: false }],
    ]);
    // 幸存会话的问询接棒显示（tab-2 仍在等裁定）。
    const st = useSessionStore.getState();
    expect(st.hostKeyAsk).toMatchObject({ fingerprint: "SHA256:def", sessionId: "tab-2" });
    expect(st.hostKeyAskQueue).toEqual([]);
    expect(useModalStore.getState().active).toBe("hostKey");
  });
});
