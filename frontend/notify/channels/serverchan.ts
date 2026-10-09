// Server酱（Turbo 版）适配器（B5）：send_key。
// * POST https://sctapi.ftqq.com/{key}.send，表单 golden：title + desp
//   （application/x-www-form-urlencoded；title 上限 32 字截断——超长服务端 400）；
// * 业务码：code === 0 才算成功。
import type { NotificationChannel } from "../core";
import { postForm } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type ServerchanConfig,
} from "./types";

interface ServerchanResponse {
  code?: number;
  message?: string;
}

/** title 上限（Server酱 Turbo 文档：32 字以内）。 */
const TITLE_CAP = 32;

export function createServerchanChannel(
  config: ServerchanConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    const res = await postForm<ServerchanResponse>(
      `https://sctapi.ftqq.com/${encodeURIComponent(config.send_key)}.send`,
      { title: message.title.slice(0, TITLE_CAP), desp: message.body },
      deps,
    );
    if (res.code !== 0) {
      throw new Error(`serverchan code=${res.code} ${res.message ?? ""}`.trimEnd());
    }
  }
  return {
    name: "serverchan",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
