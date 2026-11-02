// provider 层工具调用测试（批次五 P2）：
//   * OpenAI 兼容面：请求体 tools 形态、assistant 的 tool_calls、tool 消息；
//     流式 `delta.tool_calls` 按 index 拼装 → 流末尾给出 toolCalls 增量；
//   * Anthropic 面：tools/input_schema 形态、tool_use / tool_result 块；
//     流式 content_block_start(tool_use) + input_json_delta 拼装；
//   * 降级：端点不认 tools（400/422）→ **自动重发不带 tools 的请求**，
//     降级为普通对话（不报错——工具是增强项）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai";
import type { ChatRequest, ChatTool } from "./provider";

/** 把字符串分片装成 SSE 响应。 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

const TOOLS: ChatTool[] = [
  {
    name: "mcp__srv-1__read_file",
    description: "读文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI 兼容面 · 工具调用", () => {
  it("请求体带 tools（function 形态）；assistant 带 tool_calls、tool 轮带 tool_call_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    for await (const _ of p.chat(
      req({
        tools: TOOLS,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "mcp__srv-1__read_file", arguments: '{"path":"/etc/hosts"}' }],
          },
          { role: "tool", content: "127.0.0.1 localhost", toolCallId: "call_1", toolName: "mcp__srv-1__read_file" },
        ],
      }),
    )) {
      void _;
    }
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "mcp__srv-1__read_file",
          description: "读文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "mcp__srv-1__read_file", arguments: '{"path":"/etc/hosts"}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "127.0.0.1 localhost",
    });
  });

  it("不带 tools 时请求体不含该字段（普通对话路径不变）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    for await (const _ of p.chat(req())) void _;
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("tools");
  });

  it("流式 delta.tool_calls 按 index 拼装 → 流末尾给出完整 toolCalls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"mcp__srv-1__read_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/etc/hosts\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    const deltas: { text: string; toolCalls?: { id: string; name: string; arguments: string }[] }[] = [];
    for await (const d of p.chat(req({ tools: TOOLS }))) deltas.push(d);
    const withCalls = deltas.filter((d) => d.toolCalls?.length);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0].toolCalls).toEqual([
      { id: "call_1", name: "mcp__srv-1__read_file", arguments: '{"path":"/etc/hosts"}' },
    ]);
  });

  it("端点不认 tools（400）→ 自动重发不带 tools 的请求（降级为普通对话，不报错）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"tools unsupported"}}', { status: 400 }))
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{"content":"照常回答"}}]}\n\ndata: [DONE]\n\n']),
      );
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("https://x/v1", "k", "m");
    let out = "";
    for await (const d of p.chat(req({ tools: TOOLS }))) out += d.text;
    expect(out).toBe("照常回答");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(first.tools).toBeDefined();
    expect(second).not.toHaveProperty("tools");
  });
});

describe("Anthropic 面 · 工具调用", () => {
  it("请求体带 tools（input_schema 形态）；tool_use / tool_result 块正确", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"type":"content_block_delta","delta":{"text":"好"}}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "k", "m");
    for await (const _ of p.chat(
      req({
        tools: TOOLS,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "toolu_1", name: "mcp__srv-1__read_file", arguments: '{"path":"/etc/hosts"}' }],
          },
          { role: "tool", content: "127.0.0.1 localhost", toolCallId: "toolu_1" },
        ],
      }),
    )) {
      void _;
    }
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        name: "mcp__srv-1__read_file",
        description: "读文件",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__srv-1__read_file",
          input: { path: "/etc/hosts" },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "127.0.0.1 localhost" }],
    });
  });

  it("连续的 tool 轮合并进同一条 user 消息（多 tool_result 块）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse(['data: {"type":"content_block_delta","delta":{"text":"好"}}\n\n']),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "k", "m");
    for await (const _ of p.chat(
      req({
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "toolu_1", name: "t1", arguments: "{}" },
              { id: "toolu_2", name: "t2", arguments: "{}" },
            ],
          },
          { role: "tool", content: "a", toolCallId: "toolu_1" },
          { role: "tool", content: "b", toolCallId: "toolu_2" },
        ],
      }),
    )) {
      void _;
    }
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toHaveLength(2);
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(body.messages[1].content[1]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_2" });
  });

  it("流式 content_block_start(tool_use) + input_json_delta 拼装", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__srv-1__read_file"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/etc/hosts\\"}"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "k", "m");
    const deltas: { text: string; toolCalls?: { id: string; name: string; arguments: string }[] }[] = [];
    for await (const d of p.chat(req({ tools: TOOLS }))) deltas.push(d);
    const withCalls = deltas.filter((d) => d.toolCalls?.length);
    expect(withCalls).toHaveLength(1);
    expect(withCalls[0].toolCalls).toEqual([
      { id: "toolu_1", name: "mcp__srv-1__read_file", arguments: '{"path":"/etc/hosts"}' },
    ]);
  });

  it("端点不认 tools（400）→ 自动重发不带 tools 的请求（降级为普通对话）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"tools extra"}}', { status: 400 }))
      .mockResolvedValueOnce(
        sseResponse(['data: {"type":"content_block_delta","delta":{"text":"照常回答"}}\n\n']),
      );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider("https://api.anthropic.com", "k", "m");
    let out = "";
    for await (const d of p.chat(req({ tools: TOOLS }))) out += d.text;
    expect(out).toBe("照常回答");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second).not.toHaveProperty("tools");
  });
});
