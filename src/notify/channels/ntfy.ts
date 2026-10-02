// ntfy 适配器（B5）：topic + 可自建服务器 + 可选访问令牌。
// * POST {server||https://ntfy.sh}/{topic}，body = 消息正文（纯文本），
//   标题走 X-Title 头（ntfy 官方 HTTP API；JSON 发布面不开——少一层格式漂移）；
// * 令牌配置时 Authorization: Bearer <token>（ntfy access token）；
// * 成功 = HTTP 200。
import type { NotificationChannel } from "../core";
import { postText } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type NtfyConfig,
} from "./types";

export function createNtfyChannel(config: NtfyConfig, deps: ChannelDeps = {}): NotificationChannel {
  const server = (config.server?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  async function post(message: ChannelMessage): Promise<void> {
    const headers: Record<string, string> = { "X-Title": message.title };
    if (config.token) {
      headers["Authorization"] = `Bearer ${config.token}`;
    }
    await postText(`${server}/${encodeURIComponent(config.topic)}`, message.body, deps, headers);
  }
  return {
    name: "ntfy",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
