// 渠道 send 重试装饰器单测（Phase 5 T1，BL-517 清偿）：重试判定分类（网络错
// TypeError / HTTP 5xx 重试；4xx、业务码错、配置错不重试）× 退避序列
// （1s/4s/16s 三次）× per-channel 队列化（重试不阻塞管线其余渠道、事件不丢）。
// Mock HTTP 沿 channels.test.ts 的 fetchImpl 注入模式；退避时钟经 deps.delay
// 注入（门控/即时两种假件）——测试零真实等待（硬超时纪律）；后台重试队列用
// flush() 排水。
import { describe, expect, it, vi } from "vitest";
import type { NotificationChannel, NotificationEvent } from "../core";
import type { RetryChannel } from "./retry";
import { RETRY_DELAYS_MS, withRetry } from "./retry";

type Req = { url: string; init: RequestInit };

/** 记录请求的假 fetch（沿 channels.test.ts 同款；responder 抛错 = 网络层拒绝）。 */
function mockFetch(responder: (req: Req, nth: number) => Response) {
  const calls: Req[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const req: Req = { url: String(input), init: init ?? {} };
    const nth = calls.length;
    calls.push(req);
    return responder(req, nth);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const ok204 = (): Response => new Response(null, { status: 204 });
const httpStatus = (status: number): Response => new Response("boom", { status });

/** 门控退避时钟：每次 delay 挂起并记账，测试显式放行（零真实等待）。 */
function gateDelays() {
  const gates: { ms: number; open: () => void }[] = [];
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      gates.push({ ms, open: resolve });
    });
  /** 反复放行直至门清空（重试循环每步会挂新门），再排水队列。 */
  const drain = async (ch: RetryChannel) => {
    while (gates.length > 0) {
      for (const g of gates.splice(0)) g.open();
      await new Promise((r) => setTimeout(r, 0));
    }
    await ch.flush();
  };
  return { delay, gates, drain };
}
/** 即时退避时钟：记录退避序列并即时 resolve（重试循环一口气走完）。 */
function instantDelays() {
  const seen: number[] = [];
  const delay = async (ms: number) => {
    seen.push(ms);
  };
  return { delay, seen };
}

const event = (): NotificationEvent => ({
  kind: "alert",
  severity: "warning",
  host_id: 7,
  title_key: "alert.title.disk",
  body: "web-01 disk / at 91%",
  payload: { rule_id: 1, channel_ids: [3] },
});

/** 最小假渠道：send 计数并按脚本回放（throw = 拒绝）。 */
function fakeChannel(script: (nth: number) => void | Promise<void>): {
  channel: NotificationChannel;
  attempts: number[];
} {
  const attempts: number[] = [];
  return {
    attempts,
    channel: {
      name: "fake#1",
      send: async () => {
        attempts.push(attempts.length);
        await script(attempts.length - 1);
      },
      test: async () => {},
    },
  };
}

