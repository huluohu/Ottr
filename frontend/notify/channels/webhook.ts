// 自定义 webhook 适配器（B5，spec §7）：JSON 模板变量 {{host}} {{rule}}
// {{value}} {{severity}} {{count}}（+ title/body 透传）。
// * body_template 配置时：renderTemplate 插值后必须解析为 JSON 对象 POST
//   （模板写坏在发送时显式报错——「发送测试」立即暴露，不静默发残包）；
// * 缺省 payload：{"title":..,"body":..}；
// * headers 配置（可选）随 config_enc 密封（可携带 Authorization 等），
//   Content-Type 恒 application/json（headers 同名键可覆盖）；
// * 成功 = HTTP 2xx（业务码语义归用户自己的接收端，不越界解释）。
import type { NotificationChannel, NotificationEvent } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  renderTemplate,
  templateVarsOf,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type WebhookConfig,
} from "./types";

export function createWebhookChannel(
  config: WebhookConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  async function post(message: ChannelMessage, event?: NotificationEvent) {
    let payload: unknown;
    if (config.body_template) {
      const rendered = renderTemplate(config.body_template, templateVarsOf(event));
      try {
        payload = JSON.parse(rendered);
      } catch (e) {
        throw new Error(`webhook body_template is not valid JSON after render: ${String(e)}`);
      }
    } else {
      payload = { title: message.title, body: message.body };
    }
    await postJson(config.url, payload, deps, config.headers ?? {});
  }
  return {
    name: "webhook",
    send: (event) => post(buildChannelMessage(event), event),
    test: () => post(testMessage()),
  };
}
