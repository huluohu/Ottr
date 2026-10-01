// 通知管线单测（Task 12 Step 4）：限频聚合同 key 60s、按 kind 静音、事件源
// 分派语义（transfer done 不通知 / session cancelled 不通知）、前台静默、
// 渠道分发点。invoke/listen 全量 mock；时间/焦点/系统通知走 NotifyPorts 假件
// （core.ts 文件头「可测性」），真弹窗不归单测（Phase 0 已知边界，runbook 验证）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const listenHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listenHandlers.set(name, cb);
    return () => listenHandlers.delete(name);
  }),
}));

import i18n from "../i18n";
import {
  MUTED_SETTING_KEY,
  RATE_WINDOW_MS,
  channels,
  disposeNotifyEvents,
  initNotifyEvents,
  notify,
  onSessionClosed,
  onTransferEnd,
  rateKeyOf,
  resetRateLimiter,
  setNotifyPorts,
  useNotifyStore,
  type NotificationEvent,
  type NotifyPorts,
} from "./core";
import type { Notification } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

/** 假端口：时间可控 + 焦点可控 + 系统通知捕获。 */
function makePorts(now: { t: number }, focused = true): NotifyPorts & {
  sent: { title: string; body: string }[];
} {
  const sent: { title: string; body: string }[] = [];
  return {
    now: () => now.t,
    focused: () => focused,
    system: async (title, body) => {
      sent.push({ title, body });
    },
    sent,
  };
}

let ports: ReturnType<typeof makePorts>;
let nextId = 1;

/** 换端口并同步测试句柄（setNotifyPorts 只换模块引用，断言仍走本文件变量）。 */
function usePorts(now: { t: number }, focused = true): void {
  ports = makePorts(now, focused);
  setNotifyPorts(ports);
}

/** notify_insert 回声 mock：回执 = 入参镜像（host_id/severity 断言才有效）。 */
function echoInsert(): void {
  mockedInvoke.mockImplementation(async (_cmd: string, args?: Record<string, unknown>) =>
    rowOf(args!.input as never),
  );
}

/** invoke("notify_insert") 的标准回执。 */
function rowOf(input: {
  kind: string;
  severity: string;
  host_id: number | null;
  title_key: string;
  body: string;
  payload: unknown;
}): Notification {
  return {
    id: nextId++,
    kind: input.kind,
    severity: input.severity as Notification["severity"],
    host_id: input.host_id,
    title_key: input.title_key,
    body: input.body,
    payload: input.payload,
    read: false,
    ts: 1000,
  };
}

function baseEvent(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: "transfer",
    severity: "error",
    host_id: 7,
    title_key: "notify.title.transferFailed",
    body: "/srv/a.tar — boom",
    payload: { transfer_id: "xfer-1" },
    ...over,
  };
}

function resetStore(muted: [] = []) {
  useNotifyStore.setState({ items: [], unread: 0, muted });
  mockedInvoke.mockReset();
  resetRateLimiter();
  nextId = 1;
}

beforeEach(() => {
  resetStore();
  usePorts({ t: 1_000_000 });
});