describe("重试判定分类", () => {
  it("网络错（fetch reject / TypeError）→ 重试三次退避后成功；退避序列 1s/4s/16s", async () => {
    const { calls, impl } = mockFetch((_req, nth) => {
      if (nth < 3) throw new TypeError("fetch failed: network unreachable");
      return ok204();
    });
    const { createWebhookChannel } = await import("./webhook");
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const onDelivered = vi.fn();
    const ch = withRetry(
      createWebhookChannel({ url: "https://e.com" }, { fetchImpl: impl }),
      { delay, onGiveUp, onDelivered },
    );
    await ch.send(event());
    await ch.flush();
    expect(calls).toHaveLength(4); // 首发 + 三次重试
    expect(seen).toEqual([1000, 4000, 16000]);
    expect(onGiveUp).not.toHaveBeenCalled();
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onDelivered.mock.calls[0][0]).toEqual({ channel: "webhook", notificationId: undefined });
  });

  it("HTTP 5xx → 重试；中途恢复即成功（不再多打）", async () => {
    const { calls, impl } = mockFetch((_req, nth) => (nth < 2 ? httpStatus(503) : ok204()));
    const { createWebhookChannel } = await import("./webhook");
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(
      createWebhookChannel({ url: "https://e.com" }, { fetchImpl: impl }),
      { delay, onGiveUp },
    );
    await ch.send(event());
    await ch.flush();
    expect(calls).toHaveLength(3);
    expect(seen).toEqual([1000, 4000]);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("HTTP 4xx → 不重试直接失败（1 次请求、零退避）", async () => {
    const { calls, impl } = mockFetch(() => httpStatus(400));
    const { createWebhookChannel } = await import("./webhook");
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(
      createWebhookChannel({ url: "https://e.com" }, { fetchImpl: impl }),
      { delay, onGiveUp },
    );
    await ch.send(event());
    await ch.flush();
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0].error).toContain("HTTP 400");
  });

  it("业务码错（钉钉 errcode≠0，HTTP 200）→ 不重试", async () => {
    const { calls, impl } = mockFetch(() =>
      new Response(JSON.stringify({ errcode: 310000, errmsg: "sign not match" }), { status: 200 }),
    );
    const { createDingtalkChannel } = await import("./dingtalk");
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(createDingtalkChannel({ webhook: "https://d" }, { fetchImpl: impl }), {
      delay,
      onGiveUp,
    });
    await ch.send(event());
    await ch.flush();
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(onGiveUp.mock.calls[0][0].error).toContain("310000");
  });

  it("配置/模板错（普通 Error，非网络非 5xx）→ 不重试", async () => {
    const { calls, impl } = mockFetch(() => ok204());
    const { createWebhookChannel } = await import("./webhook");
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(
      createWebhookChannel({ url: "https://e.com", body_template: "{not json {{host}}" }, { fetchImpl: impl }),
      { delay, onGiveUp },
    );
    await ch.send(event());
    await ch.flush();
    expect(calls).toHaveLength(0); // 模板解析先于 HTTP
    expect(seen).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("test() 不装饰：连败立即原样抛（发送测试错误面上屏，不等退避）", async () => {
    const { calls, impl } = mockFetch(() => httpStatus(500));
    const { createWebhookChannel } = await import("./webhook");
    const { delay, seen } = instantDelays();
    const ch = withRetry(
      createWebhookChannel({ url: "https://e.com" }, { fetchImpl: impl }),
      { delay },
    );
    await expect(ch.test()).rejects.toThrow("HTTP 500");
    await ch.flush();
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe("退避与最终失败", () => {
  it("三次退避全败 → onGiveUp 恰一次（含错误文本与事件引用）；共 4 次尝试", async () => {
    const { attempts, channel } = fakeChannel(() => {
      throw new TypeError("fetch failed");
    });
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const e = event();
    const ch = withRetry({ ...channel, name: "slack#3" }, { delay, onGiveUp });
    await ch.send(e);
    await ch.flush();
    expect(attempts).toHaveLength(4);
    expect(seen).toEqual(RETRY_DELAYS_MS);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0]).toMatchObject({
      channel: "slack#3",
      event: e,
      notificationId: undefined,
    });
    expect(onGiveUp.mock.calls[0][0].error).toContain("fetch failed");
  });

  it("重试中途转不可重试（如 5xx 后转 4xx）→ 立即放弃，不再退避", async () => {
    // HttpError 用真类（http.ts），instanceof 判定与生产路径一致
    const { HttpError } = await import("./http");
    const { attempts, channel } = fakeChannel((nth) => {
      if (nth === 0) throw new HttpError(500, "down");
      throw new HttpError(403, "denied");
    });
    const { delay, seen } = instantDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(channel, { delay, onGiveUp });
    await ch.send(event());
    await ch.flush();
    expect(attempts).toHaveLength(2);
    expect(seen).toEqual([1000]); // 只退避了一次就转不可重试
    expect(onGiveUp.mock.calls[0][0].error).toContain("403");
  });
});

describe("per-channel 队列化（重试不阻塞管线其余渠道、事件不丢）", () => {
  it("首试内联返回：重试挂起期间 send 已 resolve（管线不等退避）", async () => {
    const { attempts, channel } = fakeChannel(() => {
      throw new TypeError("fetch failed");
    });
    const { delay, gates, drain } = gateDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry(channel, { delay, onGiveUp });
    const e = event();
    await ch.send(e); // 首试失败即返回——退避还挂在门上
    expect(attempts).toHaveLength(1);
    expect(gates).toHaveLength(1);
    expect(onGiveUp).not.toHaveBeenCalled();
    await drain(ch); // 放行全部退避 → 最终失败浮出，且事件引用不丢
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0].event).toBe(e);
  });

  it("同渠道多事件串行排队（重试循环不交错）；他渠道照常首发不被阻塞", async () => {
    const { delay, drain } = gateDelays();
    const log: NotificationEvent[] = [];
    const chA = withRetry(
      {
        name: "a#1",
        send: async (e) => {
          log.push(e);
          throw new TypeError("fetch failed");
        },
        test: async () => {},
      },
      { delay },
    );
    const bAttempts: number[] = [];
    const chB = withRetry(
      {
        name: "b#2",
        send: async () => {
          bAttempts.push(1);
        },
        test: async () => {},
      },
      { delay: async () => {} },
    );

    const e1 = event();
    await chA.send(e1); // 首试失败 → e1 重试循环挂起（gate 未放行）
    await chB.send(event()); // 他渠道首发立即可走（不被 A 的重试阻塞）
    expect(bAttempts).toHaveLength(1);

    const e3 = event();
    await chA.send(e3); // A 渠道第二事件：首试失败 → 排在 e1 循环之后
    expect(log).toHaveLength(2); // 两次首发都内联完成，重试均挂起

    await drain(chA);
    expect(log).toHaveLength(8); // 2 事件 × 4 次尝试
    // 串行：按引用区分事件——e1 的重试循环（3 次）整体先于 e3 的重试循环
    expect(log.slice(2).map((e) => e === e1)).toEqual([true, true, true, false, false, false]);
  });

  it("重试期间事件不丢：排队中两事件最终各得一次终局回执（引用原样）", async () => {
    const { attempts, channel } = fakeChannel(() => {
      throw new TypeError("fetch failed");
    });
    const { delay, drain } = gateDelays();
    const onGiveUp = vi.fn();
    const ch = withRetry({ ...channel, name: "x#9" }, { delay, onGiveUp });
    const e1 = event();
    const e2 = event();
    await ch.send(e1);
    await ch.send(e2);
    await drain(ch);
    expect(onGiveUp).toHaveBeenCalledTimes(2);
    expect(onGiveUp.mock.calls[0][0].event).toBe(e1);
    expect(onGiveUp.mock.calls[1][0].event).toBe(e2);
    expect(attempts).toHaveLength(8); // 2 事件 × 4 次尝试（串行）
  });
});
