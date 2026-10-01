// Anthropic Provider（Task 13）：Messages API 流式（SSE），system 为顶层参数、
// max_tokens 必填——与 OpenAI 兼容面的差异都在请求/事件形态上。
// baseURL 约定 = https://api.anthropic.com（本层追加 /v1/messages）。
import type { ChatDelta, ChatRequest } from "./provider";
import { httpError, sseData } from "./openai";

export class AnthropicProvider {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private get endpoint(): string {
    return `${this.baseURL.replace(/\/+$/, "")}/v1/messages`;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        // 借助浏览器 fetch 的 OAuth 兜底（anthropic-dangerous-direct-browser-access）
        // 需要 CORS 允许；本头显式声明直连意图，端点拒绝时错误原样上抛。
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal: req.signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        stream: true,
        // stop 序列（NL→命令）：Anthropic 面字段名 = stop_sequences
        ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(await httpError(res));
    }
    for await (const data of sseData(res.body)) {
      let json: {
        type?: string;
        delta?: { type?: string; text?: string };
        error?: { message?: string };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.type === "error") {
        throw new Error(json.error?.message ?? "anthropic stream error");
      }
      if (json.type === "content_block_delta" && json.delta?.text) {
        yield { text: json.delta.text };
      }
      // message_stop / ping / content_block_start 等事件不产文本
    }
  }

  /** 非流式一发（「测试连接」）。 */
  async testConnection(): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) {
      throw new Error(await httpError(res));
    }
    const json = (await res.json()) as { content?: { text?: string }[] };
    return json.content?.map((c) => c.text ?? "").join("") ?? "";
  }
}
