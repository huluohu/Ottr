// 企业微信群机器人适配器（B5）：webhook（无加签——企微机器人安全面只有
// webhook key）。payload golden：{"msgtype":"text","text":{"content":...}}；
// 长度截断：content 上限 2048 字节（企微文档），超长从尾部截（告警头部信息
// 保全）。业务码 errcode === 0。
import type { NotificationChannel } from "../core";
import { postJson } from "./http";
import {
  buildChannelMessage,
  testMessage,
  type ChannelDeps,
  type ChannelMessage,
  type WecomConfig,
} from "./types";

interface WecomResponse {
  errcode?: number;
  errmsg?: string;
}

/** content 上限（UTF-8 字节；企微 markdown/text 同限）。 */
const CONTENT_CAP_BYTES = 2048;

function truncateUtf8(s: string, cap: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= cap) return s;
  return new TextDecoder().decode(bytes.slice(0, cap));
}

export function createWecomChannel(
  config: WecomConfig,
  deps: ChannelDeps = {},
): NotificationChannel {
  async function post(message: ChannelMessage): Promise<void> {
    const res = await postJson<WecomResponse>(
      config.webhook,
      {
        msgtype: "text",
        text: { content: truncateUtf8(`${message.title}\n${message.body}`, CONTENT_CAP_BYTES) },
      },
      deps,
    );
    if (res.errcode !== 0) {
      throw new Error(`wecom errcode=${res.errcode} ${res.errmsg ?? ""}`.trimEnd());
    }
  }
  return {
    name: "wecom",
    send: (event) => post(buildChannelMessage(event)),
    test: () => post(testMessage()),
  };
}