describe("notify 管线", () => {
  it("放行：①落库进 store（置顶+未读+1）→ ②失焦才发系统通知 → ③渠道分发", async () => {
    // 默认 ports.focused()=true → 前台静默
    echoInsert();
    const seen: NotificationEvent[] = [];
    channels.push({ name: "fake", send: async (e) => void seen.push(e), test: async () => {} });

    const ok = await notify(baseEvent());
    expect(ok).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "notify_insert",
      expect.objectContaining({
        input: expect.objectContaining({ kind: "transfer", severity: "error", host_id: 7 }),
      }),
    );
    const st = useNotifyStore.getState();
    expect(st.items).toHaveLength(1);
    expect(st.unread).toBe(1);
    expect(ports.sent).toHaveLength(0); // 前台静默

    // 失焦 → ②触发：标题走词典键（en-US fallback 渲染），body 透传
    usePorts({ t: 1_000_000 }, false);
    channels.length = 0;
    await notify(baseEvent({ host_id: 8 })); // 换 host 避开限频
    expect(ports.sent).toHaveLength(1);
    expect(ports.sent[0]).toEqual({ title: "Transfer failed", body: "/srv/a.tar — boom" });
    // 首条（前台）已分发过一次；channels 清空后第二条不再进（无新分发）
    expect(seen).toHaveLength(1);
  });

  it("限频聚合同 key 60s：窗口内第二条丢弃（不落表不弹），窗口过期放行并开新窗", async () => {
    echoInsert();
    const clock = { t: 1_000_000 };
    usePorts(clock, false);

    expect(await notify(baseEvent())).toBe(true);
    clock.t += RATE_WINDOW_MS - 1;
    expect(await notify(baseEvent())).toBe(false); // 窗口内聚合
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(ports.sent).toHaveLength(1);
    expect(useNotifyStore.getState().items).toHaveLength(1);

    clock.t += 1;
    expect(await notify(baseEvent())).toBe(true); // 窗口过期放行
    expect(mockedInvoke).toHaveBeenCalledTimes(2);

    // 不同 key 互不聚合：kind 相同 host 不同
    clock.t = 1_000_000;
    resetRateLimiter();
    await notify(baseEvent());
    expect(await notify(baseEvent({ host_id: 9 }))).toBe(true); // 不同 key 不聚合
    expect(rateKeyOf(baseEvent({ host_id: null }))).toBe("transfer:-");
  });

  it("按 kind 静音：管线入口丢弃（settings 读写走 vault settings 键）", async () => {
    useNotifyStore.setState({ muted: ["session"] });
    await notify(baseEvent({ kind: "session" }));
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(ports.sent).toHaveLength(0);
    expect(useNotifyStore.getState().items).toHaveLength(0);

    // 非静音 kind 照常放行
    echoInsert();
    expect(await notify(baseEvent({ kind: "transfer" }))).toBe(true);

    // toggleMuted 持久化到 settings（UI 开关同一 action）
    useNotifyStore.getState().toggleMuted("transfer");
    expect(useNotifyStore.getState().muted).toEqual(["session", "transfer"]);
    expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
      key: MUTED_SETTING_KEY,
      value: ["session", "transfer"],
    });
    useNotifyStore.getState().toggleMuted("transfer");
    expect(useNotifyStore.getState().muted).toEqual(["session"]);
  });

  it("①落库失败不反噬：②③照走（通知链路尽力而为）", async () => {
    mockedInvoke.mockRejectedValue("backend down");
    usePorts({ t: 1_000_000 }, false);
    const seen: NotificationEvent[] = [];
    channels.push({ name: "fake", send: async (e) => void seen.push(e), test: async () => {} });
    const ok = await notify(baseEvent());
    channels.length = 0;
    expect(ok).toBe(true);
    expect(ports.sent).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(useNotifyStore.getState().items).toHaveLength(0);
  });
});

