// MCP 工具注册表（批次五 P2「AI 工具调用循环」前端侧）。
//
// 职责：把「已启用的外部 MCP server 的工具目录」摊平成 provider 中立的
// `ChatTool[]`，并保留**可还原**的绑定关系（serverId + 原始工具名）——
// 模型只会回一个工具名，调用时必须还原成 `mcp_server_call(id, tool, argsJson)`。
//
// 工具名规范：`mcp__<serverId>__<toolName>`（serverId 段与工具名段用 `__` 分隔）。
// 工具名里可能有点/斜杠等字符 → 规范化到 `[A-Za-z0-9_-]`（模型侧的工具名
// 约束宽松，但统一字符集便于还原与日志检索）。
//
// 取数纪律：
// * **每次 AI run 现取**（不缓存到 vault——server 的工具目录会随 server 版本变）；
// * 某个 server 起不来/超时 → **跳过该 server**，其余照常（一个坏 server
//   不该让整个 AI 功能变哑）；
// * 清单读不到（vault 锁定等）→ 返回空表（降级为普通对话，不报错）。
import { vaultApi, type McpServerInfo, type McpToolInfo } from "../vault/api";
import type { ChatTool } from "./provider";

/** provider 中立工具名的前缀（模型看到的就是 `mcp__…`）。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 一个工具与它的「可还原绑定」（serverId + 原始工具名）。 */
export interface McpToolBinding {
  /** provider 中立工具名（`mcp__<serverId>__<tool>`）。 */
  name: string;
  /** 工具描述（可能为空串）。 */
  description: string;
  /** 入参 JSON Schema（对象）。 */
  parameters: unknown;
  /** MCP server id（vault 里的 uuid）。 */
  serverId: string;
  /** 展示名（server 的 name）。 */
  serverName: string;
  /** **原始**工具名（调用时还原用——规范化可能有损，原始名只在绑定里）。 */
  tool: string;
}

/** 规范化一段（serverId / 工具名）：非 `[A-Za-z0-9_-]` 一律换下划线。 */
export function normalizeToolSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 组装 provider 中立工具名（`mcp__<serverId>__<tool>`）。 */
export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${normalizeToolSegment(serverId)}__${normalizeToolSegment(tool)}`;
}

/**
 * 从 provider 中立工具名**粗解析**出 serverId 与（规范化后的）工具名。
 *
 * 注意：规范化有损（`foo.bar` → `foo_bar`），**原始工具名只能从注册表还原**——
 * 本函数只用于「注册表里没有该名字」的兜底路径（此时只能拿规范化名去试）。
 */
export function parseMcpToolName(name: string): { serverId: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const serverId = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (tool === "") return null;
  return { serverId, tool };
}

/** 当前注册表（最近一次 loadMcpTools 的结果；按 provider 中立名索引）。 */
let catalog = new Map<string, McpToolBinding>();

/** 注册表快照（诊断/测试用）。 */
export function mcpToolCatalog(): McpToolBinding[] {
  return [...catalog.values()];
}

/**
 * 工具名 → 绑定（还原 serverId 与原始工具名）。
 *
 * 命中注册表 → 精确还原；未命中（server 已被删/改名）→ 返回 null——调用面据此
 * 回一条「工具不可用」的说明给模型，而不是拿错 server 去调。
 */
export function resolveMcpTool(name: string): McpToolBinding | null {
  const hit = catalog.get(name);
  if (hit) return hit;
  return null;
}

/** 入参 schema 解析（原始 JSON 文本 → 对象；解析失败 = 宽松的空对象 schema）。 */
export function parseToolSchema(inputSchema: string | undefined | null): unknown {
  if (!inputSchema || inputSchema.trim() === "") {
    return { type: "object", properties: {} };
  }
  try {
    const v = JSON.parse(inputSchema) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    return { type: "object", properties: {} };
  } catch {
    return { type: "object", properties: {} };
  }
}

/**
 * 一次 AI run 的工具快照：工具清单 + **本请求自己的绑定表**。
 *
 * Task 3（ask-ottr-orb）：模型回工具名时的还原必须用**发起请求的那份快照**，
 * 不允许读模块级「最近一次」注册表——两次 run 之间 server 被删/改名时，用旧
 * 注册表还原会把调用打去错误的对象。绑定对象浅冻结（调用面只读）。
 */
export interface McpToolSnapshot {
  tools: ChatTool[];
  bindings: ReadonlyMap<string, McpToolBinding>;
}

/**
 * 取当前可用的 MCP 工具（**每次 run 现取**）。
 *
 * * 只收 `enabled` 的 server（禁用的 server 连不上，`connect` 直接拒）；
 * * 单个 server 取工具失败 → 跳过该 server（其余照常）；
 * * 名字撞车（同一 server 内两个工具规范化后同名）→ **后者不暴露**（模型只
 *   看得见无歧义的那个）。
 */
export async function loadMcpToolSnapshot(): Promise<McpToolSnapshot> {
  let servers: McpServerInfo[];
  try {
    const list = await vaultApi.mcpClients.list();
    servers = Array.isArray(list) ? list : [];
  } catch {
    // 清单读不到（vault 锁定/后端不可达）→ 无工具（降级为普通对话）。
    return { tools: [], bindings: new Map() };
  }
  const bindings: McpToolBinding[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server.enabled) continue;
    let tools: McpToolInfo[];
    try {
      tools = await vaultApi.mcpClients.tools(server.id);
    } catch {
      // 该 server 起不来/超时 → 跳过（**不让一个坏 server 哑掉整个 AI 功能**）。
      continue;
    }
    for (const tool of Array.isArray(tools) ? tools : []) {
      const name = mcpToolName(server.id, tool.name);
      if (seen.has(name)) continue; // 撞名 → 只留第一个（无歧义优先）
      seen.add(name);
      bindings.push(
        Object.freeze({
          name,
          description: tool.description ?? "",
          parameters: parseToolSchema(tool.inputSchema),
          serverId: server.id,
          serverName: server.name,
          tool: tool.name,
        }),
      );
    }
  }
  const map = new Map(bindings.map((b) => [b.name, b]));
  return {
    tools: bindings.map((b) => ({
      name: b.name,
      description: b.description,
      parameters: b.parameters,
    })),
    bindings: map,
  };
}

/**
 * 兼容面：只取工具清单。**运行链禁用本入口**（还原绑定必须走
 * loadMcpToolSnapshot 的请求内快照）；本函数仅为既有消费面/测试保留，
 * 并维持旧的全局注册表语义（resolveMcpTool）。
 */
export async function loadMcpTools(): Promise<ChatTool[]> {
  const snapshot = await loadMcpToolSnapshot();
  catalog = new Map(snapshot.bindings);
  return snapshot.tools;
}
