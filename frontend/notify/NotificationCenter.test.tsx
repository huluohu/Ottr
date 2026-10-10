// NotificationCenter 组件测试（Task 12 Step 4）：红点未读数、面板列表/已读/
// 全部已读/清空、按 kind 静音开关、空态。直接 seed useNotifyStore（store 单测
// 在 core.test.ts）；invoke 全量 mock（真后端已接线，命令断言走 invoke 面）。
// 注意：打开面板即 refresh 对齐真源（core.ts 语义）——seed 数据必须同步进
// mock 后端（seedBackend），否则刷新会用 mock 空值覆盖本地态。
// Phase 5 T1（BL-517）：投递失败块（状态+渠道+错误）+ 手动重发按钮——失败
// 标记经 recordDeliveryFailure 入账（账本才是 refresh 重贴的真源，直塞 payload
// 会被 refresh 剥掉）；重发走 mock 的 channelRegistry.resendNotification。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./channelRegistry", () => ({ resendNotification: vi.fn() }));

import "../i18n";
import { NotificationCenter } from "./NotificationCenter";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import {
  clearDeliveryFailure,
  recordDeliveryFailure,
  resetDeliveryLedger,
  useNotifyStore,
  type NotifyKind,
} from "./core";
import { resendNotification } from "./channelRegistry";
import type { Notification } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;
const mockedResend = resendNotification as unknown as Mock;

function row(over: Partial<Notification> = {}): Notification {
  return {
    id: 1,
    kind: "transfer",
    severity: "error",
    host_id: null,
    title_key: "notify.title.transferFailed",
    body: "/srv/a.tar — boom",
    payload: null,
    read: false,
    ts: 1759084800, // 2025-09-29（确定性时间；时间文案不在断言面）
    delivery_failures: null,
    ...over,
  };
}

/** seed 本地 store + **有状态** mock 后端（list/unread_count 反映写命令的效果
 * ——打开面板的 refresh 会以真源覆盖本地态，mock 后端必须像 Rust 表一样记账，
 * 否则 refresh 会把 mark_read/clear 的本地变更冲回去）。 */
function seedBackend(items: Notification[], unread: number, muted: NotifyKind[] = []) {
  useNotifyStore.setState({ items, unread, muted });
  const data = { items, unread, muted };
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "notify_list":
        return data.items;
      case "notify_unread_count":
        return data.unread;
      case "settings_get":
        return data.muted;
      case "notify_mark_read": {
        const id = args?.id as number | null;
        data.items =
          id === null
            ? data.items.map((n) => ({ ...n, read: true }))
            : data.items.map((n) => (n.id === id ? { ...n, read: true } : n));
        data.unread = data.items.filter((n) => !n.read).length;
        return 1;
      }
      case "notify_clear": {
        const removed = data.items.length;
        data.items = [];
        data.unread = 0;
        return removed;
      }
      case "notify_mark_delivery_failed": {
        // BL-530 写穿：按渠道记账进行的 delivery_failures（refresh 真源同步）
        const id = args?.id as number;
        const f = args?.failure as { channel: string; channel_id: number | null; error: string; ts: number };
        data.items = data.items.map((n) => {
          if (n.id !== id) return n;
          const list = (n.delivery_failures ?? []).filter((x) => x.channel !== f.channel);
          return { ...n, delivery_failures: [...list, f] };
        });
        return { id, delivery_failures: data.items.find((n) => n.id === id)?.delivery_failures ?? null };
      }
      case "notify_clear_delivery_failure": {
        const id = args?.id as number;
        const channel = args?.channel as string;
        data.items = data.items.map((n) => {
          if (n.id !== id) return n;
          const list = (n.delivery_failures ?? []).filter((x) => x.channel !== channel);
          return { ...n, delivery_failures: list.length > 0 ? list : null };
        });
        return { id, delivery_failures: data.items.find((n) => n.id === id)?.delivery_failures ?? null };
      }
      case "settings_set":
        return undefined;
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  resetDeliveryLedger();
  mockedResend.mockReset();
  useWorkspaceStore.setState({ dockTabs: [], dockActive: null });
  seedBackend([], 0);
});

afterEach(() => {
  cleanup();
});

/** 打开面板并**等 refresh 的 set 落地**（list invoke 计数 + 一个宏任务 tick——
 * set 在 invoke 之后的下一微任务）。挂载与挂载之间的 refresh 微任务若不先落定，
 * 会用 mock 真源覆盖行点击的本地乐观变更——生产里 refresh 早已完成，这是测试
 * 时序伪影，不是管线缺陷。受控化后（铃铛移除）open=重挂组件驱动 open effect。 */
