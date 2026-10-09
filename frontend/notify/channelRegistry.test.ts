// channelRegistry 真实挂载链集成测试（Phase 5 T1，fix round 1 C-1 回归）：
// 必须穿过 mountOne（factory 出裸适配器 → 内层名改挂载名 kind#id → withRetry
// 装饰）——装饰器终败/翻正回执与手动重发都按挂载名回查，绕过挂载点的单测
// 抓不到「改名晚于装饰」这类顺序缺陷（评审探针实证：回执恒裸 kind → 重发
// 扑空、channel_id 恒 null、同 kind 多实例串账）。独立成文件 = 干净的模块
// 注册表（vault api 顶层 mock 不与 channels.test 的 doMock 时序互扰）。
import { describe, expect, it, vi } from "vitest";

vi.mock("../vault/api", () => ({
  vaultApi: {
    notifyChannels: {
      list: async () => [
        { id: 3, kind: "slack", template_overrides: null, enabled: true, created_at: 1, updated_at: 1 },
        { id: 7, kind: "slack", template_overrides: null, enabled: true, created_at: 2, updated_at: 2 },
      ],
      revealConfig: async () => ({ webhook: "https://hooks.slack.com/x" }),
    },
  },
}));

import { remountChannels, resendNotification } from "./channelRegistry";
import { channels, readDeliveryFailures, useNotifyStore, type NotificationEvent } from "./core";
import type { Notification } from "../vault/api";

type Req = { url: string; init: RequestInit };

/** 记录请求的假 fetch：responder 闭包读外部开关（up=false 一律 502，置真后
 * 放行 200——重发翻正面）。 */
function mockFetch(responder: () => Response) {
  const calls: Req[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return responder();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

/** 门控退避时钟：delay 全部挂起；releaseAll 反复放行直至门清空（重试循环每
 * 步挂新门），零真实等待。 */
function gateDelays() {
  const gates: { open: () => void }[] = [];
  const delay = () =>
    new Promise<void>((resolve) => {
      gates.push({ open: resolve });
    });
  const releaseAll = async () => {
    let guard = 0;
    while (gates.length > 0 && guard++ < 100) {
      for (const g of gates.splice(0)) g.open();
      await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  return { delay, gates, releaseAll };
}

const event = (): NotificationEvent => ({
  kind: "alert",
  severity: "warning",
  host_id: 7,
  title_key: "alert.title.disk",
  body: "web-01 disk / at 91%",
  payload: { rule_id: 1, channel_ids: [3, 7] },
});

const row: Notification = {
  id: 11,
  kind: "alert",
  severity: "warning",
  host_id: 7,
  title_key: "alert.title.disk",
  body: "web-01 disk /",
  payload: { rule_id: 1 },
  read: false,
  ts: 1000,
  delivery_failures: null,
};

describe("真实挂载链（factory → mountOne 改名装饰 → send → 回执/重发）", () => {
  it("终败回执 channel 带挂载名 #id；手动重发按名回查翻正；同 kind 多实例不串账", async () => {
    let up = false;
    const { impl } = mockFetch(() =>
      up ? new Response("ok", { status: 200 }) : new Response("down", { status: 502 }),
    );
    const { delay, gates, releaseAll } = gateDelays();
    await remountChannels({ fetchImpl: impl, delay });

    // 挂载名进装饰器闭包（C-1 核心：回执/重发都按这个名字回查）
    expect(channels.map((c) => c.name)).toEqual(["slack#3", "slack#7"]);
    const [ch3, ch7] = channels;

    useNotifyStore.setState({ items: [row], unread: 0 });
    await ch3.send(event(), { notificationId: 11 }); // 首发内联失败 → 重试挂起
    await ch7.send(event(), { notificationId: 11 });
    expect(gates).toHaveLength(2); // 各自一个挂起的重试循环

    await releaseAll(); // 三次退避全败 → 终败回执（缺省 = 中心条目打标记）
    await vi.waitFor(() =>
      expect(readDeliveryFailures(useNotifyStore.getState().items[0].payload)).toHaveLength(2),
    );
    const fails = readDeliveryFailures(useNotifyStore.getState().items[0].payload);
    expect(fails.map((f) => f.channel)).toEqual(["slack#3", "slack#7"]);
    expect(fails.map((f) => f.channel_id)).toEqual([3, 7]); // channelIdOf 不再恒 null

    // 重发 slack#3：上游恢复 → 按挂载名回查翻正；只清本实例（不串 slack#7）
    up = true;
    const ok = await resendNotification(useNotifyStore.getState().items[0], fails[0]);
    expect(ok).toBe(true);
    const after = readDeliveryFailures(useNotifyStore.getState().items[0].payload);
    expect(after.map((f) => f.channel)).toEqual(["slack#7"]);

    // 未翻正的 slack#7 重发仍在途语义：上游已恢复，同样可翻正
    expect(await resendNotification(useNotifyStore.getState().items[0], after[0])).toBe(true);
    expect(readDeliveryFailures(useNotifyStore.getState().items[0].payload)).toEqual([]);
  });
});
