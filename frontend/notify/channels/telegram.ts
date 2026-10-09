// Telegram Bot 适配器（B5）：bot_token + chat_id。
// * POST https://api.telegram.org/bot{token}/sendMessage，JSON golden：
//   {"chat_id":..,"text":"title\nbody"}（markdown 解析面不开——告警正文含
//   用户内容，按纯文本发避免实体解析错误）；
// * 业务码：响应体 ok === true 才算成功。
import type { NotificationChannel } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type TelegramConfig,
} from "./types";

interface TelegramResponse {
  ok?: boolean;
  description?: string;
}

export function createTelegramChannel(
  config: TelegramConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    const res = await postJson<TelegramResponse>(
      `https://api.telegram.org/bot${config.bot_token}/sendMessage`,
      { chat_id: config.chat_id, text: `${message.title}\n${message.body}` },
      deps,
    );
    if (!res.ok) {
      throw new Error(`telegram ${res.description ?? "not ok"}`);
    }
  }
  return {
    name: "telegram",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
