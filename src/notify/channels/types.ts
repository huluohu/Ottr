// 渠道适配器公共类型（Phase 3 Task 3，B5 渠道全矩阵）：
// * ChannelKind/ChannelConfig：12 渠道各自的 config 字段面（notify_channels
//   .config_enc 的明文形态；Rust 侧只密封 JSON，字段语义归本层消费）；
// * CHANNEL_FIELD_SPECS：每渠道的字段描述符（labelKey/secret/password）——
//   设置页表单渲染与「哪些字段是敏感材料」的单一事实源（secret 字段入
//   config_enc 已由整体密封保证，password 只是 UI 输入形态）；
// * 渠道消息正文构造（buildChannelMessage）走 i18n（spec §7「文案走 i18n」）
//   + M-1 聚合计数后缀（payload.suppressed > 0 时「（聚合 N 条）」）。
import i18n from "../../i18n";
import type { NotificationEvent } from "../core";

export type { ChannelKind } from "../../vault/api";

/** 各渠道 config 字段面（snake_case 落 JSON，config_enc 整体密封）。 */
export interface DingtalkConfig {
  webhook: string;
  /** 加签 secret（可选；HMAC-SHA256 → base64 → urlencode 追加 query）。 */
  secret?: string;
}
export interface FeishuConfig {
  webhook: string;
  /** 加签 secret（可选；KEY=ts\nsecret 的 HMAC-SHA256 空消息签名）。 */
  secret?: string;
}
export interface WecomConfig {
  webhook: string;
}
export interface BarkConfig {
  device_key: string;
  /** 自建服务器（缺省 https://api.day.app）。 */
  server?: string;
}
export interface ServerchanConfig {
  send_key: string;
}
export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}
export interface DiscordConfig {
  webhook: string;
}
export interface SlackConfig {
  webhook: string;
}
export interface SmtpConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from: string;
  /** 逗号/分号分隔的收件人（smtp_send 按逗号拆分）。 */
  to: string;
  /** "ssl"（默认）| "starttls" | "none"（Rust SmtpConfig 同构）。 */
  mode?: string;
}
export interface PushoverConfig {
  token: string;
  user: string;
}
export interface NtfyConfig {
  topic: string;
  /** 自建服务器（缺省 https://ntfy.sh）。 */
  server?: string;
  /** 访问令牌（可选；Authorization: Bearer）。 */
  token?: string;
}
export interface WebhookConfig {
  url: string;
  /** 附加请求头（可选；可携带 Authorization 等鉴权面——随 config_enc 密封）。 */
  headers?: Record<string, string>;
  /** JSON 模板（可选；{{host}} {{rule}} {{value}} {{severity}} {{count}}
   * 变量插值；缺省 = { title, body } 两键）。 */
  body_template?: string;
}

/** 可注入端口（Mock HTTP 单测；生产 = 全局 fetch + 系统时钟）。 */
export interface ChannelDeps {
  fetchImpl?: typeof fetch;
  /** 毫秒时钟（钉钉/飞书加签时间戳）。 */
  now?: () => number;
}

/** 默认端口（生产路径）。 */
export const defaultDeps: Required<Pick<ChannelDeps, "now">> & { fetchImpl: typeof fetch } = {
  now: () => Date.now(),
  fetchImpl: (...args) => fetch(...args),
};

/** 单渠道字段描述符（设置页表单渲染面）。 */
export interface ChannelFieldSpec {
  key: string;
  /** i18n 键（alert.channelField.<key>）。 */
  labelKey: string;
  /** 敏感输入形态（password 输入框 + autocomplete=off）。 */
  secret?: boolean;
  placeholder?: string;
  /** 渲染为多行文本（webhook 的 headers/body_template）。 */
  multiline?: boolean;
  /** 数字输入（smtp.port）。 */
  number?: boolean;
}

/** 每渠道必填字段（设置页保存前校验；空 = 全字段选填）。 */
export const CHANNEL_REQUIRED: Record<string, string[]> = {
  dingtalk: ["webhook"],
  feishu: ["webhook"],
  wecom: ["webhook"],
  bark: ["device_key"],
  serverchan: ["send_key"],
  telegram: ["bot_token", "chat_id"],
  discord: ["webhook"],
  slack: ["webhook"],
  smtp: ["host", "port", "from", "to"],
  pushover: ["token", "user"],
  ntfy: ["topic"],
  webhook: ["url"],
};

