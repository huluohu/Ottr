// 飞书自定义机器人适配器（B5）：webhook + 可选加签 secret。
// * payload golden：{"msg_type":"text","content":{"text":"title\nbody"}}
//   （加签时顶层追加 "timestamp"（秒级字符串）与 "sign"）；
// * 加签（飞书官方算法，与钉钉不同面）：string_to_sign = "${ts}\n${secret}"，
//   HMAC-SHA256 的 **KEY = string_to_sign、消息为空** → base64（毫秒/秒坑：
//   飞书 timestamp 是秒级）；
// * 业务码：code === 0 才算成功（新版返回体）。
import type { NotificationChannel } from "../core";
import { hmacSha256Base64, postJson } from "./http";
import {
  buildChannelMessage,
  defaultDeps,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type FeishuConfig,
} from "./types";

interface FeishuResponse {
  code?: number;
  msg?: string;
}

export function createFeishuChannel(
  config: FeishuConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  const now = deps.now ?? defaultDeps.now;
  async function post(message: ChannelMessage): Promise<void> {
    const payload: Record<string, unknown> = {
      msg_type: "text",
      content: { text: `${message.title}\n${message.body}` },
    };
    if (config.secret) {
      const ts = Math.floor(now() / 1000); // 飞书签名时间戳 = 秒级
      const stringToSign = `${ts}\n${config.secret}`;
      payload["timestamp"] = String(ts);
      payload["sign"] = await hmacSha256Base64(stringToSign, "");
    }
    const res = await postJson<FeishuResponse>(config.webhook, payload, deps);
    if (res.code !== 0) {
      throw new Error(`feishu code=${res.code} ${res.msg ?? ""}`.trimEnd());
    }
  }
  return {
    name: "feishu",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