describe("事件源分派（不改事件源，core.ts 订阅富化）", () => {
  it("transfer-end：done 不通知；failed=error、cancelled=warning；host 由 rustId 反查", async () => {
    echoInsert();
    useNotifyStore.setState({
      items: [],
      unread: 0,
      muted: [],
    });
    // TransferStore/SessionStore seed：条目 rustId → 会话 → host
    const { useTransferStore } = await import("../files/TransferStore");
    const { useSessionStore } = await import("../session/SessionStore");
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-9",
          kind: "download",
          remotePath: "/srv/big.tar",
          localPath: "/Downloads/big.tar",
          rustId: "pty-1",
          total: 10,
          transferred: 4,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: 1,
        },
      ],
    });
    useSessionStore.setState({
      sessions: [
        {
          id: "t1",
          hostId: 42,
          hostName: "web-01",
          address: "10.0.0.1",
          port: 22,
          username: "deploy",
          protocol: "ssh",
          status: "connected",
          rustId: "pty-1",
          attempt: 0,
          lastError: null,
          nextRetryAt: null,
          paneOf: null,
          encoding: "utf-8",
          encodingOverride: "utf-8",
          encodingHint: null,
        },
      ],
      activeId: "t1",
    });

    // 成功不通知（噪音裁定）
    expect(await onTransferEnd({ transfer_id: "xfer-9", status: "done", message: "" })).toBe(
      false,
    );

    expect(
      await onTransferEnd({ transfer_id: "xfer-9", status: "failed", message: "disk full" }),
    ).toBe(true);
    let row = useNotifyStore.getState().items[0];
    expect(row.severity).toBe("error");
    expect(row.host_id).toBe(42);
    expect(row.body).toBe("/srv/big.tar — disk full");
    expect(row.payload).toMatchObject({ transfer_id: "xfer-9", status: "failed" });

    // 同 key 连发会被限频聚合：重置窗口后单独驱动 cancelled 分支
    resetRateLimiter();
    expect(
      await onTransferEnd({ transfer_id: "xfer-9", status: "cancelled", message: "" }),
    ).toBe(true);
    row = useNotifyStore.getState().items[0];
    expect(row.severity).toBe("warning");
    expect(row.title_key).toBe("notify.title.transferCancelled");
    expect(row.body).toBe("/srv/big.tar"); // 取消无错误文本：body=远端路径
  });

  it("session-closed：cancelled（主动）不通知；closed/ipc_failed 通知；未知会话静默", async () => {
    echoInsert();
    const { useSessionStore } = await import("../session/SessionStore");
    useSessionStore.setState({
      sessions: [
        {
          id: "t1",
          hostId: 5,
          hostName: "db-01",
          address: "10.0.0.2",
          port: 22,
          username: null,
          protocol: "ssh",
          status: "reconnecting",
          rustId: null,
          attempt: 1,
          lastError: null,
          nextRetryAt: null,
          paneOf: null,
          encoding: "utf-8",
          encodingOverride: "utf-8",
          encodingHint: null,
        },
        {
          id: "t2",
          hostId: 6,
          hostName: "cache-01",
          address: "10.0.0.3",
          port: 22,
          username: null,
          protocol: "ssh",
          status: "reconnecting",
          rustId: "pty-7",
          attempt: 1,
          lastError: null,
          nextRetryAt: null,
          paneOf: null,
          encoding: "utf-8",
          encodingOverride: "utf-8",
          encodingHint: null,
        },
      ],
      activeId: "t2",
    });

    expect(await onSessionClosed({ id: "pty-7", reason: "cancelled" })).toBe(false);
    expect(await onSessionClosed({ id: "pty-none", reason: "closed" })).toBe(false);

    expect(await onSessionClosed({ id: "pty-7", reason: "closed" })).toBe(true);
    const row = useNotifyStore.getState().items[0];
    expect(row.kind).toBe("session");
    expect(row.host_id).toBe(6);
    expect(row.body).toBe("cache-01");
    expect(row.title_key).toBe("notify.title.sessionLost");

    // 同 key 连发会被限频聚合：重置窗口后驱动 ipc_failed 同样放行
    resetRateLimiter();
    expect(await onSessionClosed({ id: "pty-7", reason: "ipc_failed" })).toBe(true);
  });

  it("initNotifyEvents：注册 transfer-end/session-closed 监听并拉初始态（幂等）", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "notify_list") return [];
      if (cmd === "notify_unread_count") return 3;
      if (cmd === "settings_get") return null;
      throw new Error(`unexpected: ${cmd}`);
    });
    await initNotifyEvents();
    expect(listenHandlers.has("ottr://transfer-end")).toBe(true);
    expect(listenHandlers.has("ottr://session-closed")).toBe(true);
    expect(useNotifyStore.getState().unread).toBe(3);
    // 幂等：二次调用不重复注册
    await initNotifyEvents();
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "notify_list")).toHaveLength(1);

    // 事件 → 分派链路直通（done 不产生任何调用）
    const callsBefore = mockedInvoke.mock.calls.length;
    listenHandlers.get("ottr://transfer-end")!({
      payload: { transfer_id: "x", status: "done", message: "" },
    });
    await Promise.resolve();
    expect(mockedInvoke.mock.calls.length).toBe(callsBefore);
    disposeNotifyEvents();
  });

  it("系统通知标题走 i18n 当前语言（zh-CN 渲染词典键）", async () => {
    echoInsert();
    usePorts({ t: 1_000_000 }, false);
    await i18n.changeLanguage("zh-CN");
    await notify(baseEvent());
    expect(ports.sent[0].title).toBe("传输失败");
    // 复位（其余测试按 en-US fallback 断言；i18n 单例跨测试共享）
    await i18n.changeLanguage("en-US");
  });
});
