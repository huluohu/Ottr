// OpenAI 兼容 Provider（Task 13）：一个类覆盖 OpenAI/DeepSeek/Ollama 及任意
// 兼容端点（baseURL + apiKey + model 三元组；Ollama 预设见 ollama.ts）。
//
// 流式：POST {baseURL}/chat/completions stream=true，SSE `data:` 行逐条解析
// `choices[0].delta.content`；`data: [DONE]` 收口。apiKey 为空时不发 Authorization
// 头（Ollama 本地端点无需鉴权；发了反而部分代理拒空 Bearer）。
//
// testConnection：非流式一发（max_tokens=16），校验 HTTP 状态与响应可解析——
// 「测试连接」按钮的消费面；错误尽量带端点返回的 message。
//
// 工具调用（批次五 P2）：请求体带 `tools: [{type:"function", function:{…}}]`；
// assistant 轮 → `tool_calls`，tool 轮 → `{role:"tool", tool_call_id, content}`；
// 流式解析 `choices[].delta.tool_calls`（按 index 拼装）→ 流末尾作为 toolCalls 增量给出。
// **端点不认 tools**（400/422）→ 自动重发不带 tools 的请求（降级为普通对话，不报错）。
import { outboundFetch } from "../notify/channels/outboundFetch";
import type { ChatMessage, ChatRequest, ChatTool, ToolCall } from "./provider";
/** 设置页存储的 Provider 元数据（settings `ai_providers` JSON 数组；**不含
 * apiKey**——key 走 vault secrets 表按 providerId 密封）。 */
export interface ProviderMeta {
  /** 实例 id（uuid 形态即可，secrets 键 = `ai.apikey.<id>`）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 实现种类：openai 兼容端点（含 DeepSeek/Ollama）、Anthropic，或 mock
   * （测试端点——批次三 T3 审计 16：与真实 provider 同视觉权重易误用，设置页
   * 加「测试用」徽标；协议面按 openai 兼容走，badge 仅展示语义）。 */
  kind: "openai-compatible" | "anthropic" | "mock";
  /** 端点根（约定见 provider.ts 文件头）。 */
  baseURL: string;
  /** 模型名（gpt-4o-mini / deepseek-chat / qwen2.5:7b …）。 */
  model: string;
  /** 启用/禁用（2026-10-16 用户需求）：false = 不参与任何 AI 链路（诊断/
   * NL→命令/纪要统一取「首个未禁用」的 provider）。缺省（旧数据无字段）=
   * 启用——零迁移。列表位次语义不变：首位仍是默认，禁用只是旁路。 */
  enabled?: boolean;
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

/**
 * OpenAI 兼容面的 usage 段 → ChatUsage（畸形/缺失 → undefined）。
 *
 * 独立成函数是为了让「解析失败 = 拿不到」这件事**局部化**：端点回
 * `"usage":"not-an-object"` 或只回一半字段时，这里返回 undefined，调用方
 * 降级为不显示 token 数，绝不影响文本流。
 */
export function parseOpenAiUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const { prompt_tokens: input, completion_tokens: output } = usage;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { inputTokens: input, outputTokens: output };
}

/**
 * 工具定义 → OpenAI 兼容面请求体形态。
 * （Anthropic 面形态不同：`{name, description, input_schema}`——见 anthropic.ts。）
 */
export function encodeTool(tool: ChatTool): {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  };
}

/**
 * 消息 → OpenAI 兼容面请求体形态。
 *
 * * assistant 带工具调用 → `{role:"assistant", content, tool_calls:[{id, type, function}]}`；
 * * tool 轮 → `{role:"tool", tool_call_id, content}`；
 * * 其余（user/assistant）原样。
 */
export function encodeOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * 端点是否「不支持 tools」（400/422）。
 *
 * 部分 OpenAI 兼容端点与自建网关不认 `tools` 字段（400 "Unsupported parameter"
 * 或 422 schema 校验失败）——命中即**降级为普通对话**（重发不带 tools 的请求），
 * 工具是增强项，不能反过来把 AI 功能搞挂。
 */
export function isToolUnsupported(status: number): boolean {
  return status === 400 || status === 422;
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

  /** 请求体（`withTools=false` 时不带 tools 字段——降级面）。 */
  private body(req: ChatRequest, withTools: boolean): string {
    return JSON.stringify({
      model: this.model,
      stream: true,
      max_tokens: req.maxTokens,
      // 用量透明化（2026-11-02 批次一 B 项）：OpenAI 兼容面靠这个开关才在
      // 流式末帧回 usage。部分国产/代理端点不认该字段（400 或静默忽略）——
      // 那时拿不到 usage，UI 降级为只显示模型名与耗时（见 ChatDelta 注释）。
      stream_options: { include_usage: true },
      // stop 序列（NL→命令）：OpenAI 兼容面字段即 `stop`（string[]）
      ...(req.stop?.length ? { stop: req.stop } : {}),
      // 工具定义（批次五 P2）：有 tools 才带（端点不认 → 降级重发，见 chat）。
      ...(withTools && req.tools?.length
        ? { tools: req.tools.map((t: ChatTool) => encodeTool(t)) }
        : {}),
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...encodeOpenAiMessages(req.messages),
      ],
    });
  }

  async *chat(req: ChatRequest): AsyncIterable<import("./provider").ChatDelta> {
    const useTools = Array.isArray(req.tools) && req.tools.length > 0;
    const send = async (withTools: boolean): Promise<Response> =>
      outboundFetch(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        signal: req.signal,
        body: this.body(req, withTools),
      });
    let res = await send(useTools);
    if (!res.ok && useTools && isToolUnsupported(res.status)) {
      // 端点不认 tools（部分国产/自建网关）→ **降级为普通对话**（不报错）：
      // 重发一不带 tools 的请求，模型照常回答。
      res = await send(false);
    }
    if (!res.ok || !res.body) {
      throw new Error(await httpError(res));
    }
    // 工具调用碎片拼装器（按 index 聚合 name/arguments；id 只在首帧出现）。
    const pending = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let json: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          text?: string;
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue; // 非法行跳过（端点注释/心跳）
      }
      // 工具调用碎片（旁路收集：拼装在流末尾统一给出）。
      for (const tc of json.choices?.[0]?.delta?.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = pending.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(idx, cur);
      }
      // usage 解析是**旁路**：畸形字段不得污染主文本流（整帧 try 已在上面）。
      const usage = parseOpenAiUsage(json.usage);
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? "";
      const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
      const model = json.model;
      // 产出规则：文本帧产 text；usage/model/finishReason 帧即便无文本也产出，
      // 让调用方拿到「这一轮的用量」——但纯空帧（无任何附加信息）不产出。
      if (delta !== "") {
        yield { text: delta, usage, model, finishReason };
      } else if (usage || model || finishReason) {
        yield { text: "", usage, model, finishReason };
      }
    }
    // 工具调用增量（流末尾给出；有则必带 id/name/arguments）。
    if (pending.size > 0) {
      const toolCalls: ToolCall[] = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, c]) => ({
          id: c.id || `call_${idx}`,
          name: c.name,
          arguments: c.args,
        }));
      yield { text: "", toolCalls };
    }
  }

  /** 非流式一发（「测试连接」按钮）：成功返回模型回的第一段文本。 */
  async testConnection(): Promise<string> {
    const res = await outboundFetch(this.endpoint, {
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
