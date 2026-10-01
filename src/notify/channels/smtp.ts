// SMTP（邮件）适配器（B5）——12 渠道中唯一的 Rust 发送面：vaultApi.smtpSend
// → Rust lettre（选型裁定见 commands/notify.rs 模块文档：webview 无 Node/
// 裸 TCP，nodemailer 不可行）。config 的 to 字段 = 收件人（逗号分隔多个）。
// 失败显式抛（SMTP 服务器拒绝/超时 30s → 「发送测试」错误面可见）。
import { vaultApi } from "../../vault/api";
import type { NotificationChannel } from "../core";
import { buildChannelMessage, testMessage, type ChannelDeps, type SmtpConfig } from "./types";

export function createSmtpChannel(
  config: SmtpConfig,
  // deps 保留（与其他适配器同构签名；SMTP 无 HTTP 面，Mock 注入点在
  // vaultApi.smtpSend——单测 vi.mock 该模块）
  _deps: ChannelDeps = {},
): NotificationChannel {
  async function post(title: string, body: string): Promise<void> {
    const { mode, ...rest } = config;
    await vaultApi.smtpSend(
      { ...rest, mode: mode ?? "ssl" },
      config.to,
      title,
      body,
    );
  }
  return {
    name: "smtp",
    send: (event) => {
      const m = buildChannelMessage(event);
      return post(m.title, m.body);
    },
    test: () => {
      const m = testMessage();
      return post(m.title, m.body);
    },
  };
}
