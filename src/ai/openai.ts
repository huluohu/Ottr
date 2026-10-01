// OpenAI 兼容 Provider（Task 13）：一个类覆盖 OpenAI/DeepSeek/Ollama 及任意
// 兼容端点（baseURL + apiKey + model 三元组；Ollama 预设见 ollama.ts）。
//
// 流式：POST {baseURL}/chat/completions stream=true，SSE `data:` 行逐条解析
// `choices[0].delta.content`；`data: [DONE]` 收口。apiKey 为空时不发 Authorization
// 头（Ollama 本地端点无需鉴权；发了反而部分代理拒空 Bearer）。
//
// testConnection：非流式一发（max_tokens=16），校验 HTTP 状态与响应可解析——
// 「测试连接」按钮的消费面；错误尽量带端点返回的 message。
/** 设置页存储的 Provider 元数据（settings `ai_providers` JSON 数组；**不含
 * apiKey**——key 走 vault secrets 表按 providerId 密封）。 */
export interface ProviderMeta {
  /** 实例 id（uuid 形态即可，secrets 键 = `ai.apikey.<id>`）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 实现种类：openai 兼容端点（含 DeepSeek/Ollama）或 Anthropic。 */
  kind: "openai-compatible" | "anthropic";
  /** 端点根（约定见 provider.ts 文件头）。 */
  baseURL: string;
  /** 模型名（gpt-4o-mini / deepseek-chat / qwen2.5:7b …）。 */
  model: string;
}

/** SSE 行切分缓冲上限（防无换行的病态流无限吃内存）。 */
const SSE_BUFFER_CAP = 1 << 20;

/** 从响应体逐条解析 SSE `data:` 载荷（跨 chunk 缓冲拼行；[DONE] 由消费方判定）。
 * export = Anthropic Provider 复用同一 SSE 解析（internal helper，非公共契约）。 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > SSE_BUFFER_CAP) {
        throw new Error("sse buffer overflow (endpoint not speaking SSE?)");
      }
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 统一错误：非 2xx 时尽力取端点的 error.message（OpenAI/DeepSeek/Ollama 同形态）。
 * export = Anthropic Provider 复用（internal helper）。 */
export async function httpError(res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // body 不可读：只报状态码
  }
  return `HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

export class OpenAICompatibleProvider {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private get endpoint(): string {
    return `${this.baseURL.replace(/\/+$/, "")}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey !== "") h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async *chat(req: import("./provider").ChatRequest): AsyncIterable<import("./provider").ChatDelta> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        max_tokens: req.maxTokens,
        // stop 序列（NL→命令）：OpenAI 兼容面字段即 `stop`（string[]）
        ...(req.stop?.length ? { stop: req.stop } : {}),
        messages: [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          ...req.messages,
        ],
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(await httpError(res));
    }
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") return;
      let json: {
        choices?: { delta?: { content?: string | null }; text?: string }[];
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue; // 非法行跳过（端点注释/心跳）
      }
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? "";
      if (delta !== "") yield { text: delta };
    }
  }

  /** 非流式一发（「测试连接」按钮）：成功返回模型回的第一段文本。 */
  async testConnection(): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) {
      throw new Error(await httpError(res));
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? "";
  }
}
