// AI 工具调用循环（状态机）测试（批次五 P2）：
//   * 模型发起工具调用 → **不自动执行**（无 mcp_server_call）→ 本轮暂停
//     （status=awaiting_tool_approval）+ 挂待确认卡片；
//   * 用户点「执行」→ 调 MCP server → 结果作为 tool 消息入历史 → **续跑一轮**
//     （完整历史再发给模型）→ 最终回答；
//   * 用户点「拒绝」→ 追加「用户拒绝执行」的 tool 消息 → 同样续跑一轮；
//   * 轮次上限（MAX_TOOL_ROUNDS=5）：超限不再执行工具，给用户一句说明。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ChatDelta, ChatRequest, ToolCall } from "./provider";
import i18n from "../i18n";
import { MAX_TOOL_ROUNDS, useAiStore, type DiagnoseRequest } from "./aiStore";
import { resetRateLimiter, setNotifyPorts } from "../notify/core";

/** 工具名（与 mcpTools 的规范化规则一致）。 */
const TOOL_NAME = "mcp__srv-1__read_file";

/** 每轮 provider 的产出脚本（按轮次索引）。 */
let script: (turn: number, req: ChatRequest) => ChatDelta[] = () => [{ text: "最终回答" }];
/** 已发出的请求（按轮次顺序）。 */
let requests: ChatRequest[] = [];
let turnIndex = 0;

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => ({
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        const turn = turnIndex++;
        requests.push(req);
        for (const d of script(turn, req)) {
          await Promise.resolve();
          yield d;
        }
      },
      async testConnection(): Promise<string> {
        return "ok";
      },
    }),
  };
});

const mockedInvoke = invoke as unknown as Mock;

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 7,
  hostName: "web-01",
  exitCode: 1,
  command: "cat /etc/hosts",
};

/** 后端桩：设置 / key / tail / MCP server 清单与调用。 */
function mockBackend(over: { toolResult?: { text: string; isError: boolean } } = {}) {
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") {
          return Promise.resolve([
            {
              id: "p1",
              name: "DeepSeek",
              kind: "openai-compatible",
              baseURL: "https://api.deepseek.com",
              model: "deepseek-chat",
            },
          ]);
        }
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "session_tail":
        return Promise.resolve("ok\n");
      case "hosts_get":
        return Promise.resolve(null);
      case "mcp_servers_list":
        return Promise.resolve([
          {
            id: "srv-1",
            name: "files",
            command: "npx",
            args: [],
            enabled: true,
            envNames: [],
          },
        ]);
      case "mcp_server_tools":
        return Promise.resolve([
          { name: "read_file", description: "读文件", inputSchema: '{"type":"object"}' },
        ]);
      case "mcp_server_call":
        return Promise.resolve(over.toolResult ?? { text: "127.0.0.1 localhost", isError: false });
      case "notify_insert":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

/** 发起首轮并等到「待确认工具调用」态。 */
async function runUntilPending(): Promise<void> {
  useAiStore.getState().onCommandFailed(REQ);
  await vi.waitFor(() => {
    expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("awaiting_tool_approval");
  });
}

/** 一次工具调用的标准形态。 */
function toolCall(id: string, args = '{"path":"/etc/hosts"}'): ToolCall {
  return { id, name: TOOL_NAME, arguments: args };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  mockedInvoke.mockReset();
  requests = [];
  turnIndex = 0;
  script = () => [{ text: "最终回答" }];
  useAiStore.setState({ sessions: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 0, focused: () => false, system: async () => {} });
});

