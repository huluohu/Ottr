// 钉钉群机器人适配器（B5，spec §7 渠道矩阵）：webhook + 可选加签 secret。
// * payload golden：{"msgtype":"text","text":{"content":"title\nbody"}}；
// * 加签（secret 配置时）：sign = urlencode(base64(HMAC-SHA256(secret,
//   "${timestamp}\n${secret}")))，追加 &timestamp=&sign=（钉钉安全设置「加签」
//   官方算法；时间戳毫秒）；
// * 业务码：errcode === 0 才算成功（200 语义面也显式校验）。
import type { NotificationChannel } from "../core";
import { hmacSha256Base64, postJson } from "./http";
import {
  buildChannelMessage,
  defaultDeps,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type DingtalkConfig,
} from "./types";

interface DingtalkResponse {
  errcode?: number;
  errmsg?: string;
}

export function createDingtalkChannel(
  config: DingtalkConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  const now = deps.now ?? defaultDeps.now;
  async function post(message: ChannelMessage): Promise<void> {
    let url = config.webhook;
    if (config.secret) {
      const ts = now();
      const sign = await hmacSha256Base64(config.secret, `${ts}\n${config.secret}`);
      url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }
    const res = await postJson<DingtalkResponse>(
      url,
      { msgtype: "text", text: { content: `${message.title}\n${message.body}` } },
      deps,
    );
    if (res.errcode !== 0) {
      throw new Error(`dingtalk errcode=${res.errcode} ${res.errmsg ?? ""}`.trimEnd());
    }
  }
  return {
    name: "dingtalk",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
