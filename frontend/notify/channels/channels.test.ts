// 12 渠道适配器 golden 单测（Phase 3 Task 3，B5）：每渠道真实 payload 格式
// 冻结（spec §7 渠道矩阵）+ 业务码校验 + 错误浮出。HTTP 全走注入的 fetchImpl
// （Mock 记录请求；零真发）。文案键经真实 i18n（en-US fallback 断言）。
import { describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "../core";

// BL-530：core.ts 账本面写穿落库（notify_mark/clear_delivery_failed）——本文件
// 只测渠道/重发流，invoke 一律回声（真后端契约由 core.test.ts / notifications_test 钉）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

type Req = { url: string; init: RequestInit };

/** 记录请求的假 fetch（可按序回放响应体）。 */
function mockFetch(responder: (req: Req, nth: number) => Response | Promise<Response>) {
  const calls: Req[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const req: Req = { url: String(input), init: init ?? {} };
    const nth = calls.length;
    calls.push(req);
    return await responder(req, nth);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });
const ok204 = (): Response => new Response(null, { status: 204 });
const okText = (t: string): Response => new Response(t, { status: 200 });

/** 标准告警事件（disk 91%、聚合 2 条——M-1 计数入正文后缀断言面）。 */
const alertEvent = {
  kind: "alert" as const,
  severity: "warning" as const,
  host_id: 7,
  title_key: "alert.title.disk",
  body: "web-01 disk / at 91.0% (threshold 90%)",
  payload: {
    rule_id: 1,
    rule_kind: "disk",
    rule_label: "Disk /",
    host_name: "web-01",
    value: "91.0%",
    suppressed: 2,
    channel_ids: [3],
  },
};

function bodyOf(req: Req): unknown {
  const raw = req.init.body;
  if (typeof raw !== "string") throw new Error("body must be string in tests");
  if (req.init.headers && (req.init.headers as Record<string, string>)["Content-Type"] === "application/json") {
    return JSON.parse(raw);
  }
  return raw;
}

describe("webhook 系（JSON POST）", () => {
  it("dingtalk：text 消息 golden + 加签 query（HMAC-SHA256/毫秒）+ errcode 校验", async () => {
    const { createDingtalkChannel } = await import("./dingtalk");
    const { calls, impl } = mockFetch(() => okJson({ errcode: 0 }));
    const ch = createDingtalkChannel(
      { webhook: "https://oapi.dingtalk.com/robot/send?access_token=T", secret: "SECx" },
      { fetchImpl: impl, now: () => 1_700_000_000_123 },
    );
    await ch.send(alertEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(
      "https://oapi.dingtalk.com/robot/send?access_token=T&timestamp=1700000000123&sign=",
    )).toBe(true);
    expect(bodyOf(calls[0])).toEqual({
      msgtype: "text",
      text: { content: "Disk usage alert\nweb-01 disk / at 91.0% (threshold 90%) (+2 merged)" },
    });

    // errcode 非 0 → 抛（业务码面）
    const bad = mockFetch(() => okJson({ errcode: 310000, errmsg: "sign not match" }));
    const ch2 = createDingtalkChannel(
      { webhook: "https://x", secret: "S" },
      { fetchImpl: bad.impl, now: () => 0 },
    );
    await expect(ch2.test()).rejects.toThrow("310000");
  });

  it("dingtalk：无 secret 不加签（URL 原样）", async () => {
    const { createDingtalkChannel } = await import("./dingtalk");
    const { calls, impl } = mockFetch(() => okJson({ errcode: 0 }));
    const ch = createDingtalkChannel(
      { webhook: "https://oapi.dingtalk.com/robot/send?access_token=T" },
      { fetchImpl: impl },
    );
    await ch.test();
    expect(calls[0].url).toBe("https://oapi.dingtalk.com/robot/send?access_token=T");
  });

  it("feishu：text golden + 秒级 timestamp/sign（KEY=ts\\nsecret 空消息）+ code 校验", async () => {
    const { createFeishuChannel } = await import("./feishu");
    const { calls, impl } = mockFetch(() => okJson({ code: 0 }));
    const ch = createFeishuChannel(
      { webhook: "https://open.feishu.cn/hook/H", secret: "SECx" },
      { fetchImpl: impl, now: () => 1_700_000_001_234 },
    );
    await ch.test();
    const payload = bodyOf(calls[0]) as Record<string, unknown>;
    expect(payload["msg_type"]).toBe("text");
    expect((payload["content"] as Record<string, string>)["text"]).toBe(
      "Ottr test alert\nIf you can read this, the channel works.",
    );
    expect(payload["timestamp"]).toBe("1700000001"); // 秒级（飞书面）
    expect(typeof payload["sign"]).toBe("string");

    const bad = mockFetch(() => okJson({ code: 19021, msg: "sign match fail" }));
    const ch2 = createFeishuChannel({ webhook: "https://x" }, { fetchImpl: bad.impl });
    await expect(ch2.test()).rejects.toThrow("19021");
  });

  it("wecom：text golden + 2048 字节截断 + errcode 校验", async () => {
    const { createWecomChannel } = await import("./wecom");
    const { calls, impl } = mockFetch(() => okJson({ errcode: 0 }));
    const ch = createWecomChannel({ webhook: "https://qyapi.weixin.qq.com/w" }, { fetchImpl: impl });
    await ch.send(alertEvent);
    expect(bodyOf(calls[0])).toEqual({
      msgtype: "text",
      text: { content: "Disk usage alert\nweb-01 disk / at 91.0% (threshold 90%) (+2 merged)" },
    });
    // 超长正文截断在 2048 字节内（多字节 CJK 不切出坏字节——TextDecoder 回环）
    const huge = { ...alertEvent, body: "测".repeat(3000) };
    await ch.send(huge);
    const content = (bodyOf(calls[1]) as { text: { content: string } }).text.content;
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(2048);
    expect(content.startsWith("Disk usage alert")).toBe(true); // 头部信息保全
  });

  it("telegram：sendMessage golden + ok 校验", async () => {
    const { createTelegramChannel } = await import("./telegram");
    const { calls, impl } = mockFetch(() => okJson({ ok: true }));
    const ch = createTelegramChannel(
      { bot_token: "BOT", chat_id: "-100123" },
      { fetchImpl: impl },
    );
    await ch.send(alertEvent);
    expect(calls[0].url).toBe("https://api.telegram.org/botBOT/sendMessage");
    expect(bodyOf(calls[0])).toEqual({
      chat_id: "-100123",
      text: "Disk usage alert\nweb-01 disk / at 91.0% (threshold 90%) (+2 merged)",
    });
    const bad = mockFetch(() => okJson({ ok: false, description: "chat not found" }));
    const ch2 = createTelegramChannel({ bot_token: "B", chat_id: "c" }, { fetchImpl: bad.impl });
    await expect(ch2.test()).rejects.toThrow("chat not found");
  });

  it("discord：content golden（粗体标题 + 2000 截断）+ 2xx 即成功", async () => {
    const { createDiscordChannel } = await import("./discord");
    const { calls, impl } = mockFetch(() => ok204());
    const ch = createDiscordChannel("https://discord.com/api/webhooks/1/T", { fetchImpl: impl });
    await ch.send(alertEvent);
    expect(bodyOf(calls[0])).toEqual({
      content: "**Disk usage alert**\nweb-01 disk / at 91.0% (threshold 90%) (+2 merged)",
    });
    const huge = { ...alertEvent, body: "x".repeat(3000) };
    await ch.send(huge);
    const content = (bodyOf(calls[1]) as { content: string }).content;
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it("slack：text golden（星号粗体）", async () => {
    const { createSlackChannel } = await import("./slack");
    const { calls, impl } = mockFetch(() => okText("ok"));
    const ch = createSlackChannel("https://hooks.slack.com/services/A/B/C", { fetchImpl: impl });
    await ch.send(alertEvent);
    expect(bodyOf(calls[0])).toEqual({
      text: "*Disk usage alert*\nweb-01 disk / at 91.0% (threshold 90%) (+2 merged)",
    });
  });

  it("webhook：缺省 payload {title,body}；模板插值 {{host}}/{{rule}}/{{value}}/{{severity}}/{{count}}；自定义头透传；坏模板显式抛", async () => {
    const { createWebhookChannel } = await import("./webhook");
    const { calls, impl } = mockFetch(() => ok204());
    const ch = createWebhookChannel(
      {
        url: "https://example.com/hook",
        headers: { Authorization: "Bearer tok" },
        body_template: '{"text":"{{rule}} on {{host}}: {{value}} ({{severity}}, {{count}})"}',
      },
      { fetchImpl: impl },
    );
    await ch.send(alertEvent);
    expect(calls[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    });
    expect(bodyOf(calls[0])).toEqual({
      text: "Disk / on web-01: 91.0% (warning, 2)",
    });

    // 无模板缺省 {title, body}
    const plain = createWebhookChannel({ url: "https://e.com" }, { fetchImpl: impl });
    await plain.test();
    expect(bodyOf(calls[1])).toEqual({
      title: "Ottr test alert",
      body: "If you can read this, the channel works.",
    });

    // 坏模板（渲染后非 JSON）显式抛
    const broken = createWebhookChannel(
      { url: "https://e.com", body_template: "{not json {{host}}" },
      { fetchImpl: impl },
    );
    await expect(broken.test()).rejects.toThrow("not valid JSON");
  });

  it("HTTP 非 2xx → HttpError（状态码+响应片段）", async () => {
    const { createSlackChannel } = await import("./slack");
    const { impl } = mockFetch(() => new Response("invalid_payload", { status: 404 }));
    const ch = createSlackChannel("https://hooks.slack.com/x", { fetchImpl: impl });
    await expect(ch.test()).rejects.toThrow("HTTP 404");
  });
});

describe("表单/文本系", () => {
  it("serverchan：表单 golden（title 32 字截断）+ code 校验", async () => {
    const { createServerchanChannel } = await import("./serverchan");
    const { calls, impl } = mockFetch(() => okJson({ code: 0 }));
    const ch = createServerchanChannel({ send_key: "SCT" }, { fetchImpl: impl });
    await ch.send(alertEvent);
    expect(calls[0].url).toBe("https://sctapi.ftqq.com/SCT.send");
    expect(calls[0].init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const fields = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
    expect(fields["title"]).toBe("Disk usage alert");
    expect(fields["desp"]).toContain("91.0%");
    const bad = mockFetch(() => okJson({ code: 40001, message: "key error" }));
    const ch2 = createServerchanChannel({ send_key: "K" }, { fetchImpl: bad.impl });
    await expect(ch2.test()).rejects.toThrow("40001");
  });

  it("pushover：表单 golden（token/user/title/message）+ status 校验", async () => {
    const { createPushoverChannel } = await import("./pushover");
    const { calls, impl } = mockFetch(() => okJson({ status: 1 }));
    const ch = createPushoverChannel({ token: "apptok", user: "ukey" }, { fetchImpl: impl });
    await ch.test();
    expect(calls[0].url).toBe("https://api.pushover.net/1/messages.json");
    const fields = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
    expect(fields).toEqual({
      token: "apptok",
      user: "ukey",
      title: "Ottr test alert",
      message: "If you can read this, the channel works.",
    });
    const bad = mockFetch(() => okJson({ status: 0, errors: ["user is invalid"] }));
    const ch2 = createPushoverChannel({ token: "t", user: "u" }, { fetchImpl: bad.impl });
    await expect(ch2.test()).rejects.toThrow("user is invalid");
  });

  it("ntfy：文本 POST golden（X-Title 头 + Bearer 令牌 + 自建服务器）", async () => {
    const { createNtfyChannel } = await import("./ntfy");
    const { calls, impl } = mockFetch(() => okText(""));
    const ch = createNtfyChannel(
      { topic: "ottr alerts", server: "https://ntfy.example.com/", token: "tk" },
      { fetchImpl: impl },
    );
    await ch.send(alertEvent);
    expect(calls[0].url).toBe("https://ntfy.example.com/ottr%20alerts"); // topic 转义 + 尾斜杠归一
    expect(calls[0].init.headers).toMatchObject({
      "X-Title": "Disk usage alert",
      Authorization: "Bearer tk",
    });
    expect(calls[0].init.body).toBe(
      "web-01 disk / at 91.0% (threshold 90%) (+2 merged)",
    );
  });

  it("bark：/push JSON golden（device_key + 自建服务器）+ code=200 校验", async () => {
    const { createBarkChannel } = await import("./bark");
    const { calls, impl } = mockFetch(() => okJson({ code: 200 }));
    const ch = createBarkChannel(
      { device_key: "DEV", server: "https://bark.example.com" },
      { fetchImpl: impl },
    );
    await ch.send(alertEvent);
    expect(calls[0].url).toBe("https://bark.example.com/push");
    expect(bodyOf(calls[0])).toEqual({
      title: "Disk usage alert",
      body: "web-01 disk / at 91.0% (threshold 90%) (+2 merged)",
      device_key: "DEV",
    });
    const bad = mockFetch(() => okJson({ code: 400, message: "bad device" }));
    const ch2 = createBarkChannel({ device_key: "d" }, { fetchImpl: bad.impl });
    await expect(ch2.test()).rejects.toThrow("400");
  });
});

describe("smtp（Rust lettre 命令面）", () => {
  it("经 vaultApi.smtpSend 真发；test() 固定测试文案", async () => {
    vi.doMock("../../vault/api", () => ({
      vaultApi: { smtpSend: vi.fn(async () => {}) },
    }));
    const { vaultApi } = await import("../../vault/api");
    const { createSmtpChannel } = await import("./smtp");
    const ch = createSmtpChannel(
      { host: "smtp.example.com", port: 465, from: "o@e.com", to: "a@e.com, b@e.com", mode: "starttls" },
    );
    await ch.send(alertEvent);
    expect(vaultApi.smtpSend).toHaveBeenCalledWith(
      { host: "smtp.example.com", port: 465, from: "o@e.com", to: "a@e.com, b@e.com", mode: "starttls" },
      "a@e.com, b@e.com",
      "Disk usage alert",
      "web-01 disk / at 91.0% (threshold 90%) (+2 merged)",
    );
    await ch.test();
    expect(vaultApi.smtpSend).toHaveBeenLastCalledWith(
      expect.anything(),
      "a@e.com, b@e.com",
      "Ottr test alert",
      "If you can read this, the channel works.",
    );
    vi.doUnmock("../../vault/api");
  });
});

describe("工厂分派 + 注册表挂载/路由", () => {
  it("createChannel 12 类全分派（实例 name 正确）", async () => {
    const { createChannel } = await import("./factory");
    const cases: [string, Record<string, unknown>, string][] = [
      ["dingtalk", { webhook: "https://d" }, "dingtalk"],
      ["feishu", { webhook: "https://f" }, "feishu"],
      ["wecom", { webhook: "https://w" }, "wecom"],
      ["bark", { device_key: "k" }, "bark"],
      ["serverchan", { send_key: "s" }, "serverchan"],
      ["telegram", { bot_token: "t", chat_id: "c" }, "telegram"],
      ["discord", { webhook: "https://di" }, "discord"],
      ["slack", { webhook: "https://s" }, "slack"],
      ["smtp", { host: "h", port: 465, from: "a@b", to: "c@d" }, "smtp"],
      ["pushover", { token: "t", user: "u" }, "pushover"],
      ["ntfy", { topic: "t" }, "ntfy"],
      ["webhook", { url: "https://u" }, "webhook"],
    ];
    for (const [kind, config, expected] of cases) {
      expect(createChannel(kind as never, config).name).toBe(expected);
    }
  });

  // 【fix round 1（C-1）】重试装饰不在工厂层——工厂只出裸适配器（name=裸 kind），
  // 装饰在 channelRegistry.mountOne 以挂载名（kind#id）收口；真实挂载链的
  // 集成回归在 frontend/notify/channelRegistry.test.ts（单测绕过 mountOne 测不到
  // 改名/装饰顺序缺陷）。

  it("remountChannels：读启用渠道→reveal→挂载；subscribed 按规则 channels 路由", async () => {
    vi.doMock("../../vault/api", () => ({
      vaultApi: {
        // BL-530：core.ts 账本面写穿用 notifications 组（本文件动态 import 的
        // core 模块实例被缓存，mock 需覆盖全用到的组）
        notifications: {
          markDeliveryFailed: async () => undefined,
          clearDeliveryFailure: async () => undefined,
        },
        notifyChannels: {
          list: async () => [
            { id: 3, kind: "slack", template_overrides: null, enabled: true, created_at: 1, updated_at: 1 },
            { id: 4, kind: "telegram", template_overrides: null, enabled: false, created_at: 1, updated_at: 1 },
          ],
          revealConfig: async (id: number) =>
            id === 3 ? { webhook: "https://hooks.slack.com/x" } : { bot_token: "t", chat_id: "c" },
        },
      },
    }));
    const { remountChannels } = await import("../channelRegistry");
    const { channels } = await import("../core");
    channels.length = 0;
    await remountChannels();
    expect(channels).toHaveLength(1); // 禁用渠道不挂载
    const mounted = channels[0];
    expect(mounted.name).toBe("slack#3");

    // 订阅面：alert 且 channel_ids 引用 → 收；否则不收
    expect(mounted.subscribed!(alertEvent)).toBe(true);
    expect(
      mounted.subscribed!({ ...alertEvent, payload: { ...alertEvent.payload, channel_ids: [9] } }),
    ).toBe(false);
    expect(mounted.subscribed!({ ...alertEvent, kind: "transfer", payload: {} })).toBe(false);
    channels.length = 0;
    vi.doUnmock("../../vault/api");
  });

  it("resendNotification：按挂载名回查渠道、行重建事件（剥失败标记）重跑 send；未挂载/抛错 = false", async () => {
    const { resendNotification } = await import("../channelRegistry");
    const { channels, recordDeliveryFailure, readDeliveryFailures, useNotifyStore } =
      await import("../core");
    const { withRetry } = await import("./retry");
    const seen: { event: NotificationEvent; ctx: unknown }[] = [];
    // 装饰后的渠道（生产挂载形态）：首发成功 → onDelivered 清账
    channels.push(
      withRetry(
        {
          name: "slack#3",
          send: async (e, ctx) => void seen.push({ event: e, ctx }),
          test: async () => {},
        },
        {},
      ),
    );

    const row = {
      id: 11,
      kind: "alert",
      severity: "warning",
      host_id: 7,
      title_key: "alert.title.disk",
      body: "web-01 disk /",
      payload: { rule_id: 1 },
      read: false,
      ts: 1000,
      delivery_failures: null,
    } as import("../../vault/api").Notification;
    useNotifyStore.setState({ items: [row], unread: 0 });
    // 此前终败的账面（recordDeliveryFailure → payload 带失败标记；写穿 invoke 已 mock 回声）
    await recordDeliveryFailure(11, { channel: "slack#3", channel_id: 3, error: "HTTP 502", ts: 1 });
    expect(readDeliveryFailures(useNotifyStore.getState().items[0].payload)).toHaveLength(1);

    const ok = await resendNotification(row, { channel: "slack#3", channel_id: 3, error: "HTTP 502", ts: 1 });
    expect(ok).toBe(true); // 重发翻正 → 标记清空
    expect(readDeliveryFailures(useNotifyStore.getState().items[0].payload)).toEqual([]);
    expect(seen).toHaveLength(1);
    // ctx（notificationId）是装饰器与管线的内部面：适配器只收事件本体；
    // notificationId 的流转已由「翻正 → 标记清空」（onDelivered 需它定位条目）证实
    expect(seen[0].ctx).toBeUndefined();
    expect(seen[0].event).toMatchObject({
      kind: "alert",
      severity: "warning",
      host_id: 7,
      title_key: "alert.title.disk",
      body: "web-01 disk /",
    });
    // 重建的事件剥掉失败标记（重发不自带旧账）
    expect((seen[0].event.payload as Record<string, unknown>)["delivery_failed"]).toBeUndefined();
    expect((seen[0].event.payload as Record<string, unknown>)["rule_id"]).toBe(1);

    // 未挂载渠道（名字对不上）→ false 不抛
    expect(
      await resendNotification(row, { channel: "gone#9", channel_id: 9, error: "e", ts: 1 }),
    ).toBe(false);

    // send 抛（不可重试面由装饰器兜，这里是未装饰渠道的防御）→ false 不抛
    channels[0] = {
      name: "slack#3",
      send: async () => {
        throw new Error("boom");
      },
      test: async () => {},
    };
    expect(
      await resendNotification(row, { channel: "slack#3", channel_id: 3, error: "e", ts: 1 }),
    ).toBe(false);
    channels.length = 0;
  });
});