/** 每渠道字段描述（12 渠道全矩阵；设置页表单按此渲染——加渠道只改本表）。 */
export const CHANNEL_FIELD_SPECS: Record<string, ChannelFieldSpec[]> = {
  dingtalk: [
    { key: "webhook", labelKey: "webhook", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=…" },
    { key: "secret", labelKey: "dingtalkSecret", secret: true },
  ],
  feishu: [
    { key: "webhook", labelKey: "webhook", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…" },
    { key: "secret", labelKey: "feishuSecret", secret: true },
  ],
  wecom: [{ key: "webhook", labelKey: "webhook", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" }],
  bark: [
    { key: "device_key", labelKey: "barkDeviceKey", secret: true },
    { key: "server", labelKey: "barkServer", placeholder: "https://api.day.app" },
  ],
  serverchan: [{ key: "send_key", labelKey: "serverchanSendKey", secret: true }],
  telegram: [
    { key: "bot_token", labelKey: "telegramBotToken", secret: true },
    { key: "chat_id", labelKey: "telegramChatId", placeholder: "-1001234567890" },
  ],
  discord: [{ key: "webhook", labelKey: "webhook", placeholder: "https://discord.com/api/webhooks/…" }],
  slack: [{ key: "webhook", labelKey: "webhook", placeholder: "https://hooks.slack.com/services/…" }],
  smtp: [
    { key: "host", labelKey: "smtpHost", placeholder: "smtp.example.com" },
    { key: "port", labelKey: "smtpPort", number: true, placeholder: "465" },
    { key: "username", labelKey: "smtpUsername" },
    { key: "password", labelKey: "smtpPassword", secret: true },
    { key: "from", labelKey: "smtpFrom", placeholder: "Ottr <ottr@example.com>" },
    { key: "to", labelKey: "smtpTo", placeholder: "ops@example.com, oncall@example.com" },
    { key: "mode", labelKey: "smtpMode", placeholder: "ssl | starttls | none" },
  ],
  pushover: [
    { key: "token", labelKey: "pushoverToken", secret: true },
    { key: "user", labelKey: "pushoverUser", secret: true },
  ],
  ntfy: [
    { key: "topic", labelKey: "ntfyTopic", placeholder: "ottr-alerts" },
    { key: "server", labelKey: "ntfyServer", placeholder: "https://ntfy.sh" },
    { key: "token", labelKey: "ntfyToken", secret: true },
  ],
  webhook: [
    { key: "url", labelKey: "webhookUrl", placeholder: "https://example.com/hook" },
    { key: "headers", labelKey: "webhookHeaders", multiline: true, placeholder: '{"Authorization":"Bearer …"}' },
    { key: "body_template", labelKey: "webhookBodyTemplate", multiline: true, placeholder: '{"text":"{{rule}} on {{host}}: {{value}}"}' },
  ],
};

/** 渠道消息（适配器 payload 的共同原料）。 */
export interface ChannelMessage {
  title: string;
  body: string;
}

/** 「发送测试」的固定消息（真发一条测试告警文案；各适配器 test() 共用）。 */
export function testMessage(): ChannelMessage {
  return {
    title: i18n.t("alert.testTitle"),
    body: i18n.t("alert.testBody"),
  };
}

/** 事件 → 渠道消息：标题 = t(title_key)，正文 = body + M-1 聚合后缀
 * （payload.suppressed > 0 时；spec §7「限频聚合（同 key 60s 合并）」的
 * 可见面）。文案走 i18n（当前语言）。 */
export function buildChannelMessage(event: NotificationEvent): ChannelMessage {
  const title = i18n.t(event.title_key);
  const suppressed = event.payload?.["suppressed"];
  const suffix =
    typeof suppressed === "number" && suppressed > 0
      ? ` ${i18n.t("alert.suppressedSuffix", { count: suppressed })}`
      : "";
  return { title, body: `${event.body}${suffix}` };
}

/** alert 事件的模板变量集（webhook 自定义模板 {{host}} {{rule}} {{value}}
 * {{severity}} {{count}}；非 alert 事件退化为 title/body 变量；test() 无事件
 * 时全空——模板变量原样保留，不发残包）。 */
export function templateVarsOf(event?: NotificationEvent): Record<string, string> {
  const p = (event?.payload ?? {}) as Record<string, unknown>;
  return {
    host: String(p["host_name"] ?? ""),
    rule: String(p["rule_label"] ?? (event ? i18n.t(event.title_key) : "")),
    value: String(p["value"] ?? event?.body ?? ""),
    severity: event?.severity ?? "",
    count: String(p["suppressed"] ?? 0),
    title: event ? i18n.t(event.title_key) : "",
    body: event?.body ?? "",
  };
}

/** {{var}} 插值（webhook 自定义 JSON 模板；未知变量原样保留——模板写错不吞内容）。 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => vars[name] ?? raw);
}
