// Pushover 适配器（B5）：token（应用）+ user（用户/组）。
// * POST https://api.pushover.net/1/messages.json，表单 golden：
//   token/user/title/message（Pushover API 是表单面，无 JSON）；
// * 业务码：status === 1 才算成功。
import type { NotificationChannel } from "../core";
import { postForm } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type PushoverConfig,
} from "./types";

interface PushoverResponse {
  status?: number;
  errors?: unknown;
}

export function createPushoverChannel(
  config: PushoverConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    const res = await postForm<PushoverResponse>(
      "https://api.pushover.net/1/messages.json",
      { token: config.token, user: config.user, title: message.title, message: message.body },
      deps,
    );
    if (res.status !== 1) {
      throw new Error(`pushover status=${res.status} ${JSON.stringify(res.errors ?? "")}`);
    }
  }
  return {
    name: "pushover",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
