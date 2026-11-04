// MCP 工具注册表测试（批次五 P2）：
//   * 工具名规范化（`mcp__<serverId>__<tool>`，点/斜杠 → `_`）与还原；
//   * 只收**已启用** server 的工具；
//   * 某个 server 起不来（tools 失败）→ **跳过该 server，其余照常**；
//   * 清单读不到 → 降级为空表（AI 照常聊天，不报错）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  hostToolSnapshot,
  isHostToolName,
  loadMcpTools,
  mcpToolName,
  parseMcpToolName,
  resolveMcpTool,
} from "./mcpTools";

const mockedInvoke = invoke as unknown as Mock;

interface ServerSpec {
  id: string;
  name: string;
  enabled: boolean;
  tools?: { name: string; description: string; inputSchema: string }[];
  toolsError?: string;
}

/** 按 server 清单装 invoke 桩。 */
function mockServers(servers: ServerSpec[], listError?: string): void {
  mockedInvoke.mockImplementation((cmd: string, args?: { id: string }) => {
    if (cmd === "mcp_servers_list") {
      if (listError) return Promise.reject(new Error(listError));
      return Promise.resolve(
        servers.map((s) => ({
          id: s.id,
          name: s.name,
          command: "npx",
          args: [],
          enabled: s.enabled,
          envNames: [],
        })),
      );
    }
    if (cmd === "mcp_server_tools") {
      const s = servers.find((x) => x.id === args?.id);
      if (!s) return Promise.reject(new Error("no such server"));
      if (s.toolsError) return Promise.reject(new Error(s.toolsError));
      return Promise.resolve(s.tools ?? []);
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("工具名规范化与还原", () => {
  it("mcp__<serverId>__<tool>；点/斜杠等非法字符归一为下划线", () => {
    expect(mcpToolName("srv-1", "read_file")).toBe("mcp__srv-1__read_file");
    expect(mcpToolName("srv-1", "read/file.txt")).toBe("mcp__srv-1__read_file_txt");
    expect(mcpToolName("srv 1", "a.b")).toBe("mcp__srv_1__a_b");
  });

  it("parseMcpToolName 还原 serverId 与工具名段（非本前缀 → null）", () => {
    expect(parseMcpToolName("mcp__srv-1__read_file")).toEqual({
      serverId: "srv-1",
      tool: "read_file",
    });
    expect(parseMcpToolName("mcp__srv-1__a__b")).toEqual({ serverId: "srv-1", tool: "a__b" });
    expect(parseMcpToolName("read_file")).toBeNull();
    expect(parseMcpToolName("mcp__srv-1__")).toBeNull();
  });
});

describe("loadMcpTools", () => {
  it("收集已启用 server 的工具 → ChatTool[]（名字带 server 段）", async () => {
    mockServers([
      {
        id: "srv-1",
        name: "files",
        enabled: true,
        tools: [
          {
            name: "read_file",
            description: "读文件",
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"}}}',
          },
        ],
      },
      {
        id: "srv-2",
        name: "off",
        enabled: false,
        tools: [{ name: "secret_tool", description: "", inputSchema: "{}" }],
      },
    ]);
    const tools = await loadMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__srv-1__read_file");
    expect(tools[0].description).toBe("读文件");
    expect(tools[0].parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    // 禁用的 server 不取工具（也不该起进程）
    expect(mockedInvoke.mock.calls.some(([c]) => c === "mcp_server_tools")).toBe(true);
    expect(
      mockedInvoke.mock.calls.filter(([c, a]) => c === "mcp_server_tools" && (a as { id: string }).id === "srv-2"),
    ).toHaveLength(0);
  });

  it("某个 server 起不来 → 跳过该 server，其余照常", async () => {
    mockServers([
      { id: "srv-bad", name: "bad", enabled: true, toolsError: "spawn failed" },
      {
        id: "srv-ok",
        name: "ok",
        enabled: true,
        tools: [{ name: "ping", description: "ping", inputSchema: "{}" }],
      },
    ]);
    const tools = await loadMcpTools();
    expect(tools.map((t) => t.name)).toEqual(["mcp__srv-ok__ping"]);
  });

  it("清单读不到 → 空表（降级为普通对话，不抛错）", async () => {
    mockServers([], "vault is locked");
    await expect(loadMcpTools()).resolves.toEqual([]);
  });

  it("resolveMcpTool 还原原始工具名（规范化有损时以注册表为准）", async () => {
    mockServers([
      {
        id: "srv-1",
        name: "files",
        enabled: true,
        tools: [{ name: "read/file.txt", description: "", inputSchema: "{}" }],
      },
    ]);
    await loadMcpTools();
    const binding = resolveMcpTool("mcp__srv-1__read_file_txt");
    expect(binding).not.toBeNull();
    expect(binding?.serverId).toBe("srv-1");
    expect(binding?.serverName).toBe("files");
    // 原始名带斜杠——规范化丢了，靠注册表还原
    expect(binding?.tool).toBe("read/file.txt");
    // 未注册的名字 → null（不猜 server）
    expect(resolveMcpTool("mcp__nope__x")).toBeNull();
  });

  it("同一 server 内工具名规范化后撞车 → 只暴露一个（无歧义优先）", async () => {
    mockServers([
      {
        id: "srv-1",
        name: "files",
        enabled: true,
        tools: [
          { name: "a.b", description: "", inputSchema: "{}" },
          { name: "a_b", description: "", inputSchema: "{}" },
        ],
      },
    ]);
    const tools = await loadMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp__srv-1__a_b");
  });
});

// 内建主机工具（2026-11-04 第一步）：工具目录 = 外部 MCP 工具 + 内建主机工具。
describe("内建主机工具目录", () => {
  it("有活目标 → 四个内建工具进目录，绑定随快照走（名字可还原）", () => {
    const snap = hostToolSnapshot({ enabled: true, mode: "plan", readProbe: true });
    expect(snap.tools.map((t) => t.name)).toEqual([
      "ottr_read_output",
      "ottr_read_file",
      "ottr_list_dir",
      "ottr_exec_command",
    ]);
    expect(snap.bindings.get("ottr_exec_command")?.tool).toBe("ottr_exec_command");
    expect(snap.bindings.get("ottr_read_file")).toBeTruthy();
  });

  it("没有活目标 → 不加内建工具（打不到任何主机，给了只是让模型空转）", () => {
    const snap = hostToolSnapshot({ enabled: false, mode: "plan", readProbe: true });
    expect(snap.tools).toEqual([]);
    expect(snap.bindings.size).toBe(0);
  });

  it("执行类工具的描述随模式变（模型必须知道自己这轮会不会真跑）", () => {
    const plan = hostToolSnapshot({ enabled: true, mode: "plan", readProbe: true })
      .tools.find((t) => t.name === "ottr_exec_command");
    const manual = hostToolSnapshot({ enabled: true, mode: "manual", readProbe: true })
      .tools.find((t) => t.name === "ottr_exec_command");
    const auto = hostToolSnapshot({ enabled: true, mode: "auto", readProbe: true })
      .tools.find((t) => t.name === "ottr_exec_command");
    expect(plan?.description).not.toBe(manual?.description);
    expect(manual?.description).not.toBe(auto?.description);
  });

  // 2026-11-04 修补 B3：AI 只读探查总开关关闭 → 读文件 / 列目录**不进目录**
  // （模型根本看不到这两个工具），其余工具不受影响。
  it("只读探查关闭 → 读文件 / 列目录不进目录（其余工具照旧）", () => {
    const snap = hostToolSnapshot({ enabled: true, mode: "plan", readProbe: false });
    expect(snap.tools.map((t) => t.name)).toEqual([
      "ottr_read_output",
      "ottr_exec_command",
    ]);
    expect(snap.bindings.has("ottr_read_file")).toBe(false);
    expect(snap.bindings.has("ottr_list_dir")).toBe(false);
    expect(snap.bindings.has("ottr_read_output")).toBe(true);
    expect(snap.bindings.has("ottr_exec_command")).toBe(true);
  });

  it("内建工具名不与外部 MCP 工具重名（ottr_ 前缀天然隔离）", () => {
    expect(isHostToolName("ottr_exec_command")).toBe(true);
    expect(isHostToolName("mcp__srv-1__read_file")).toBe(false);
  });
});
