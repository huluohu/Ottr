// Token 用量 / 模型名 / 停止原因解析（2026-11-02 批次一 B 项）。
//
// 透明化的前提是**端点真的回用量**——OpenAI 兼容面靠 `stream_options.
// include_usage`（末帧带 usage），Anthropic 面靠 `message_start` /
// `message_delta` 事件。三条硬纪律：
// 1. **优雅降级**：端点不给 usage（如部分国产/代理端点）时**不得报错**——
//    拿不到就不显示 token 数，透明化不能反过来把 AI 功能搞挂；
// 2. **解析旁路**：usage 解析失败绝不能污染主文本流；
// 3. **模型名以响应为准**：端点回传的 model 比本地 settings 快照更可信
//    （用户可能改过模型，端点回传才是当次真实模型）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai";
import type { ChatRequest } from "./provider";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI 兼容面 usage 解析", () => {
  it("末帧 usage → ChatDelta.usage（输入/输出 token）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider(
      "https://api.deepseek.com",
      "sk-test",
      "deepseek-chat",
    );
    let text = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let model: string | undefined;
    for await (const d of p.chat(req())) {
      text += d.text;
      if (d.usage) usage = d.usage;
      if (d.model) model = d.model;
    }
    expect(text).toBe("好");
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(model).toBe("deepseek-chat");
  });

  it("请求带 stream_options.include_usage（否则端点不回用量）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://api.deepseek.com", "sk-test", "m");
    for await (const _ of p.chat(req())) {
      /* drain */
    }
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("端点不给 usage → 不报错、不产出 usage（优雅降级）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://api.example.com", "sk-test", "m");
    let text = "";
    let sawUsage = false;
    for await (const d of p.chat(req())) {
      text += d.text;
      if (d.usage) sawUsage = true;
    }
    expect(text).toBe("好");
    expect(sawUsage).toBe(false);
  });

  it("usage 字段畸形 → 跳过该字段，文本流不受影响", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
        'data: {"usage":"not-an-object"}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://api.example.com", "sk-test", "m");
    let text = "";
    let sawUsage = false;
    for await (const d of p.chat(req())) {
      text += d.text;
      if (d.usage) sawUsage = true;
    }
    expect(text).toBe("A");
    expect(sawUsage).toBe(false);
  });
});

describe("Anthropic 面 usage 解析", () => {
  it("message_start 的 input_tokens + message_delta 的 output_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"message_start","message":{"model":"claude-3-5-sonnet","usage":{"input_tokens":88}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":17}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "sk-ant", "claude-3-5-sonnet");
    let text = "";
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let model: string | undefined;
    for await (const d of p.chat(req())) {
      text += d.text;
      if (d.usage) usage = d.usage;
      if (d.model) model = d.model;
    }
    expect(text).toBe("好");
    expect(usage).toEqual({ inputTokens: 88, outputTokens: 17 });
    expect(model).toBe("claude-3-5-sonnet");
  });

  it("stop_reason → finishReason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "sk-ant", "m");
    let finishReason: string | undefined;
    for await (const d of p.chat(req())) {
      if (d.finishReason) finishReason = d.finishReason;
    }
    expect(finishReason).toBe("end_turn");
  });
});
