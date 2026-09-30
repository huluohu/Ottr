// NotificationCenter 组件测试（Task 12 Step 4）：红点未读数、面板列表/已读/
// 全部已读/清空、按 kind 静音开关、空态。直接 seed useNotifyStore（store 单测
// 在 core.test.ts）；invoke 全量 mock（真后端已接线，命令断言走 invoke 面）。
// 注意：打开面板即 refresh 对齐真源（core.ts 语义）——seed 数据必须同步进
// mock 后端（seedBackend），否则刷新会用 mock 空值覆盖本地态。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { NotificationCenter } from "./NotificationCenter";
import { useNotifyStore, type NotifyKind } from "./core";
import type { Notification } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

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
      case "settings_set":
        return undefined;
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  seedBackend([], 0);
});

afterEach(() => {
  cleanup();
});

/** 打开面板并**等 refresh 的 set 落地**（list invoke 计数 + 一个宏任务 tick——
 * set 在 invoke 之后的下一微任务）。点击铃铛与点击行之间的 refresh 微任务若
 * 不先落定，会用 mock 真源覆盖行点击的本地乐观变更——生产里 refresh 早已
 * 完成，这是测试时序伪影，不是管线缺陷。 */
async function openPanel() {
  const before = mockedInvoke.mock.calls.filter(([c]) => c === "notify_list").length;
  fireEvent.click(screen.getByTestId("notify-bell"));
  await waitFor(() =>
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "notify_list").length).toBeGreaterThan(
      before,
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
}

describe("NotificationCenter（铃铛 + 面板）", () => {
  it("未读数红点：unread=0 无 badge；3 条显示 3；超 99 封顶 99+", () => {
    const { rerender } = render(<NotificationCenter />);
    expect(screen.queryByTestId("notify-badge")).toBeNull();

    seedBackend([row(), row({ id: 2 }), row({ id: 3 })], 3);
    rerender(<NotificationCenter />);
    expect(screen.getByTestId("notify-badge").textContent).toBe("3");

    seedBackend([row()], 120);
    rerender(<NotificationCenter />);
    expect(screen.getByTestId("notify-badge").textContent).toBe("99+");
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
    render(<NotificationCenter />);
    expect(screen.queryByTestId("notify-panel")).toBeNull();
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
    // 已读行再点不再发命令
    fireEvent.click(screen.getByTestId("notify-item-11"));
    // 打开面板 refresh 2 个读命令 + mark_read 1 次；再点已读行零新增
    expect(mockedInvoke).toHaveBeenCalledTimes(3);
  });

  it("全部已读：unread>0 才可用，发 notify_mark_read(id=null) 并清零", async () => {
    const items = [row({ id: 1 }), row({ id: 2, read: true })];
    seedBackend(items, 1);
    render(<NotificationCenter />);
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
    render(<NotificationCenter />);
    await openPanel();
    const btn = screen.getByTestId("notify-clear") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("notify_clear"));
    expect(useNotifyStore.getState().items).toHaveLength(0);
    expect(useNotifyStore.getState().unread).toBe(0);
    expect((screen.getByTestId("notify-clear") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("notify-empty").textContent).toBe("No notifications");
  });

  it("按 kind 静音：勾选即写 settings 并入 muted 集；已静音的 kind 勾选态回显", async () => {
    seedBackend([], 0, ["session"]);
    render(<NotificationCenter />);
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
    render(<NotificationCenter />);
    fireEvent.click(screen.getByTestId("notify-bell"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("notify_list", { limit: 200 }),
    );
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("notify_unread_count"));
    expect(screen.getByTestId("notify-empty").textContent).toBe("No notifications");

    // 后端出现新行：再开面板（关→开）对齐真源
    const items = [row({ id: 9 })];
    seedBackend(items, 1);
    fireEvent.click(screen.getByTestId("notify-bell")); // 关
    await openPanel();
    await waitFor(() => expect(screen.getByTestId("notify-item-9")).toBeTruthy());
    expect(screen.getByTestId("notify-badge").textContent).toBe("1");
  });
});