describe("工具调用循环（状态机）", () => {
  it("模型发起工具调用 → 不自动执行 → 本轮暂停 + 挂待确认项", async () => {
    mockBackend();
    script = (turn) =>
      turn === 0
        ? [{ text: "我需要读文件", toolCalls: [toolCall("call_1")] }]
        : [{ text: "读完了" }];
    await runUntilPending();

    const st = useAiStore.getState().sessions["tab-1"]!;
    expect(st.status).toBe("awaiting_tool_approval");
    expect(st.pendingToolCalls).toHaveLength(1);
    expect(st.pendingToolCalls![0]).toMatchObject({
      id: "call_1",
      serverId: "srv-1",
      serverName: "files",
      tool: "read_file",
      args: '{"path":"/etc/hosts"}',
    });
    // **没有自动执行**：一次 mcp_server_call 都不该发生
    expect(mockedInvoke.mock.calls.some(([c]) => c === "mcp_server_call")).toBe(false);
    // 助手轮已入历史（含工具调用）
    const assistant = st.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.[0]?.name).toBe(TOOL_NAME);
  });

  it("用户点「执行」→ 调 MCP server → 结果入历史 → 续跑一轮给出最终回答", async () => {
    mockBackend();
    script = (turn) =>
      turn === 0
        ? [{ text: "我需要读文件", toolCalls: [toolCall("call_1")] }]
        : [{ text: "文件里有 127.0.0.1 localhost" }];
    await runUntilPending();

    await useAiStore.getState().resolveToolCall("tab-1", "call_1", true);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    // 调用参数：还原出 serverId 与**原始**工具名
    const call = mockedInvoke.mock.calls.find(([c]) => c === "mcp_server_call");
    expect(call?.[1]).toMatchObject({
      id: "srv-1",
      tool: "read_file",
      argsJson: '{"path":"/etc/hosts"}',
    });

    const st = useAiStore.getState().sessions["tab-1"]!;
    // 历史：user → assistant(工具调用) → tool(结果) → assistant(最终回答)
    expect(st.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const toolTurn = st.messages.find((m) => m.role === "tool")!;
    // 工具返回**脱敏后**入历史（与终端输出尾同一纪律：内容一律脱敏后存）
    expect(toolTurn.content).toContain("[REDACTED_IPV4_1] localhost");
    expect(toolTurn.content).not.toContain("127.0.0.1");
    expect(toolTurn.toolCallId).toBe("call_1");
    expect(toolTurn.serverName).toBe("files");

    // 续跑的那一轮：完整历史（含助手工具调用轮 + tool 结果轮）都发了出去
    expect(requests).toHaveLength(2);
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1].toolCalls?.[0]).toMatchObject({ id: "call_1", name: TOOL_NAME });
    expect(second[2]).toMatchObject({ role: "tool", toolCallId: "call_1" });
    // 第二轮也带了工具清单（模型可以继续调）
    expect(requests[1].tools?.[0]?.name).toBe(TOOL_NAME);
    // 落库的助手轮同样是脱敏后的（模型回显的敏感值不留明文在历史里）
    expect(st.messages[st.messages.length - 1].content).toContain("[REDACTED_IPV4_1] localhost");
  });

  it("用户点「拒绝」→ 不调用 MCP server，追加拒绝说明并续跑一轮", async () => {
    mockBackend();
    script = (turn) =>
      turn === 0
        ? [{ text: "我需要读文件", toolCalls: [toolCall("call_1")] }]
        : [{ text: "好，那我基于已知信息回答" }];
    await runUntilPending();

    await useAiStore.getState().resolveToolCall("tab-1", "call_1", false);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    expect(mockedInvoke.mock.calls.some(([c]) => c === "mcp_server_call")).toBe(false);
    const st = useAiStore.getState().sessions["tab-1"]!;
    const toolTurn = st.messages.find((m) => m.role === "tool")!;
    expect(toolTurn.content).toContain("拒绝");
    expect(st.answer).toContain("基于已知信息回答");
  });

  it("工具执行失败 → 错误说明入历史，模型仍能据此作答", async () => {
    mockBackend({ toolResult: { text: "", isError: true } });
    script = (turn) =>
      turn === 0
        ? [{ text: "读文件", toolCalls: [toolCall("call_1")] }]
        : [{ text: "读不到，继续诊断" }];
    await runUntilPending();
    await useAiStore.getState().resolveToolCall("tab-1", "call_1", true);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });
    const toolTurn = useAiStore.getState().sessions["tab-1"]!.messages.find(
      (m) => m.role === "tool",
    )!;
    expect(toolTurn.content).toContain("失败");
  });

  it("轮次上限：最多 5 轮工具调用，超限后停手并给出说明", async () => {
    mockBackend();
    script = (turn, req) =>
      req.tools && req.tools.length > 0
        ? [{ text: "", toolCalls: [toolCall(`call_${turn}`)] }]
        : [{ text: "已达上限，我基于已有信息作答" }];
    await runUntilPending();

    // 逐轮批准：每轮批准后模型再次发起调用
    for (let round = 1; round < MAX_TOOL_ROUNDS; round++) {
      const st = useAiStore.getState().sessions["tab-1"]!;
      const pending = st.pendingToolCalls![0];
      await useAiStore.getState().resolveToolCall("tab-1", pending.id, true);
      await vi.waitFor(() => {
        const s = useAiStore.getState().sessions["tab-1"]!;
        expect(s.pendingToolCalls ?? []).toHaveLength(1);
      });
    }

    // 第 5 轮：批准后模型又发起调用 → **超限**：不再挂待确认项
    const st5 = useAiStore.getState().sessions["tab-1"]!;
    await useAiStore.getState().resolveToolCall("tab-1", st5.pendingToolCalls![0].id, true);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const final = useAiStore.getState().sessions["tab-1"]!;
    expect(final.pendingToolCalls ?? []).toHaveLength(0);
    // 超限的那一轮：不再执行工具（mcp_server_call 只跑了 5 次）
    const callCount = mockedInvoke.mock.calls.filter(([c]) => c === "mcp_server_call").length;
    expect(callCount).toBe(MAX_TOOL_ROUNDS);
    // 历史里有「已达上限」的说明，且最后一轮**不带工具**
    const limitTurns = final.messages.filter((m) => m.role === "tool" && m.content.includes("上限"));
    expect(limitTurns.length).toBeGreaterThan(0);
    const lastReq = requests[requests.length - 1];
    expect(lastReq.tools).toBeUndefined();
    expect(final.answer).toContain("已达上限");
  });

  // R4（ask-ottr-orb Task 3）：同一待确认调用的**双击**——挂起标记必须先于
  // 一切 await 落位，第二击在同步检查就被挡下 → mcp_server_call 恰好一次。
  it("R4：双击执行同一待确认调用 → mcp_server_call 恰好一次", async () => {
    mockBackend();
    script = (turn) =>
      turn === 0
        ? [{ text: "我需要读文件", toolCalls: [toolCall("call_1")] }]
        : [{ text: "读完了" }];
    await runUntilPending();

    // 模拟连击：两次调用同步发出（不 await 第一个完成）
    void useAiStore.getState().resolveToolCall("tab-1", "call_1", true);
    void useAiStore.getState().resolveToolCall("tab-1", "call_1", true);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const calls = mockedInvoke.mock.calls.filter(([c]) => c === "mcp_server_call");
    expect(calls).toHaveLength(1);
    // 只入账一条 tool 轮（不重复）
    const st = useAiStore.getState().sessions["tab-1"]!;
    expect(st.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });
});
