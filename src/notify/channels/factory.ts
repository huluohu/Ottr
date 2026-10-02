// 渠道适配器工厂（B5）：kind → 适配器实例的单一分派点（channelRegistry 挂载
// 与设置页「发送测试」共用；加渠道只改本文件 + types.ts 字段表 + vault DB
// CHECK/Rust CHANNEL_KINDS）。config 为明文 JSON（nc_reveal_config 出库形态），
// 各分支窄化为对应 config 面后进适配器。
import type { NotificationChannel } from "../core";
import type { ChannelKind } from "../../vault/api";
import { createBarkChannel } from "./bark";
import { createDingtalkChannel } from "./dingtalk";
import { createDiscordChannel } from "./discord";
import { createFeishuChannel } from "./feishu";
import { createNtfyChannel } from "./ntfy";
import { createPushoverChannel } from "./pushover";
import { createServerchanChannel } from "./serverchan";
import { createSlackChannel } from "./slack";
import { createSmtpChannel } from "./smtp";
import { createTelegramChannel } from "./telegram";
import { createWebhookChannel } from "./webhook";
import { createWecomChannel } from "./wecom";
import type { ChannelDeps } from "./types";

/** kind + 明文 config → 裸适配器实例（send/test 未装饰）。config 字段面校验在
 * 设置页保存前（必填表），这里只做窄化（运行期配置损坏 → 适配器内自然报错，
 * 不二次校验）。
 * 【Phase 5 T1（BL-517）；fix round 1（C-1）】重试装饰不在本层——装饰器的
 * 回执 channel 名必须挂载名（`kind#id`）：回执账本与手动重发都按名回查，
 * 而行 id 只在 channelRegistry.mountOne 可得（先改内层名再装饰）。此前装饰
 * 在工厂收口时闭包读到裸 kind，回执/重发/多实例账目全部错位（评审探针实证）。 */
export function createChannel(
  kind: ChannelKind,
  config: Record<string, unknown>,
  deps: ChannelDeps = {},
): NotificationChannel {
  switch (kind) {
    case "dingtalk":
      return createDingtalkChannel(config as never, deps);
    case "feishu":
      return createFeishuChannel(config as never, deps);
    case "wecom":
      return createWecomChannel(config as never, deps);
    case "bark":
      return createBarkChannel(config as never, deps);
    case "serverchan":
      return createServerchanChannel(config as never, deps);
    case "telegram":
      return createTelegramChannel(config as never, deps);
    case "discord":
      return createDiscordChannel(String(config["webhook"] ?? ""), deps);
    case "slack":
      return createSlackChannel(String(config["webhook"] ?? ""), deps);
    case "smtp":
      return createSmtpChannel(config as never, deps);
    case "pushover":
      return createPushoverChannel(config as never, deps);
    case "ntfy":
      return createNtfyChannel(config as never, deps);
    case "webhook":
      return createWebhookChannel(config as never, deps);
  }
}
