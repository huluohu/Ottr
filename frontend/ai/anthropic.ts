// Anthropic Provider（Task 13）：Messages API 流式（SSE），system 为顶层参数、
// max_tokens 必填——与 OpenAI 兼容面的差异都在请求/事件形态上。
// baseURL 约定 = https://api.anthropic.com（本层追加 /v1/messages）。
//
// 工具调用（批次五 P2）：请求体带 `tools: [{name, description, input_schema}]`；
// assistant 的 tool_use → `{role:"assistant", content:[{type:"tool_use",…}]}`；
// tool 结果 → `{role:"user", content:[{type:"tool_result",…}]}`；
// 流式：`content_block_start` 的 tool_use + 后续 `input_json_delta` 拼装。
// **端点不认 tools**（400/422）→ 自动重发不带 tools 的请求（降级为普通对话）。
import type { ChatDelta, ChatMessage, ChatRequest, ChatTool, ToolCall } from "./provider";
import { httpError, isToolUnsupported, sseData } from "./openai";
import { outboundFetch } from "../notify/channels/outboundFetch";

/** 工具定义 → Anthropic 面请求体形态（`input_schema`，非 OpenAI 的 parameters）。 */
export function encodeAnthropicTool(tool: ChatTool): {
  name: string;
  description: string;
  input_schema: unknown;
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  };
}

/** 参数 JSON 文本 → Anthropic 的 `input`（**必须是对象**；解析失败 = 空对象）。 */
function parseToolInput(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 消息 → Anthropic 面请求体形态。
 *
 * * assistant 带工具调用 → `{role:"assistant", content:[{type:"text"}?, {type:"tool_use"}…]}`；
 * * tool 轮 → `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}`；
 *   **连续的 tool 轮合并进同一个 user 消息**（多个 tool_result 块）——Anthropic
 *   的角色交替要求同角色的相邻消息成一条。
 */
export function encodeAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      const last = out[out.length - 1] as
        | { role: string; content: { type: string }[] }
        | undefined;
      if (last && last.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: unknown[] = [];
      if (m.content.trim() !== "") blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parseToolInput(tc.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export class AnthropicProvider {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private get endpoint(): string {
    return `${this.baseURL.replace(/\/+$/, "")}/v1/messages`;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      // 借助浏览器 fetch 的 OAuth 兜底（anthropic-dangerous-direct-browser-access）
      // 需要 CORS 允许；本头显式声明直连意图，端点拒绝时错误原样上抛。
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  /** 请求体（`withTools=false` 时不带 tools 字段——降级面）。 */
  private body(req: ChatRequest, withTools: boolean): string {
    return JSON.stringify({
      model: this.model,
      max_tokens: req.maxTokens,
      stream: true,
      // stop 序列（NL→命令）：Anthropic 面字段名 = stop_sequences
      ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
      // 工具定义（批次五 P2）：有 tools 才带（端点不认 → 降级重发，见 chat）。
      ...(withTools && req.tools?.length
        ? { tools: req.tools.map((t: ChatTool) => encodeAnthropicTool(t)) }
        : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: encodeAnthropicMessages(req.messages),
    });
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
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
      // 端点不认 tools → **降级为普通对话**（重发不带 tools 的请求，不报错）。
      res = await send(false);
    }
    if (!res.ok || !res.body) {
      throw new Error(await httpError(res));
    }
    // Anthropic 的用量**分散在两个事件**里：message_start 给 input_tokens，
    // message_delta 给 output_tokens——两端都到齐才产出 usage（半截数据不显示）。
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let model: string | undefined;
    // 工具调用拼装器：content_block_start(tool_use) 开块，input_json_delta 续参数。
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    for await (const data of sseData(res.body)) {
      let json: {
        type?: string;
        index?: number;
        delta?: {
          type?: string;
          text?: string;
          stop_reason?: string | null;
          partial_json?: string;
        };
        content_block?: { type?: string; id?: string; name?: string };
        message?: { model?: string; usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number; input_tokens?: number };
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
      if (json.type === "message_start") {
        if (typeof json.message?.usage?.input_tokens === "number") {
          inputTokens = json.message.usage.input_tokens;
        }
        if (typeof json.message?.model === "string") {
          model = json.message.model;
        }
      }
      if (json.type === "message_delta") {
        if (typeof json.usage?.output_tokens === "number") {
          outputTokens = json.usage.output_tokens;
        }
        // 有些端点在 message_delta 也带 input_tokens（补齐口径）。
        if (inputTokens === undefined && typeof json.usage?.input_tokens === "number") {
          inputTokens = json.usage.input_tokens;
        }
      }
      // 工具调用块（旁路收集：拼装在流末尾统一给出）。
      const idx = typeof json.index === "number" ? json.index : 0;
      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        blocks.set(idx, {
          id: json.content_block.id ?? "",
          name: json.content_block.name ?? "",
          json: "",
        });
      }
      if (json.type === "content_block_delta" && json.delta?.type === "input_json_delta") {
        const cur = blocks.get(idx);
        if (cur) cur.json += json.delta.partial_json ?? "";
      }
      const finishReason = json.delta?.stop_reason ?? undefined;
      const usage =
        inputTokens !== undefined && outputTokens !== undefined
          ? { inputTokens, outputTokens }
          : undefined;
      const text = json.type === "content_block_delta" ? (json.delta?.text ?? "") : "";
      if (text !== "") {
        yield { text, usage, model, finishReason };
      } else if (usage || model || finishReason) {
        yield { text: "", usage, model, finishReason };
      }
      // message_stop / ping 等事件不产文本
    }
    // 工具调用增量（流末尾给出）。
    if (blocks.size > 0) {
      const toolCalls: ToolCall[] = [...blocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, b]) => ({
          id: b.id || `toolu_${idx}`,
          name: b.name,
          arguments: b.json,
        }));
      yield { text: "", toolCalls };
    }
  }

  /** 非流式一发（「测试连接」）。 */
  async testConnection(): Promise<string> {
    const res = await outboundFetch(this.endpoint, {
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