async function openPanel() {
  const before = mockedInvoke.mock.calls.filter(([c]) => c === "notify_list").length;
  cleanup();
  renderPanel();
  await waitFor(() =>
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "notify_list").length).toBeGreaterThan(
      before,
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
}

/** 渲染面板（2026-10-09 dock 页签形态：组件恒渲染，无 open/onClose）。 */
function renderPanel() {
  return render(<NotificationCenter />);
}

describe("NotificationCenter（铃铛 + 面板）", () => {
  it("未读数同步进原生菜单（menu_set_notify_count；铃铛已移除）", async () => {
    // invoke 门卫（IS_TAURI）：jsdom 伪造运行时标记放行（先例 VaultInitGate.test）。
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderPanel();
    seedBackend([row(), row({ id: 2 }), row({ id: 3 })], 3);
    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.some(
          ([c, a]) => c === "menu_set_notify_count" && (a as { unread: number }).unread === 3,
        ),
      ).toBe(true);
    });
  });

  it("面板：列表渲染（标题走词典键 + severity 标记 + 未读态），点单条已读", async () => {
    seedBackend(
      [
        row({ id: 11, read: false }),
        row({
          id: 12,
          severity: "warning",
          read: true,
          title_key: "notify.title.sessionLost",
          body: "web-01",
        }),
      ],
      1,
    );
    const items = [
      row({ id: 11, read: false }),
      row({
        id: 12,
        severity: "warning",
        read: true,
        title_key: "notify.title.sessionLost",
        body: "web-01",
      }),
    ];
    seedBackend(items, 1);
    await openPanel();
    expect(screen.getByTestId("notify-panel")).toBeTruthy();
    expect(screen.getByTestId("notify-item-11").textContent).toContain("Transfer failed");
    expect(screen.getByTestId("notify-item-11").textContent).toContain("/srv/a.tar — boom");
    expect(screen.getByTestId("notify-item-11").getAttribute("data-severity")).toBe("error");
    expect(screen.getByTestId("notify-item-11").getAttribute("data-read")).toBe("false");
    expect(screen.getByTestId("notify-item-12").getAttribute("data-severity")).toBe("warning");
    expect(screen.getByTestId("notify-item-12").textContent).toContain("Connection lost");

    fireEvent.click(screen.getByTestId("notify-item-11"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("notify_mark_read", { id: 11 }),
    );
    expect(screen.getByTestId("notify-item-11").getAttribute("data-read")).toBe("true");
    expect(useNotifyStore.getState().unread).toBe(0); // 本地未读数同步递减
    // 已读行再点不再发命令（语义断言：id=11 的 mark_read 恒 1 次——总计数跨
    // 用例有污染面，只有语义计数是这条守卫的真命题）
    const reads11 = () =>
      mockedInvoke.mock.calls.filter(
        ([c, a]) => c === "notify_mark_read" && (a as { id: number }).id === 11,
      ).length;
    fireEvent.click(screen.getByTestId("notify-item-11"));
    expect(reads11()).toBe(1);
  });

  it("全部已读：unread>0 才可用，发 notify_mark_read(id=null) 并清零", async () => {
    const items = [row({ id: 1 }), row({ id: 2, read: true })];
    seedBackend(items, 1);
    renderPanel();
    await openPanel();
    const btn = screen.getByTestId("notify-mark-all") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("notify_mark_read", { id: null }),
    );
    expect(useNotifyStore.getState().unread).toBe(0);
    expect(
      (screen.getByTestId("notify-mark-all") as HTMLButtonElement).disabled,
      "清零后按钮禁用",
    ).toBe(true);
  });

  it("清空：发 notify_clear 并清空列表；空表禁用", async () => {
    const items = [row({ id: 1 })];
    seedBackend(items, 1);
    renderPanel();
    await openPanel();
    const btn = screen.getByTestId("notify-clear") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("notify_clear"));
    expect(useNotifyStore.getState().items).toHaveLength(0);
    expect(useNotifyStore.getState().unread).toBe(0);
    expect((screen.getByTestId("notify-clear") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("notify-empty").textContent).toContain("No notifications");
  });

  it("按 kind 静音：勾选即写 settings 并入 muted 集；已静音的 kind 勾选态回显", async () => {
    seedBackend([], 0, ["session"]);
    renderPanel();
    await openPanel();
    const sessionBox = screen.getByTestId("notify-mute-session") as HTMLInputElement;
    expect(sessionBox.checked).toBe(true);

    fireEvent.click(screen.getByTestId("notify-mute-transfer"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "notify.muted_kinds",
        value: ["session", "transfer"],
      }),
    );
    expect(useNotifyStore.getState().muted).toEqual(["session", "transfer"]);
  });

  it("空态：无通知时显示空态文案；打开面板触发 refresh 对齐真源（list+unread）", async () => {
    renderPanel();
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("notify_list", { limit: 200 }),
    );
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("notify_unread_count"));
    expect(screen.getByTestId("notify-empty").textContent).toContain("No notifications");

    // 后端出现新行：重开面板（关→开）对齐真源
    seedBackend([row({ id: 9 })], 1);
    await openPanel();
    await waitFor(() => expect(screen.getByTestId("notify-item-9")).toBeTruthy());
  });
});

