// Discord webhook 适配器（B5）：webhook URL（URL 内含 token——整串随
// config_enc 密封）。payload golden：{"content":"**title**\nbody"}；
// 成功 = HTTP 204 No Content（postJson 空 body 走文本退化）。
import type { NotificationChannel } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
} from "./types";

export function createDiscordChannel(webhook: string, deps: ChannelDeps = {}): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    // content 上限 2000 字符（Discord 硬限，超长 400）
    const content = `**${message.title}**\n${message.body}`.slice(0, 2000);
    await postJson(webhook, { content }, deps);
  }
  return {
    name: "discord",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
