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
import { withRetry } from "./retry";
import type { ChannelDeps } from "./types";

/** kind + 明文 config → 渠道实例。config 字段面校验在设置页保存前（必填表），
 * 这里只做窄化（运行期配置损坏 → 适配器内自然报错，不二次校验）。
 * 【Phase 5 T1（BL-517）】send 统一经 withRetry 重试装饰（网络/5xx 三次退避
 * 1s/4s/16s、per-channel 队列化、终败回执「投递失败」标记）——装饰在工厂
 * 单点收口，「发送测试」走的 test() 不装饰（错误立即上屏）。 */
export function createChannel(
  kind: ChannelKind,
  config: Record<string, unknown>,
  deps: ChannelDeps = {},
): NotificationChannel {
  switch (kind) {
    case "dingtalk":
      return withRetry(createDingtalkChannel(config as never, deps), deps);
    case "feishu":
      return withRetry(createFeishuChannel(config as never, deps), deps);
    case "wecom":
      return withRetry(createWecomChannel(config as never, deps), deps);
    case "bark":
      return withRetry(createBarkChannel(config as never, deps), deps);
    case "serverchan":
      return withRetry(createServerchanChannel(config as never, deps), deps);
    case "telegram":
      return withRetry(createTelegramChannel(config as never, deps), deps);
    case "discord":
      return withRetry(createDiscordChannel(String(config["webhook"] ?? ""), deps), deps);
    case "slack":
      return withRetry(createSlackChannel(String(config["webhook"] ?? ""), deps), deps);
    case "smtp":
      return withRetry(createSmtpChannel(config as never, deps), deps);
    case "pushover":
      return withRetry(createPushoverChannel(config as never, deps), deps);
    case "ntfy":
      return withRetry(createNtfyChannel(config as never, deps), deps);
    case "webhook":
      return withRetry(createWebhookChannel(config as never, deps), deps);
  }
}
