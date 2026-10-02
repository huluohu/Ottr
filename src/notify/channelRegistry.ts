// 渠道挂载注册表（Phase 3 Task 3，B5）：notify_channels 表 → 适配器实例 →
// core.channels 挂载点（Phase 1 留的空数组在此正式填充）。
//
// * 订阅语义（spec §7「③外部渠道按 alert_rules.channels / cron_jobs.channels
//   订阅」）：适配器的 subscribed = 事件是 alert 且 rule.channels 引用本渠道
//   id——transfer/session/ai 事件不进外部渠道（应用内中心 + 系统通知已覆盖，
//   外发是告警/cron 的显式订阅面）；cron 按 cron_jobs.channels（Phase 4 T1）。
// * 重挂载：设置页渠道增删改后 remountChannels() 全量重建（渠道量级 = 个位数，
//   全量重建比增量记账简单且无悬挂引用面）；挂载失败的渠道（vault 不可达/
//   config 缺字段）只记 console 不阻塞其余渠道。
// * 明文 config 生命周期：nc_reveal_config 单点出库 → 适配器闭包持有（发信
//   时组装请求），永不落日志/持久化面。
import { vaultApi, type ChannelKind, type Notification, type NotifyChannel } from "../vault/api";
import {
  channels,
  DELIVERY_FAILED_KEY,
  readDeliveryFailures,
  useNotifyStore,
  type DeliveryFailure,
  type NotificationEvent,
  type NotificationChannel,
  type NotifyKind,
} from "./core";
import { createChannel } from "./channels/factory";
import type { ChannelDeps } from "./channels/types";

/** alert/cron 事件的订阅路由面（payload.channel_ids ∈ AlertPayload /
 * CronRunEvent）：alert 按 alert_rules.channels、cron 按 cron_jobs.channels
 * （spec §7③「按 alert_rules.channels / cron_jobs.channels 订阅」——Phase 4
 * Task 1 起 cron 到点）。transfer/session/ai/security 不进外部渠道。 */
function subscribedChannel(id: number): (event: NotificationEvent) => boolean {
  return (event) => {
    if (event.kind !== "alert" && event.kind !== "cron") return false;
    const ids = event.payload?.["channel_ids"];
    return Array.isArray(ids) && (ids as number[]).includes(id);
  };
}

/** 行 + 明文 config → 已订阅的渠道实例（config 缺失/坏 → null 跳过）。 */
function mountOne(
  row: NotifyChannel,
  config: Record<string, unknown>,
  deps: ChannelDeps,
): NotificationChannel | null {
  try {
    const channel = createChannel(row.kind as ChannelKind, config, deps);
    return {
      name: `${channel.name}#${row.id}`,
      send: channel.send,
      test: channel.test,
      subscribed: subscribedChannel(row.id),
    };
  } catch (e) {
    console.warn(`[notify] channel ${row.kind}#${row.id} mount failed:`, e);
    return null;
  }
}

/** 本模块挂载的实例（重挂载时按引用摘除——不碰测试推入的假渠道）。 */
let mounted: NotificationChannel[] = [];

/** 全量重挂载：vault 读启用渠道 → reveal 明文 config → 工厂建适配器 →
 * 替换 core.channels 中本模块的旧挂载。App 挂载链调用一次；设置页保存后
 * 再调。vault 不可达（纯浏览器 dev/锁定）→ 静默保留空挂载。摘旧挂新按引用
 * 定位（不碰测试推入 channels 的假渠道）。 */
export async function remountChannels(deps: ChannelDeps = {}): Promise<void> {
  const next: NotificationChannel[] = [];
  try {
    const rows = (await vaultApi.notifyChannels.list()).filter((r) => r.enabled);
    for (const row of rows) {
      try {
        const config = await vaultApi.notifyChannels.revealConfig(row.id);
        const channel = mountOne(row, config, deps);
        if (channel) next.push(channel);
      } catch (e) {
        console.warn(`[notify] channel ${row.kind}#${row.id} reveal failed:`, e);
      }
    }
  } catch (e) {
    console.warn("[notify] mount channels failed:", e);
  }
  for (const ch of mounted) {
    const idx = channels.indexOf(ch);
    if (idx >= 0) channels.splice(idx, 1);
  }
  mounted = next;
  channels.push(...mounted);
}

/** 「发送测试」真发（设置页按钮）：临时建适配器发一条测试消息——不走已挂载
 * 实例（编辑中的未保存配置也能测）。失败原样抛（错误面上屏）。 */
export async function testChannel(
  kind: ChannelKind,
  config: Record<string, unknown>,
  deps: ChannelDeps = {},
): Promise<void> {
  const channel = createChannel(kind, config, deps);
  await channel.test();
}

// ---------------------------------------------------------------------------
// 手动重发（Phase 5 T1，BL-517 最终失败面：中心条目「投递失败」标记 +
// 重发按钮——对该事件重跑该渠道 send）
// ---------------------------------------------------------------------------

/** 中心条目 → 事件重建（payload 剥失败标记——重发的事件不自带旧账）。 */
function eventOfRow(row: Notification): NotificationEvent {
  const base =
    row.payload && typeof row.payload === "object"
      ? { ...(row.payload as Record<string, unknown>) }
      : {};
  delete base[DELIVERY_FAILED_KEY];
  return {
    kind: row.kind as NotifyKind,
    severity: row.severity,
    host_id: row.host_id,
    title_key: row.title_key,
    body: row.body,
    payload: base,
  };
}

/** 重发一条「投递失败」的通知（通知中心按钮面）：按挂载名（`kind#id`）回查
 * core.channels 实例（设置页重挂载后实例可换、名字不变），对该事件重跑该渠
 * 道 send——走重试装饰器（传输面故障照常入后台退避队列）。返回 true = send
 * 返回后该渠道无失败标记（翻正/本就无账）；false = 未挂载、首发即再败或重
 * 试在途。失败块的隐现由 store 标记驱动（翻正时 onDelivered 清账自动消失）。 */
export async function resendNotification(
  row: Notification,
  failure: DeliveryFailure,
): Promise<boolean> {
  const target = channels.find((c) => c.name === failure.channel);
  if (!target) {
    console.warn(`[notify] resend: channel ${failure.channel} not mounted`);
    return false;
  }
  try {
    await target.send(eventOfRow(row), { notificationId: row.id });
  } catch (e) {
    // 装饰后的 send 不抛（终局走 onGiveUp 入账）；此处是未装饰渠道的防御
    console.warn(`[notify] resend ${failure.channel} failed:`, e);
    return false;
  }
  const rowNow = useNotifyStore.getState().items.find((n) => n.id === row.id);
  const still = readDeliveryFailures(rowNow?.payload).some((f) => f.channel === failure.channel);
  return !still;
}
