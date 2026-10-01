// provider 层测试（T13 Step 3）：mock fetch 的 SSE 流式消费（OpenAI 兼容 +
// Anthropic 两套事件形态）、abort 传播、测试连接非流式一发、MockProvider。
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import { createProvider, type ChatRequest } from "./provider";
import { OpenAICompatibleProvider } from "./openai";

/** 把字符串分片装成 SSE 响应（ReadableStream 逐片 yield，模拟网络分包）。 */
function sseResponse(chunks: string[], ok = true): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: ok ? 200 : 500 });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleProvider 流式", () => {
  it("SSE delta 逐块聚合，[DONE] 收口", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"原因"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"是磁盘"}}]}\n\ndata: {"choices":[{"delta":{"content":"满了"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://api.deepseek.com", "sk-test", "deepseek-chat");
    let out = "";
    for await (const d of p.chat(req())) out += d.text;
    expect(out).toBe("原因是磁盘满了");
    // 端点拼接：baseURL 无版本尾斜杠 + /chat/completions；Bearer 头在位
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64);
    // 本用例未传 system：messages 只有 user 一条
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("SSE 行被分包撕裂也能正确拼行", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"del',
        'ta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta"',
        ':{"content":"B"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("http://localhost:11434/v1", "", "qwen2.5:7b");
    let out = "";
    for await (const d of p.chat(req())) out += d.text;
    expect(out).toBe("AB");
    // 空 apiKey（Ollama）不发 Authorization
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("非 2xx → 错误带端点 error.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse('{"error":{"message":"bad key"}}', 401)),
    );
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    await expect((async () => {
      for await (const _ of p.chat(req())) void _;
    })()).rejects.toThrow("HTTP 401: bad key");
  });

  it("abort：signal 传入 fetch，已中断的请求被 fetch 拒绝", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      // 模拟 fetch 契约：已中止的 signal → AbortError
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      return Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']));
    });
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    controller.abort();
    await expect((async () => {
      for await (const _ of p.chat(req({ signal: controller.signal }))) void _;
    })()).rejects.toThrow();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it("testConnection：非流式一发并取 message.content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      textResponse('{"choices":[{"message":{"content":"pong"}}]}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    expect(await p.testConnection()).toBe("pong");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(false);
  });
});

describe("AnthropicProvider 流式", () => {
  it("content_block_delta 聚合；system 走顶层参数；头三件套在位", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"text":"，世界"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "ak-test", "claude-sonnet");
    let out = "";
    for await (const d of p.chat(req({ system: "你是诊断助手" }))) out += d.text;
    expect(out).toBe("你好，世界");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("你是诊断助手");
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("流内 error 事件显式抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['data: {"type":"error","error":{"message":"overloaded"}}\n\n']),
      ),
    );
    const p = new AnthropicProvider("https://api.anthropic.com", "k", "m");
    await expect((async () => {
      for await (const _ of p.chat(req())) void _;
    })()).rejects.toThrow("overloaded");
  });
});

describe("MockProvider / 工厂", () => {
  it("脚本切块产出 + 请求记录（诊断链路断言面）", async () => {
    const mock = new MockProvider(["原因：", "磁盘满"]);
    let out = "";
    for await (const d of mock.chat(req({ maxTokens: 128 }))) out += d.text;
    expect(out).toBe("原因：磁盘满");
    expect(mock.requests[0].maxTokens).toBe(128);
  });

  it("createProvider 按 kind 分派", async () => {
    const anthropic = createProvider(
      { id: "a", name: "A", kind: "anthropic", baseURL: "https://api.anthropic.com", model: "m" },
      "k",
    );
    expect(anthropic).toBeInstanceOf(AnthropicProvider);
    const openai = createProvider(
      { id: "o", name: "O", kind: "openai-compatible", baseURL: "https://x/v1", model: "m" },
      "k",
    );
    expect(openai).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
