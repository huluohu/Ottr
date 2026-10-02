// Slack incoming webhook 适配器（B5）。payload golden：{"text":"*title*\nbody"}
// （mrkdwn 星号粗体；块面 block kit 不开——纯文本对告警足够且无版本漂移面）。
// 成功 = HTTP 200 "ok"（非 2xx 由 HttpError 抛）。
import type { NotificationChannel } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
} from "./types";

export function createSlackChannel(webhook: string, deps: ChannelDeps = {}): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    await postJson(webhook, { text: `*${message.title}*\n${message.body}` }, deps);
  }
  return {
    name: "slack",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
