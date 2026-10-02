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
import { vaultApi, type ChannelKind, type NotifyChannel } from "../vault/api";
import { channels, type NotificationEvent, type NotificationChannel } from "./core";
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
