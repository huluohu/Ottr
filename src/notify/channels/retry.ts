// 渠道 send 重试装饰器（Phase 5 T1，BL-517 清偿；spec §7 管线图「渠道适配器
// → 重试(3 次退避)」）：包在适配器 send 外层——12 个适配器本体零改动。
//
// * 重试判定（isRetryableDeliveryError）：只重试传输面故障——
//   - 网络错：fetch 拒绝（运行时形态即 TypeError）；
//   - HTTP 5xx：HttpError.status >= 500（服务端暂态，重试有意义）。
//   其余一律不重试直接终局：HTTP 4xx（鉴权/参数错，重试无意义）、业务码错
//   （钉钉 errcode≠0、飞书 code≠0、Telegram ok=false 等——适配器在 HTTP 200
//   上抛普通 Error）、配置错（webhook 模板坏 JSON 等）。
// * 退避：1s / 4s / 16s 三次重试（RETRY_DELAYS_MS；首发 + 3 = 至多 4 次尝试）。
// * per-channel 队列化（BL-517「重试期间不阻塞管线其余渠道」）：首发内联
//   await（管线时序与装饰前一致），首发失败且可重试时把「剩余重试循环」
//   挂进本渠道的串行队列立即返回——同渠道多事件的重试串行排队（不打爆对端），
//   他渠道与管线完全不受牵连；重试期间事件被队列持有，绝不丢失。
// * 终局回执：重试耗尽仍败或遇不可重试错 → deps.onGiveUp（缺省 = 通知中心
//   条目打「投递失败」标记）；重试翻正 → deps.onDelivered（缺省 = 清账）。
//   test() 不装饰——「发送测试」的错误面要立即上屏，不走退避。
// * flush()：测试排水口（等串行队列全部走完；生产管线不用）。
import { HttpError } from "./http";
import { defaultDeps, type ChannelDeps, type DeliveryGiveUp, type DeliveryOk } from "./types";
import type { NotificationChannel, NotificationEvent, SendContext } from "../core";
import { clearDeliveryFailure, recordDeliveryFailure } from "../core";

/** 退避序列（ms）：三次重试，4 倍步进（BL-517 定稿 1s/4s/16s）。 */
export const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] as const;

/** 重试判定：网络错（fetch reject/TypeError）与 HTTP 5xx；其余（4xx、业务
 * 码错、配置错）不重试——重试改变不了结果的错误不该烧退避窗口。 */
export function isRetryableDeliveryError(e: unknown): boolean {
  if (e instanceof HttpError) return e.status >= 500;
  return e instanceof TypeError || (e instanceof Error && e.name === "TypeError");
}

/** channel_id 从挂载名尾段提取（channelRegistry 命名 `kind#id`；无 id 尾段
 * = 测试假件/null）。 */
function channelIdOf(name: string): number | null {
  const m = /#(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** 终局回执缺省实现：中心条目打「投递失败」标记（notificationId 缺 = ①落库
 * 已失败、无条目可挂——只记 console，尽力而为面不抛）。 */
function defaultGiveUp(report: DeliveryGiveUp): void {
  console.warn(`[notify] channel ${report.channel} delivery failed:`, report.error);
  recordDeliveryFailure(report.notificationId ?? null, {
    channel: report.channel,
    channel_id: channelIdOf(report.channel),
    error: report.error,
    ts: Math.floor(defaultDeps.now() / 1000),
  });
}

/** 重试翻正缺省实现：清掉该渠道的失败标记（手动重发/后台重试翻正即销账）。 */
function defaultDelivered(report: DeliveryOk): void {
  if (report.notificationId != null) clearDeliveryFailure(report.notificationId, report.channel);
}

/** 装饰后的渠道（= NotificationChannel + flush 测试排水口）。 */
export type RetryChannel = NotificationChannel & { flush: () => Promise<void> };

/**
 * 渠道 send 重试装饰（factory 挂载面统一收口；deps 只消费 delay/onGiveUp/
 * onDelivered 三个注入位）。装饰后的 send 永不 reject——终局失败经 onGiveUp
 * 回执，管线 try/catch 保留给未装饰渠道。
 */
export function withRetry(channel: NotificationChannel, deps: ChannelDeps = {}): RetryChannel {
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onGiveUp = deps.onGiveUp ?? defaultGiveUp;
  const onDelivered = deps.onDelivered ?? defaultDelivered;

  // per-channel 串行重试队列：tail 永不 reject（job 内部已全捕获）。
  let tail: Promise<void> = Promise.resolve();

  function enqueue(event: NotificationEvent, ctx?: SendContext, firstError?: unknown): void {
    // 整个重试循环挂在 tail 之后——同渠道多事件严格串行（循环不交错）。
    const job = tail.then(async () => {
      let last: unknown = firstError;
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        await delay(RETRY_DELAYS_MS[i]);
        try {
          await channel.send(event);
          onDelivered({ channel: channel.name, notificationId: ctx?.notificationId });
          return;
        } catch (e) {
          last = e;
          if (!isRetryableDeliveryError(e)) break; // 中途转不可重试：立即终局
        }
      }
      onGiveUp({
        channel: channel.name,
        event,
        error: last instanceof Error ? last.message : String(last),
        notificationId: ctx?.notificationId,
      });
    });
    tail = job.catch(() => {}); // 链条永不断（循环理论不抛，兜底防御）
  }

  return {
    name: channel.name,
    test: channel.test, // 不装饰：测试发送要立即报错上屏
    send: async (event, ctx) => {
      try {
        await channel.send(event);
        // 首发即成也回执（清该渠道可能残留的失败账——重发翻正走的就是这条）
        onDelivered({ channel: channel.name, notificationId: ctx?.notificationId });
        return;
      } catch (e) {
        if (!isRetryableDeliveryError(e)) {
          onGiveUp({
            channel: channel.name,
            event,
            error: e instanceof Error ? e.message : String(e),
            notificationId: ctx?.notificationId,
          });
          return;
        }
        enqueue(event, ctx, e); // 传输面故障：后台退避重试（事件由队列持有，不丢）
      }
    },
    ...(channel.subscribed ? { subscribed: channel.subscribed } : {}),
    flush: () => tail,
  };
}
