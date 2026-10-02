// 12 渠道适配器 golden 单测（Phase 3 Task 3，B5）：每渠道真实 payload 格式
// 冻结（spec §7 渠道矩阵）+ 业务码校验 + 错误浮出。HTTP 全走注入的 fetchImpl
// （Mock 记录请求；零真发）。文案键经真实 i18n（en-US fallback 断言）。
import { describe, expect, it, vi } from "vitest";

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

  it("remountChannels：读启用渠道→reveal→挂载；subscribed 按规则 channels 路由", async () => {
    vi.doMock("../../vault/api", () => ({
      vaultApi: {
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
});
