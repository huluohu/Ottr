// Bark（iOS 推送）适配器（B5）：device_key + 可自建服务器。
// * POST {server||https://api.day.app}/push，JSON golden：
//   {"title":..,"body":..,"device_key":..}（官方推荐推送端点，GET 路径式
//   对标题转义脆弱，弃用）；
// * 业务码：code === 200 才算成功。
import type { NotificationChannel } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type BarkConfig,
  type ChannelDeps,
  type ChannelMessage,
} from "./types";

interface BarkResponse {
  code?: number;
  message?: string;
}

export function createBarkChannel(config: BarkConfig, deps: ChannelDeps = {}): NotificationChannel {
  const server = (config.server?.trim() || "https://api.day.app").replace(/\/+$/, "");
  async function post(message: ChannelMessage): Promise<void> {
    const res = await postJson<BarkResponse>(
      `${server}/push`,
      { title: message.title, body: message.body, device_key: config.device_key },
      deps,
    );
    if (res.code !== 200) {
      throw new Error(`bark code=${res.code} ${res.message ?? ""}`.trimEnd());
    }
  }
  return {
    name: "bark",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