// ui-batch2 Task 3（审计 A4 清偿；2026-10-09 dock 多页签语义更新）：空态引导
// 「查看告警规则」= openDock("alerts") 切 dock 页签——通知面板不关闭（keep-
// alive 隐藏），导航即达不再有「收起」概念。
describe("通知空态引导（ui2 T3，审计 A4）", () => {
  it("空态：引导块 + 查看告警规则按钮；点击切换 dock 至告警页签", async () => {
    renderPanel();
    await openPanel();
    expect(useWorkspaceStore.getState().dockTabs).toEqual([]);
    expect(screen.getByTestId("notify-empty-guide")).toBeTruthy();
    // 空态判定不变：notify-empty 文案原样保留在引导块内
    expect(screen.getByTestId("notify-empty").textContent).toContain("No notifications");

    fireEvent.click(screen.getByTestId("notify-empty-alerts"));
    expect(useWorkspaceStore.getState().dockActive).toBe("alerts");
    expect(useWorkspaceStore.getState().dockTabs).toEqual(["alerts"]);
  });

  it("非空列表不渲染引导块（空态判定不变）", async () => {
    seedBackend([row({ id: 31 })], 1);
    renderPanel();
    await openPanel();
    expect(screen.queryByTestId("notify-empty-guide")).toBeNull();
    expect(screen.queryByTestId("notify-empty-alerts")).toBeNull();
  });
});

describe("投递失败面（Phase 5 T1，BL-517）：失败块 + 手动重发", () => {
  const failure = { channel: "slack#3", channel_id: 3, error: "HTTP 502: bad gateway", ts: 1759084800 };

  /** seed 一条带投递失败账的条目（账本入账 + BL-530 写穿落库——refresh 真源
   * 同步记账，见 seedBackend 的 notify_mark_delivery_failed 分支）。 */
  async function seedFailed(id: number) {
    seedBackend([row({ id, payload: { transfer_id: "xfer-1" } })], 1);
    await recordDeliveryFailure(id, failure);
  }

  it("失败块渲染：状态标签 + 渠道名 + 错误摘要；refresh 重贴后仍在", async () => {
    await seedFailed(21);
    renderPanel();
    await openPanel();
    const block = screen.getByTestId("notify-dlv-21");
    expect(block.textContent).toContain("Delivery failed");
    expect(block.textContent).toContain("Slack"); // 渠道名走 alert.kind 词典
    expect(block.textContent).toContain("HTTP 502: bad gateway");
    const btn = screen.getByTestId("notify-resend-21") as HTMLButtonElement;
    expect(btn.getAttribute("data-channel")).toBe("slack#3");
    expect(btn.textContent).toBe("Resend");
  });

  it("点击重发 → 调 resendNotification(item, failure)；翻正清账后失败块消失", async () => {
    await seedFailed(21);
    mockedResend.mockImplementation(async (r, f) => {
      // 模拟生产翻正链路：装饰器 onDelivered 缺省回执清账
      await clearDeliveryFailure((r as Notification).id, (f as { channel: string }).channel);
      return true;
    });
    renderPanel();
    await openPanel();
    fireEvent.click(screen.getByTestId("notify-resend-21"));
    await waitFor(() => expect(resendNotification).toHaveBeenCalledTimes(1));
    expect(mockedResend.mock.calls[0][0].id).toBe(21);
    expect(mockedResend.mock.calls[0][1]).toEqual(failure);
    await waitFor(() => expect(screen.queryByTestId("notify-dlv-21")).toBeNull());
  });

  it("重发在途：按钮禁用并显示 Resending…；完成后恢复可用", async () => {
    await seedFailed(22);
    let resolve!: (v: boolean) => void;
    mockedResend.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    renderPanel();
    await openPanel();
    fireEvent.click(screen.getByTestId("notify-resend-22"));
    const btn = screen.getByTestId("notify-resend-22") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Resending…");
    resolve(true);
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent).toBe("Resend");
  });
});
