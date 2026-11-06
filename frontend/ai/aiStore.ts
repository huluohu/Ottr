// AI 诊断 store（Task 13，核心卖点链路；2026-10-19 方案 A 会话作用域化）：
//   exit_code≠0（xterm OSC133 监听，CommandWatch）→ openDiagnose → run：
//   读 settings → 会话输出尾（8KB）→ 脱敏（redact）→ provider.chat
//   流式渲染 → 完成落通知（notify kind="ai"，T12 管线预留位）。
// 选中解释（右键「解释」）→ openExplain → 同一 run 链（单轮，无 tail）。
//
// **会话作用域（2026-10-19 用户裁定方案 A）**：面板状态按 sessionId 各自一份
// （sessions 映射）——任何会话的失败只写自己那份，面板只渲染在所属会话的
// 终端视图旁；后台会话失败不再抢当前视图（页签「待看」琥珀点引导，DiagnosePanel
// 挂载即 markSeen）。此前全局单槽的三个问题（后台弹窗打断 / 无主机归属 /
// 「插入终端」错写他台 PTY 的危险面）随作用域化一并消除。并发流允许（每会话
// 独立 AbortController，A 会话流式中 B 失败互不干扰）。
//
// **目标绑定与运行身份（ask-ottr-orb Task 3）**：
// * 每个会话一份**对话**（conversationId + messages + draft），绑定捕获时的
//   不可变目标（AiScopeTarget）。面板 close = 摘「open」旗标（request=null），
//   历史/草稿保留——重开同活目标续对话；显式 newConversation / 目标换代才清。
// * runId + AbortController 在**首个 await 之前**创建；每个 await 返回后复核
//   身份（控制器 + runId + request 旗标 + 目标仍活 + vault 未锁），被取代的
//   迟到准备一律丢弃（R3），不得复活/覆盖新切片。
// * 每轮 run（含追问轮）开自己的 scope（aiSessionApi.open，TTL 15 min——
//   每 run 现开比跨 run 缓存便宜且诚实）；上下文走 ai_scope_context（同作用域
//   的尾 + 备注）；abort/取消/被取代/close/lifecycle 失效 → revoke。
// * 插入绑定随轮落库（turn.scopeId/runId）：生成于哪个终端就只能插回哪个
//   终端（CodeBlockRow 生产守卫禁跨目标，绝不静默改插当前终端）。
//
// 裁定与护栏：
// * BYOK 直连：provider 明文 key 只经 vault secrets 单点出库 → createProvider
//   闭包/请求头，不落任何 store/state；
// * abort：AbortController 收口在 store（面板按钮 → abort），AbortError
//   归为 aborted 态而非 error（用户主动取消不是故障）；**按会话隔离**——
//   关闭/取消某会话面板绝不波及其他会话的在途流；
// * 未配置 provider / key：status="error" + noProvider/noKey 标记，面板引导
//   去设置页（不静默失败）；
// * 通知失败绝不反噬诊断链路（与 notify/core 纪律一致）。
// * 会话收尾清理：App 把 dropSession 搭在 setSessionLifecycleHook 的 closed
//   事件上（store 纯状态机、不反向依赖 AI 链路的既有惯例不变）。
import { create } from "zustand";
import i18n from "../i18n";
import { notify } from "../notify/core";
import { vaultApi } from "../vault/api";
import {
  createProvider,
  type ChatMessage,
  type ChatTool,
  type ChatUsage,
  type ProviderMeta,
  type ToolCall,
} from "./provider";
import { redact, type RedactFinding, type RedactOptions } from "./redact";
import { buildHostContextBlock, fetchHostNotes } from "./hostContext";
import {
  loadMcpToolSnapshot,
  hostToolSnapshot,
  type HostToolBinding,
  type HostToolName,
  type McpToolBinding,
} from "./mcpTools";
import {
  DEFAULT_AI_EXEC_MODE,
  awaitingPlanSteps,
  needsModeUpgrade,
  normalizeAiExecMode,
  newPlanStepId,
  planTargetKey,
  readDefaultAiExecMode,
  upsertPlanStep,
  type AiExecMode,
  type PlanStep,
  type PlanStepResult,
} from "./aiModes";
import { readAiReadProbeEnabled } from "./aiReadProbe";
import { classify } from "./danger";
import {
  TAIL_BYTES,
  activeProvider,
  apiKeySecretKey,
  loadAiSettings,
  type AiSettings,
} from "./settings";
import { aiSessionApi, type AiScope, type AiScopeRunResult } from "./sessionApi";
import {
  captureAiTarget,
  isAiTargetLive,
  type AiFocusState,
  type AiScopeTarget,
} from "../session/aiTarget";
import { useSessionStore } from "../session/SessionStore";
import { useVaultLockStore } from "../security/VaultLockStore";

/** SessionStore 全量切片 → isAiTargetLive 的入参面（纯函数不拖多余字段）。 */
function sessionFocusState(): AiFocusState {
  const s = useSessionStore.getState();
  return { activeId: s.activeId, activePane: s.activePane, sessions: s.sessions };
}

/** 诊断请求（exit_code≠0 自动触发 / 手动重试同面）。 */
export interface DiagnoseRequest {
  kind: "diagnose";
  sessionId: string;
  /** Rust 侧会话 id（session_tail 取数；null = 未连接） */
  rustId: string | null;
  hostId: number | null;
  hostName: string;
  exitCode: number | null;
  /** 触发诊断的命令行（含提示符原文；脱敏在 run 内做） */
  command: string;
}

/** 选中解释请求（右键菜单）。 */
export interface ExplainRequest {
  kind: "explain";
  sessionId: string;
  hostId: number | null;
  hostName: string;
  /** 选区文本（脱敏在 run 内做） */
  text: string;
}

/**
 * 主动提问（2026-11-02 批次四 P0「Ask Ottr 上下文入口」）。
 *
 * 与诊断的区别：**没有失败命令**——用户对当前会话/主机自由提问（"这台机器
 * 还剩多少内存？" "刚才那个报错到底什么意思？"）。上下文仍然带（最近输出尾
 * + 主机备注），但不带「退出码 + 失败命令」那段诊断语境。
 */
export interface AskRequest {
  kind: "ask";
  sessionId: string;
  /** Rust 侧会话 id（取输出尾用；null = 未连接）。 */
  rustId: string | null;
  hostId: number | null;
  hostName: string;
  /** 入口捕获的不可变终端目标（Task 3）：openAskForFocusedTerminal 定格；
   *  null/缺省 = 无绑定（旧入口/测试面——插入面禁用，上下文走 legacy 通道）。 */
  target?: AiScopeTarget | null;
}

export type AiRequest = DiagnoseRequest | ExplainRequest | AskRequest;

export type AiStatus =
  | "idle"
  | "running"
  | "done"
  | "aborted"
  | "error"
  /** 工具调用待用户确认（本轮**暂停**——模型不得自动触发工具）。 */
  | "awaiting_tool_approval";

/** 错误细分（面板引导用）：未配 provider / 未配 key / 端点与网络错误。 */
export type AiErrorKind = "noProvider" | "noKey" | "request";

/**
 * 对话的一轮（2026-11-02 批次二 C 项：多轮追问会话）。
 *
 * **内容一律脱敏后存**（追加进历史时 redact 一次）——历史要反复发给模型，
 * 存明文等于把敏感值长期留在内存里并多次出网。
 *
 * 角色扩到三种（批次五 P2 工具轮）：assistant 轮可带 `toolCalls`（它发起了
 * 哪些工具调用），tool 轮带 `toolCallId` / `toolName`（对应哪次调用、什么工具）。
 */
export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  /** assistant 轮：它发起的工具调用。 */
  toolCalls?: ToolCall[];
  /** tool 轮：对应的调用 id（provider 的 call id）。 */
  toolCallId?: string;
  /** tool 轮：工具名（原始名）。 */
  toolName?: string;
  /** tool 轮：展示用的 server 名。 */
  serverName?: string;
  /** assistant 轮：产出本轮的 run 打开的 scope id（插入绑定面——
   *  生成于哪个终端/哪次授权，就只能插回哪里；Task 3）。 */
  scopeId?: string | null;
  /** assistant 轮：产出本轮的 run id（插入 actionId 前缀 + 身份面）。 */
  runId?: string | null;
  /** 用户停止或插话时保留的部分回答，不视为完整回答。 */
  interrupted?: boolean;
  /** Ask user turn 的已脱敏原问题，用于失败重试时重组首轮上下文。 */
  retryContent?: string;
}

/**
 * 待确认的工具调用（批次五 P2）。
 *
 * **AI 不自动执行任何东西**——本应用的既有安全模型是「模型给建议、用户执行」
 * （诊断面板里的命令是插入终端、不是自动跑）。工具调用同此：模型发起后**挂起**
 * 本轮，等用户点「执行 / 拒绝」。
 */
export interface PendingToolCall {
  /** provider 的调用 id（与助手轮的 toolCalls 对应）。 */
  id: string;
  /** MCP server id（vault uuid；调用时还原用）。 */
  serverId: string;
  /** 展示名（server 的 name）。 */
  serverName: string;
  /** 原始工具名（调用时还原用）。 */
  tool: string;
  /** 参数 JSON 文本（**原样展示**——用户看到的即将被执行的参数）。 */
  args: string;
  /** 发起该调用的 run id（执行前复验运行身份——被取代的链不得再执行）。 */
  runId?: string | null;
}

/** 工具循环轮次上限（防模型无限调工具烧 token；BYOK 用户自掏腰包）。 */
export const MAX_TOOL_ROUNDS = 5;

/** 单会话的 AI 面板状态切片（诊断/解释/提问共用同一份）。 */
export interface SessionAiState {
  request: AiRequest | null;
  status: AiStatus;
  answer: string;
  errorKind: AiErrorKind | null;
  error: string | null;
  /** 脱敏命中（面板展示「已脱敏 N 处」）。 */
  redactions: RedactFinding[];
  /** 本轮设置快照（面板展示 provider/model；run 前为 null）。 */
  settingsUsed: AiSettings | null;
  /** 面板已被用户看过（页签「待看」徽标 = 有 request 且未看过）。 */
  seen: boolean;
  /** 本轮用量（2026-11-02 批次一 B 项）：端点回传的 token 数；端点不给 = null。 */
  usage: ChatUsage | null;
  /** 本轮实际使用的模型名（端点回传优先，回落 settings 快照）。 */
  modelUsed: string | null;
  /** 本轮耗时（毫秒；发请求 → 流结束）。 */
  elapsedMs: number | null;
  /** 对话历史（多轮追问会话，2026-11-02 批次二 C 项；脱敏后存储）。
   *  首轮的 user 轮 = 装配后的诊断/解释上下文（含命令 + 输出尾 + 主机备注）。 */
  messages: ChatTurn[];
  /** 待确认的工具调用（批次五 P2；**模型发起、用户点执行**才真跑）。 */
  pendingToolCalls?: PendingToolCall[];
  /** 本链已消耗的工具轮次（上限 MAX_TOOL_ROUNDS）。 */
  toolRounds?: number;
  /** 正在执行的工具调用 id（非空 = 执行中，按钮置灰）。 */
  runningToolCallId?: string | null;
  /** 内建主机工具正在执行；此时不能把对话截在未完成的 tool 消息中间。 */
  runningHostToolCallId?: string | null;
  /** 与在途主机工具标记配对的 run id；旧工具迟到完成时只清自己的标记。 */
  runningHostToolRunId?: string | null;
  /** provider 流已开始；准备阶段仍可打字，但不能替换首轮提问。 */
  streamStartedRunId?: string | null;
  /** 对话 id（per paneSessionId；close 隐藏不清，新对话/换代才换新）。 */
  conversationId: string;
  /** 对话绑定的不可变终端目标（null = 未捕获到活终端——插入面禁用）。 */
  target: AiScopeTarget | null;
  /** 最近一次 run 打开的 scope（后端捕获的身份面：endpoint/username 展示 +
   *  scopeId 插入授权；run 结束保留到 close/lifecycle/TTL）。 */
  scope: AiScope | null;
  /** 当前/最近一次 run 的 id（supersede 判定 + 插入 actionId 前缀）。 */
  runId: string | null;
  /** 输入草稿（面板关闭保留；新对话/换代清空；追问提交即清）。 */
  draft: string;
  /** 重连换代后旧对话只读（历史可见 + 提示；续问须走新对话）。 */
  conversationReadonly: boolean;
  /** 会话级执行模式（2026-11-04 第一步；**可选字段**——缺省视为 plan）。
   *  plan = 只产计划、绝不执行；auto = 自动档（授权主机上的白名单命令当场
   *  执行，其余降级为逐条确认，red 级直接拒）；manual = 逐条确认。
   *  随对话保持；新对话复位到默认档。 */
  mode?: AiExecMode;
  /** 计划步骤清单（plan 模式下登记的执行类动作；可选字段，缺省视为空）。 */
  plan?: PlanStep[];
}

const EMPTY_SLICE: SessionAiState = {
  request: null,
  status: "idle",
  answer: "",
  errorKind: null,
  error: null,
  redactions: [],
  settingsUsed: null,
  seen: false,
  usage: null,
  modelUsed: null,
  elapsedMs: null,
  messages: [],
  pendingToolCalls: [],
  toolRounds: 0,
  runningToolCallId: null,
  runningHostToolCallId: null,
  runningHostToolRunId: null,
  streamStartedRunId: null,
  conversationId: "",
  target: null,
  scope: null,
  runId: null,
  draft: "",
  conversationReadonly: false,
  mode: DEFAULT_AI_EXEC_MODE,
  plan: [],
};

interface AiStore {
  /** 按会话 id 的面板状态（方案 A：无全局槽，一切读写经 sessionId）。 */
  sessions: Record<string, SessionAiState>;

  /** exit_code≠0 入口（ai.enabled=false 时静默丢弃——总开关只管自动触发；
   * 手动「解释」不受限）。开关现读 settings（失败按开处理——诊断是能力面，
   * 配置读不出不该变哑）。只写 req.sessionId 自己的切片（同会话新失败取代
   * 旧面板；**他会话面板不受影响**——方案 A 与旧全局单槽的本质分野）。
   * 新失败 = 新对话（绑定该会话此刻的目标快照）。 */
  onCommandFailed: (req: DiagnoseRequest) => void;
  /** 右键「解释」入口（不受 ai.enabled 管——用户显式动作）。 */
  openExplain: (req: ExplainRequest) => void;
  /** Ask Ottr 入口（批次四 P0）：为会话开「提问」态面板（用户显式动作，
   *  不受 ai.enabled 管——那是「命令失败自动诊断」的开关）。
   *  同一活目标重开 = **续对话**（历史/草稿/对话 id 保留）；目标已换代或
   *  旧对话只读 = 自动开新对话（旧消息绝不换绑到新连接）。 */
  openAsk: (req: AskRequest) => void;
  /** 关闭某会话的面板（在途请求一并 abort + scope 撤销；**历史/草稿保留**，
   *  只摘 request 旗标；不影响他会话）。 */
  close: (sessionId: string) => void;
  /** 取消某会话的在途流（面板停止按钮）：面板保留、status 落 aborted
   * （用户主动取消不是故障）；非运行态调用是 no-op。 */
  abort: (sessionId: string) => void;
  /** 停止当前回复并发送插话，保留已生成内容。expectedRunId 防止同一发送动作重放。 */
  interrupt: (sessionId: string, text: string, expectedRunId: string | null) => Promise<void>;
  /** 标记面板已被看过（清除页签「待看」徽标；DiagnosePanel 挂载时调用）。 */
  markSeen: (sessionId: string) => void;
  /** 会话收尾清理（App 搭 setSessionLifecycleHook closed 事件；abort + 撤 scope + 摘切片）。 */
  dropSession: (sessionId: string) => void;
  /** 显式开新对话（面板「新对话」动作）：清历史/草稿/只读标记，request 保留。 */
  newConversation: (sessionId: string) => void;
  /** 草稿写入（面板输入框；面板关闭时拒收——不留幽灵切片）。 */
  patchDraft: (sessionId: string, text: string) => void;
  /** AI 会话生命周期订阅消费面（App 搭 setSessionLifecycleHook 注入）：
   *  closed → dropSession；disconnected/reconnected → scope 全撤；重连后
   *  旧对话（目标已死）标只读。 */
  handleSessionLifecycle: (e: { type: "closed" | "disconnected" | "reconnected"; session: { id: string } }) => void;
  /** 执行/重试当前会话的请求；`followupText` 非空 = 追问轮（只带对话历史，
   *  不重取输出尾 / 不重注入主机备注）。重试（无追问文本）= 替换末轮
   *  用户上下文重发（不追加重复问题）。 */
  run: (sessionId: string, followupText?: string) => Promise<void>;
  /** 处置一个待确认的工具调用（批次五 P2）：
   *  approve=true → 调 MCP server，结果作为 tool 消息入历史并**续跑一轮**；
   *  approve=false → 追加一条「用户拒绝执行」的 tool 消息，同样续跑一轮。
   *  同一时刻只允许一个工具在执行（防重复点击二次执行）。 */
  resolveToolCall: (sessionId: string, callId: string, approve: boolean) => Promise<void>;
  /**
   * 处置一条待确认的**计划步骤**（2026-11-04 第二步 Manual 模式）：
   *  approve=true → 调 `ai_scope_run_step`（用该步骤登记时的 scope）→ 结果
   *  作为 tool 轮入历史并**续跑一轮**；approve=false → 追加一条「已拒绝」的
   *  tool 消息，同样续跑一轮。已执行/已拒绝的步骤不可重复执行。
   *
   *  **档位升级**（2026-11-04 修补 I-1）：plan 档登记的步骤在后端**执行不了**
   *  （后端按登记时的档位判定），故 approve=true 时若该步骤登记时不是 manual
   *  档 → **先让后端升档**（`ai_scope_upgrade_step`：命令原文只从登记簿里取，
   *  新的 actionId），再执行升级后那条；manual 档登记的步骤走直路。 */
  resolvePlanStep: (sessionId: string, stepId: string, approve: boolean) => Promise<void>;
  /** 切换会话级执行模式（2026-11-04 第一步）：plan / auto / manual。
   *  会话级——随对话保持；新对话复位到默认档（设置项）。 */
  setMode: (sessionId: string, mode: AiExecMode) => void;
}

function settlePartialReply(st: SessionAiState): ChatTurn[] {
  const redaction = st.settingsUsed?.redaction;
  const opts: RedactOptions = {
    hostname: redaction?.hostname ?? true,
    custom: redaction?.custom ?? [],
  };
  return st.messages.flatMap((turn, index) => {
    const lastAssistant = index === st.messages.length - 1 && turn.role === "assistant";
    if (!lastAssistant || turn.runId !== st.runId || turn.toolCalls?.length) return [turn];
    if (turn.content === "") return [];
    return [{
      ...turn,
      content: redact(turn.content, opts).text,
      scopeId: null,
      runId: st.runId,
      interrupted: true,
    }];
  });
}

/** 各会话在途请求的取消器（模块级——非响应式资源，与 sinks/定时器同一放置惯例）。 */
const controllers = new Map<string, AbortController>();
/** AbortController 不能撤销已发往主机的工具动作；保留门闩直到远端 await 真正返回。 */
const runningHostTools = new Map<string, { runId: string; callId: string }>();
/** 只保存归档屏障，不保存用户原文：下一次发送须等前一次按其本轮设置脱敏入库。 */
const pendingSubmissions = new Map<string, { conversationId: string; ready: Promise<void> }>();
const failedSubmissions = new Map<string, { conversationId: string; text: string }>();

/** 停止生成只结清未派发/在途的主机调用；MCP 与已登记步骤仍待用户处置。 */
function settleStoppedReply(st: SessionAiState): ChatTurn[] {
  const messages = settlePartialReply(st);
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
  const awaiting = new Set([
    ...(st.pendingToolCalls ?? []).map((tc) => tc.id),
    ...(st.plan ?? [])
      .filter((step) => step.status === "planned" || step.status === "executing")
      .flatMap((step) => step.toolCallIds ?? []),
  ]);
  const stopped: ChatTurn[] = [];
  for (const turn of messages) {
    if (turn.role !== "assistant" || turn.runId !== st.runId) continue;
    for (const tc of turn.toolCalls ?? []) {
      if (answered.has(tc.id) || awaiting.has(tc.id)) continue;
      stopped.push({
        role: "tool",
        toolCallId: tc.id,
        toolName: tc.name,
        content: i18n.t(
          tc.id === st.runningHostToolCallId
            ? "ai.tool.stoppedInFlight"
            : "ai.tool.stoppedBeforeDispatch",
        ),
      });
      answered.add(tc.id);
    }
  }
  return [...messages, ...stopped];
}

/** 各会话「正在流式」run 的 scope（supersede/abort 即撤销的写授权面）。 */
const inflightScopes = new Map<string, { runId: string; scopeId: string }>();
/** 各会话所有活 scope（close/lifecycle 失效全撤；完成 run 的 scope 保留到
 *  close/lifecycle/TTL——已完成回答的插入授权在面板存续期内有效）。 */
const sessionScopes = new Map<string, Set<string>>();

/** id 生成（crypto.randomUUID 优先，计数器兜底；Task 3 简报口径）。 */
export function newAiId(prefix: string): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Date.now() % 100000}`;
}

/** 撤销一个 scope（尽力而为：已撤销/过期/后端不可达一律吞掉）。 */
async function revokeScopeQuietly(scopeId: string): Promise<void> {
  try {
    await aiSessionApi.revoke(scopeId);
  } catch {
    // 撤销失败不反噬（后端 TTL 15 min 兜底）
  }
}

/** 登记 run 的 scope（inflight + 会话集合）。 */
function registerScope(sessionId: string, scopeId: string, runId: string): void {
  let set = sessionScopes.get(sessionId);
  if (!set) {
    set = new Set();
    sessionScopes.set(sessionId, set);
  }
  set.add(scopeId);
  inflightScopes.set(sessionId, { runId, scopeId });
}

/** 收权「正在流式」的 scope（supersede/abort 路径）。 */
async function revokeInflightScope(sessionId: string): Promise<void> {
  const entry = inflightScopes.get(sessionId);
  if (!entry) return;
  inflightScopes.delete(sessionId);
  sessionScopes.get(sessionId)?.delete(entry.scopeId);
  await revokeScopeQuietly(entry.scopeId);
}

/** 收权指定 run 的 scope（run 自身守卫失败路径；非该 run 的不碰）。 */
async function abandonRunScope(sessionId: string, runId: string): Promise<void> {
  const entry = inflightScopes.get(sessionId);
  if (!entry || entry.runId !== runId) return;
  inflightScopes.delete(sessionId);
  sessionScopes.get(sessionId)?.delete(entry.scopeId);
  await revokeScopeQuietly(entry.scopeId);
}

/** 收权会话全部 scope（close/lifecycle 失效/新对话）。 */
async function revokeAllScopes(sessionId: string): Promise<void> {
  inflightScopes.delete(sessionId);
  const set = sessionScopes.get(sessionId);
  if (!set) return;
  sessionScopes.delete(sessionId);
  await Promise.all([...set].map(revokeScopeQuietly));
}

/** run 收尾的 scope 结算：keep=true（正常完成/审批挂起）保留授权；
 *  keep=false（取消/出错/被取代）立即撤销。 */
function settleRunScope(sessionId: string, runId: string, keep: boolean): void {
  const entry = inflightScopes.get(sessionId);
  if (!entry || entry.runId !== runId) return;
  inflightScopes.delete(sessionId);
  if (!keep) {
    sessionScopes.get(sessionId)?.delete(entry.scopeId);
    void revokeScopeQuietly(entry.scopeId);
  }
}

/** 守卫失败后的「搁浅救援」（fix round 1 M-1）：仍属本 run（控制器/runId
 *  相符）且面板还挂在 running 态 → 归位 idle——目标半路死亡 / vault 锁定
 *  这类守卫失败不能把面板留成永久转圈。**被取代的 run 不写**（控制器/
 *  runId 失配即 return——新切片的状态归取代者管，R3 铁律）。 */
function rescueStrandedRun(sessionId: string, ac: AbortController, runId: string): void {
  if (controllers.get(sessionId) !== ac) return;
  const st = useAiStore.getState().sessions[sessionId];
  if (!st || st.request == null || st.runId !== runId || st.status !== "running") return;
  useAiStore.setState((s0) => {
    const cur = s0.sessions[sessionId];
    if (!cur || cur.request == null || cur.runId !== runId || cur.status !== "running") return s0;
    const activeTool = runningHostTools.get(sessionId);
    return {
      sessions: {
        ...s0.sessions,
        [sessionId]: {
          ...cur,
          status: "idle",
          runningHostToolCallId: activeTool?.callId ?? null,
          runningHostToolRunId: activeTool?.runId ?? null,
        },
      },
    };
  });
}

/** 从 SessionStore 捕获会话此刻的目标快照（无连接/纯文件会话 → null）。 */
function captureTargetOfSession(sessionId: string): AiScopeTarget | null {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId);
  if (!s || s.rustId == null) return null;
  try {
    return captureAiTarget(s);
  } catch {
    return null;
  }
}

/** 面板打开时路由到设置页的钩子（App 挂载时注入，避免 store 反向依赖组件）。 */
let openSettingsHook: (() => void) | null = null;
export function setAiSettingsOpener(fn: (() => void) | null): void {
  openSettingsHook = fn;
}
export function openAiSettings(): void {
  openSettingsHook?.();
}

/**
 * 组装诊断/解释的用户消息（脱敏后调用；格式稳定便于模型按段作答）。
 *
 * `hostContext` = 主机「备注」注入块（已脱敏；空串 = 该主机无备忘）。
 * 追加在最后一段——模型对末段（最靠近生成点）的指令依从度更高，
 * 备忘是「这台机器的额外事实」，排在命令与输出尾之后不抢主问题的注意力。
 */
export function buildUserMessage(
  req: AiRequest,
  redactedSubject: string,
  output: string,
  hostContext = "",
): string {
  const contextBlock = hostContext ? `\n\n${hostContext}` : "";
  if (req.kind === "diagnose") {
    return (
      [
        `${i18n.t("ai.msg.exitCode")}: ${req.exitCode ?? "?"}`,
        `${i18n.t("ai.msg.command")}:`,
        redactedSubject,
        `${i18n.t("ai.msg.outputTail")}:`,
        "```",
        output,
        "```",
      ].join("\n") + contextBlock
    );
  }
  if (req.kind === "ask") {
    // Ask Ottr（批次四 P0）：**用户的问题在前**，会话上下文（输出尾 + 主机
    // 备注）在后——模型看到的是「问题 + 现场」，而不是一段诊断报告。
    return (
      [
        redactedSubject,
        output.trim() === "" ? "" : `${i18n.t("ai.msg.outputTail")}:\n\`\`\`\n${output}\n\`\`\``,
      ]
        .filter((s) => s !== "")
        .join("\n\n") + contextBlock
    );
  }
  return `${i18n.t("ai.msg.explainTarget")}:\n${redactedSubject}${contextBlock}`;
}

/**
 * 对话历史封顶（2026-11-02 审计）：历史无上限时，每轮追问都把**全部**历史
 * 重发——token 线性增长、总量平方增长（BYOK 用户自掏腰包），且长会话会把
 * 最早的诊断上下文（最长 8KB 输出尾）一直拖着。
 *
 * 口径：先按**轮数**截（保留最近 N 轮，含首轮诊断上下文那一轮——它带的是
 * 本次诊断的证据），再按**总字符**截（从最老的一轮开始丢）。与 nl2cmd 的
 * NL_ROUNDS_CAP=10 同一思路。
 */
const HISTORY_TURN_CAP = 8;
const HISTORY_CHAR_CAP = 16 * 1024;

export function capHistory<T extends { content: string }>(
  turns: T[],
  charCap = HISTORY_CHAR_CAP,
): T[] {
  let out = turns.length > HISTORY_TURN_CAP ? turns.slice(turns.length - HISTORY_TURN_CAP) : turns;
  let total = out.reduce((n, t) => n + t.content.length, 0);
  while (out.length > 1 && total > charCap) {
    total -= out[0].content.length;
    out = out.slice(1);
  }
  return out;
}

/**
 * 历史 → provider 消息（**出网前再脱敏一次**，幂等）。
 *
 * 工具相关字段原样带走：assistant 轮的 toolCalls（id/name/arguments）与 tool
 * 轮的 toolCallId —— 它们是协议面结构，不是自由文本，脱敏会破坏配对。
 */
export function toProviderMessages(turns: ChatTurn[], redactOpts: RedactOptions): ChatMessage[] {
  return turns.map((m) => {
    const msg: ChatMessage = { role: m.role, content: redact(m.content, redactOpts).text };
    if (m.toolCalls?.length) msg.toolCalls = m.toolCalls;
    if (m.toolCallId) msg.toolCallId = m.toolCallId;
    if (m.toolName) msg.toolName = m.toolName;
    return msg;
  });
}

/**
 * 剔除「孤儿」tool 轮（其对应的 assistant 工具调用轮已被封顶丢弃）。
 *
 * provider 协议面要求 tool 消息紧跟在发起它的 assistant 轮之后——历史封顶
 * （capHistory）从最老处丢轮时可能把 assistant 轮丢掉、留下孤零零的 tool
 * 轮，端点会直接 400。这里把这种轮次摘掉。
 */
export function pruneOrphanToolTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  let openCallIds: string[] = [];
  for (const t of turns) {
    if (t.role === "assistant" && t.toolCalls?.length) {
      openCallIds = t.toolCalls.map((tc) => tc.id);
      out.push(t);
      continue;
    }
    if (t.role === "tool") {
      if (!t.toolCallId || !openCallIds.includes(t.toolCallId)) continue; // 孤儿
      out.push(t);
      continue;
    }
    openCallIds = [];
    out.push(t);
  }
  return out;
}

/** 工具调用增量合并（同一 id 的参数碎片续接；不同 id 追加）。 */
export function mergeToolCalls(prev: ToolCall[], next: ToolCall[]): ToolCall[] {
  const out = [...prev];
  for (const tc of next) {
    if (!tc) continue;
    const i = out.findIndex((x) => x.id === tc.id);
    if (i >= 0) {
      out[i] = {
        ...out[i],
        name: out[i].name || tc.name,
        arguments: (out[i].arguments ?? "") + (tc.arguments ?? ""),
      };
    } else {
      out.push({ id: tc.id ?? "", name: tc.name ?? "", arguments: tc.arguments ?? "" });
    }
  }
  return out;
}

/**
 * 系统提示词。
 *
 * * 有外部 MCP 工具 → 补一句「工具调用需要用户确认后才会执行」（既有语义不变）；
 * * 有内建主机工具 → 另补一句**主机工具的语义**（只读直接跑；执行类在当前
 *   模式下只登记计划、不真跑）——不说清楚，模型会以为所有工具都要等用户
 *   点确认（或以为 exec 真的跑了），两边都错。
 */
export function systemPrompt(req: AiRequest, hasTools: boolean, hasHostTools = false): string {
  const base = i18n.t(req.kind === "diagnose" ? "ai.prompt.diagnose" : "ai.prompt.explain");
  const parts = [base];
  if (hasTools) parts.push(i18n.t("ai.prompt.tools"));
  if (hasHostTools) parts.push(i18n.t("ai.prompt.hostTools"));
  return parts.join("\n\n");
}

/**
 * 工具调用 → 待确认项（用**本请求自己的绑定快照**还原 serverId 与**原始**
 * 工具名——Task 3：还原不允许读模块级「最近一次」注册表，两次 run 之间
 * server 被删/改名时旧注册表会把调用打去错误的对象）。
 *
 * 快照里还原不出来的（本 run 没见过这个名字）→ serverId 留空，执行面据此
 * 回一条「工具不可用」的说明给模型，而不是拿错 server 去调（意外工具名
 * 不派发，与计划「Reject unexpected model tools without dispatch」一致）。
 */
export function toPendingToolCall(
  tc: ToolCall,
  bindings?: ReadonlyMap<string, McpToolBinding>,
  runId?: string | null,
): PendingToolCall {
  const binding = bindings ? (bindings.get(tc.name) ?? null) : null;
  const args = tc.arguments ?? "";
  return {
    id: tc.id,
    serverId: binding?.serverId ?? "",
    serverName: binding?.serverName ?? "",
    tool: binding?.tool ?? tc.name,
    args: args.trim() === "" ? "{}" : args,
    runId: runId ?? null,
  };
}

/** 通知正文的命令摘要（首行、80 字符截断；已脱敏文本入通知）。 */
export function commandExcerpt(command: string): string {
  const first = command.split("\n")[0] ?? command;
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

/** 执行输出在**面板里**的显示上限（回灌给模型的完整文本不受影响）。 */
export const PLAN_OUTPUT_DISPLAY_LIMIT = 2000;

/** 执行输出的展示截断（面板就地展示用；发给模型的是完整文本）。 */
export function truncateForDisplay(text: string, limit = PLAN_OUTPUT_DISPLAY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${i18n.t("ai.tool.truncated")}`;
}

/* ---------------------------------------------------------------------------
 * 内建主机工具的执行面（2026-11-04 第一步：Plan 模式 / 第二步：Manual 模式）
 *
 * 语义（对齐契约 §4）：
 * * **只读工具**（读输出尾 / 读文件 / 列目录）→ 直接执行，结果作 tool 轮回灌
 *   给模型——读上下文是安全的，不需要用户逐次点头；
 * * **执行类工具**（ottr_exec_command）→ 按当前模式分派：
 *   plan **不执行**，只登记一条计划步骤，回灌「已记入计划，暂不执行」，让模型
 *   继续把计划列全；
 *   manual（第二步）同样**先只登记**（零执行），但**登记后挂起本轮**——等用户
 *   点「执行」才调 `ai_scope_run_step` 真跑（结果回灌模型 → 模型续跑），点
 *   「拒绝」则把「已拒绝」回灌 → 模型续跑；
 * * 绑定随请求快照走（本函数只吃当轮快照里的绑定，不读模块级注册表）。
 * ------------------------------------------------------------------------- */

/** 工具参数解析（宽松：解析失败 = 空对象——模型偶发发坏 JSON 不该中断整轮）。 */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

/** 工具参数取串（非串 = 空串）。 */
function argString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 读输出尾的字节数（模型可指定；越界钳制在 1KB..64KB——省 token 也防撑爆）。 */
function clampTailBytes(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : TAIL_BYTES;
  return Math.min(64 * 1024, Math.max(1024, n));
}

/** 一次内建主机工具的执行结果。 */
export interface HostToolOutcome {
  /** 回灌给模型的文本（已脱敏后入库）。 */
  content: string;
  /** plan 模式下登记的计划步骤（非空 = 记入计划清单）。 */
  planStep?: PlanStep;
  /**
   * **挂起本次 tool call**（第二步 Manual 模式）：true = 这次调用**先不答**，
   * 等用户点「执行 / 拒绝」后才回灌 tool 轮。
   *
   * 为什么不能当场答掉：provider 协议要求 assistant 的每个 tool_call 都有对应
   * 的 tool 消息；当场答掉的话，稍后那条「执行结果」的 tool 轮就成了孤儿
   * （pruneOrphanToolTurns 会把它摘掉）——模型永远看不到执行结果。
   */
  deferred?: boolean;
}

/**
 * 执行一次内建主机工具。
 *
 * 失败一律**不抛**：错误文本回灌给模型（模型据此换路子），本轮不中断。
 * exec 的失败尤其重要——后端拒绝意味着**零执行、零计划登记**：命令**不进**
 * 计划清单（清单是「待执行」的步骤，不是日志；审查 M-3/M-4），失败原因
 * 一并回灌（不静默）。
 *
 * 回灌文案按后端回包分三种（2026-11-04 修补 B1：`executed` 与 `planned`
 * **分别**读，不再只看 `planned`——第二步 manual 真执行时不会再向模型谎报
 * 「已记入计划，暂不执行」）：
 * * `executed = true` → 「已执行」（**进清单**，状态 = done / failed——自动档
 *   在用户主机上跑过的命令，用户必须看得见，见下面 exec 分支）；
 * * `planned = true && executed = false` → 「已记入计划，暂不执行」（进清单）；
 * * 两者皆假 / 调用被拒 → 「未执行（被拒绝）」（不进清单）。
 */
/**
 * 自动档已执行的结果 → 回灌给模型的文本。
 *
 * **要带真实输出与退出码**：模型据此判断「命令跑成了没有、下一步做什么」；
 * 只回一句「已执行」等于让模型瞎猜。
 */
function formatAutoExecResult(res: AiScopeRunResult): string {
  const parts: string[] = [];
  parts.push(res.timedOut ? i18n.t("ai.plan.timedOut") : `exit code: ${res.exitCode ?? "-"}`);
  if (res.stdout) parts.push(`stdout:\n${res.stdout}`);
  if (res.stderr) parts.push(`stderr:\n${res.stderr}`);
  if (res.truncated) parts.push(i18n.t("ai.tool.truncated"));
  return parts.join("\n");
}

export async function runHostTool(
  scope: AiScope,
  tool: HostToolName,
  args: Record<string, unknown>,
  ctx: { mode: AiExecMode; actionId: string },
): Promise<HostToolOutcome> {
  try {
    switch (tool) {
      case "ottr_read_output": {
        const res = await aiSessionApi.context(scope.scopeId, clampTailBytes(args.bytes));
        return { content: res.tail ?? "" };
      }
      case "ottr_read_file": {
        const path = argString(args.path);
        if (path === "") return { content: i18n.t("ai.hostTool.needPath") };
        // 本地终端会话**不开放主机文件读取面**（2026-11-04 修补 A1）：不打到
        // 后端，直接回灌本地化拒绝文案（后端同样一律拒——这里是给出人话的
        // 那道；本地会话仍可读终端输出尾，那本来就是用户自己屏幕上的东西）。
        if (scope.kind === "local") {
          return { content: i18n.t("ai.hostTool.localReadRejected") };
        }
        const file = await aiSessionApi.readFile(scope.scopeId, path);
        const body = file.content ?? "";
        return { content: file.truncated ? `${body}\n${i18n.t("ai.tool.truncated")}` : body };
      }
      case "ottr_list_dir": {
        const path = argString(args.path);
        if (path === "") return { content: i18n.t("ai.hostTool.needPath") };
        // 同上：本地会话不开放主机文件读取面。
        if (scope.kind === "local") {
          return { content: i18n.t("ai.hostTool.localReadRejected") };
        }
        const listing = await aiSessionApi.listDir(scope.scopeId, path);
        const entries = (listing.entries ?? []).map(
          (e) => `${e.isDir ? "d" : "-"} ${e.name}`,
        );
        return { content: entries.join("\n") };
      }
      case "ottr_exec_command": {
        const command = argString(args.command);
        if (command === "") return { content: i18n.t("ai.hostTool.needCommand") };
        // 计划步骤在本地成型（后端登记成功后才进清单）。
        const local: PlanStep = {
          id: newPlanStepId(),
          command,
          purpose: argString(args.purpose) || undefined,
          danger: classify(command).level,
          status: "planned",
          // 绑定目标（去重键的一半）：同一条命令在不同目标下各自成步。
          target: planTargetKey(scope),
          // **目标绑定**（第二步 Manual 模式）：执行时用的是**登记时**这个
          // scope（不是当前焦点终端——切到别的终端后原卡仍打原目标）；
          // actionId 原样回传（后端按它防串改 + 一次性）。
          scopeId: scope.scopeId,
          actionId: ctx.actionId,
          // **登记时的档位**（2026-11-04 修补）：后端按它判定执行权——plan 档
          // 登记的步骤执行前必须先由后端升档（见 rearmPlanStep）。
          registeredMode: ctx.mode,
        };
        try {
          const outcome = await aiSessionApi.exec(scope.scopeId, ctx.actionId, command, ctx.mode);
          // 后端登记簿里那条的 stepId（执行面按它取命令原文；缺省 = 本地 id）。
          const registeredStepId = outcome.stepId || local.id;
          // **已执行**（自动档当场执行时才会出现）：结果**如实回灌**给模型
          // （输出与退出码），并**进清单**——但状态是 done / failed，不是
          // 「待执行」（它已经跑过了；清单这一行承载的是「AI 在我主机上跑过
          // 什么、结果如何」，见下面）。
          if (outcome.executed) {
            const res = outcome.result;
            // 没有结果载荷（后端说执行了但没给结果——不该发生）→ 回落本地化
            // 文案，**不把后端英文原文直接甩给模型**。
            if (!res) return { content: i18n.t("ai.plan.executed") };
            // ★ 自动跑过的命令**要进清单**（状态=已完成）：用户必须看得到
            // AI 在自己主机上自动跑了什么、结果如何——这是自动档的信任面
            // （设计 §5.1 的「执行日志」由同一张步骤卡承载，不另起一块）。
            return {
              content: formatAutoExecResult(res),
              planStep: {
                ...local,
                id: registeredStepId,
                backendStepId: registeredStepId,
                // 非零退出码 / 超时 = **失败**（与手动档同口径：清单里的
                // 「已完成」只给真跑成功的命令）。
                status: res.exitCode === 0 && !res.timedOut ? "done" : "failed",
                result: {
                  exitCode: res.exitCode ?? null,
                  stdout: truncateForDisplay(res.stdout ?? ""),
                  stderr: truncateForDisplay(res.stderr ?? ""),
                  truncated: res.truncated === true,
                  timedOut: res.timedOut === true,
                },
              },
            };
          }
          // **已记入计划、暂不执行**：进计划清单（这才是「待执行」的步骤）。
          if (outcome.planned) {
            const step: PlanStep = {
              ...local,
              id: registeredStepId,
              backendStepId: registeredStepId,
            };
            // **自动档降级**：后端把命令降级为逐条确认，并已按
            // **手动档**登记（命令原文在登记簿里、档位=manual）→ 本地步骤也
            // 标成 manual，用户点「执行」直接跑，**不需要**再升档。
            const downgraded = outcome.downgradeReason != null;
            if (ctx.mode === "manual" || downgraded) {
              // Manual 档（含自动档降级）：**登记即挂起**——命令一个字节都
              // 没跑，等用户点「执行」才真跑（后端 run_step）。这次 tool
              // call 先不答（见 HostToolOutcome.deferred 的说明），处置时再回灌。
              return {
                content: "",
                planStep: downgraded ? { ...step, registeredMode: "manual" } : step,
                deferred: true,
              };
            }
            return { content: i18n.t("ai.plan.planned"), planStep: step };
          }
          // **未执行且被拒**：不进计划清单（后端拒了就没登记这一步）。
          return { content: outcome.message || i18n.t("ai.plan.rejected") };
        } catch (e) {
          // 后端拒绝 → **零执行**、**零计划登记**：命令不进清单（否则用户会
          // 看到一条「从未登记」的待执行步骤——审查 M-3/M-4），失败原因回灌
          // 给模型（不静默丢用户的意图）。
          return {
            content: i18n.t("ai.plan.rejectedWithError", {
              error: e instanceof Error ? e.message : String(e),
            }),
          };
        }
      }
    }
  } catch (e) {
    return {
      content: i18n.t("ai.tool.failed", { error: e instanceof Error ? e.message : String(e) }),
    };
  }
}

/** 自动诊断触发门槛（2026-10-19 用户反馈）：Ctrl+C（SIGINT → 130）是用户
 * 主动取消，不是需要诊断的失败——不弹面板（历史入库不受影响，onCommandFinished
 * 照记；手动「解释」也不受限）。仅 130：SIGTERM/SIGKILL 等仍照常诊断。 */
export function shouldAutoDiagnose(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 130;
}

/* ---------------------------------------------------------------------------
 * 档位升级（plan 档登记 → manual 档登记）（2026-11-04 修补 I-1）
 *
 * **断裂**：后端 `ai_scope_run_step` 按**步骤登记时落账的档位**判定执行权——
 * plan 档登记的步骤一律拒「AI run rejected: plan mode does not execute
 * (register the step in manual mode)」。于是「用户在 plan 档提问 → 看到计划
 * 清单 → 切到手动档 → 点执行」必然失败——手动档的意义就是「我来确认执行」，
 * 却不给执行，荒谬。
 *
 * **修法（后端出命令原文）**：用户点「执行」的那一刻（**不是切档时**——切档
 * 即写后端登记簿是多余副作用）把这条步骤**升到 manual 档**，再执行升级后
 * 那条：
 * * 调后端 `ai_scope_upgrade_step(scopeId, stepId, actionId)`——**命令原文
 *   只从后端登记簿里取**（前端**不传命令**）；
 * * actionId 必须**全新且未被消费过**（后端按它做一次性消费，复用即拒
 *   「already consumed」）→ `${runId}:rearm:${原stepId}:${递增序号}`；
 * * 后端返回**新的 stepId**——清单里那一条必须改指新步骤（否则执行的仍是
 *   那条 plan 档登记的旧步骤，后端照样拒）。
 * * manual 档登记的步骤走**直路**（直接 runStep，不多一次调用）。
 *
 * **为什么不再由前端拿命令副本去重新登记**（旧路径）：那等于把「执行对象」
 * 的命令文本来源变回前端（前端在两步之间改写 `step.command`，被执行的就是
 * 改后的文本——后端只校验形态，不校验与原步骤一致）→ 削弱了「执行只认登记簿
 * 里的命令原文」这条契约不变量。
 * ------------------------------------------------------------------------- */

/** 档位升级的序号（模块级计数器：连点两次也不会撞同一个 actionId）。 */
let rearmSeq = 0;

/**
 * 档位升级用的 actionId：`${runId}:rearm:${原stepId}:${递增序号}`。
 *
 * * 前缀带 runId —— 一次 run 内的一次升级归属清晰，后端日志可追；
 * * 序号单调递增（模块级计数器）——**连点两次也不会复用同一个 id**
 *   （后端按 actionId 一次性消费，复用即拒「already consumed」）。
 */
export function newRearmActionId(runId: string | null, stepId: string): string {
  rearmSeq += 1;
  return `${runId ?? "norun"}:rearm:${stepId}:${rearmSeq}`;
}

/**
 * 档位升级：把一条 **plan 档登记**的步骤升到 **manual 档**（后端从登记簿里
 * 取命令原文重新登记一条）。
 *
 * **前端不传命令**——后端拿的是登记簿里那一份（前端手里那份 `step.command`
 * 只是展示用的副本）。
 *
 * 失败一律**抛**（调用方按失败面处理：步骤 failed + 原因可见，不吞错）。
 */
async function rearmPlanStep(
  scopeId: string,
  step: PlanStep,
  runId: string | null,
): Promise<{ scopeId: string; stepId: string; actionId: string }> {
  const actionId = newRearmActionId(runId, step.id);
  // 登记簿里那条的 stepId（合并过的步骤：行标识与登记事实可能分家——执行面
  // 只认登记簿里那条）。
  const registeredStepId = step.backendStepId ?? step.id;
  const outcome = await aiSessionApi.upgradeStep(scopeId, registeredStepId, actionId);
  // 后端契约：升级只升级、不执行 → 回一个**新的** stepId（+ 新的 actionId）。
  // 任何一条不成立 = 没升级成功（不能拿旧步骤去执行）。
  if (!outcome?.stepId) {
    throw new Error(outcome?.message || "AI upgrade rejected (no step upgraded)");
  }
  return { scopeId, stepId: outcome.stepId, actionId: outcome.actionId || actionId };
}

export const useAiStore = create<AiStore>((set, get) => {
  /** 切片更新（不存在则落入空切片底上合并；调用方保证 id 非空）。 */
  const patch = (sessionId: string, partial: Partial<SessionAiState>): void => {
    set((st) => {
      const cur = st.sessions[sessionId] ?? EMPTY_SLICE;
      return {
        sessions: { ...st.sessions, [sessionId]: { ...cur, ...partial } },
      };
    });
  };
  const slice = (sessionId: string): SessionAiState =>
    get().sessions[sessionId] ?? EMPTY_SLICE;

  /**
   * 改一条计划步骤（状态 / 执行结果回填）——执行面与面板共用一个写入口。
   * 找不到该步骤时**不写**（步骤已被清掉：换对话/丢会话）。
   */
  const patchPlanStep = (
    sessionId: string,
    stepId: string,
    stepPatch: Partial<PlanStep>,
  ): void => {
    const list = slice(sessionId).plan ?? [];
    if (!list.some((s) => s.id === stepId)) return;
    patch(sessionId, {
      plan: list.map((s) => (s.id === stepId ? { ...s, ...stepPatch } : s)),
    });
  };

  /** 取代某会话的在途 run（abort + 在途 scope 收权）。 */
  const supersede = (sessionId: string): void => {
    controllers.get(sessionId)?.abort();
    controllers.delete(sessionId);
    void revokeInflightScope(sessionId);
  };

  /**
   * 为本轮 run 开 scope（目标活校验先行；open 后复核身份，被取代则撤销）。
   * 成功即落 slice.scope（面板头部身份面）并登记（supersede/close 可撤）。
   */
  const openRunScope = async (
    sessionId: string,
    runId: string,
    guard: () => boolean,
  ): Promise<AiScope | null> => {
    const st = get().sessions[sessionId];
    const target = st?.target;
    if (!target || !isAiTargetLive(target, sessionFocusState())) return null;
    let scope: AiScope | null = null;
    try {
      const opened = await aiSessionApi.open(target, st.conversationId, runId);
      scope = opened && typeof opened.scopeId === "string" && opened.scopeId !== "" ? opened : null;
    } catch {
      scope = null; // 后端拒（目标刚死/上限满）：按无 scope 降级（上下文走 legacy/为空）
    }
    if (!guard()) {
      if (scope) await revokeScopeQuietly(scope.scopeId); // 迟到的 open 结果立即收权
      return null;
    }
    if (scope) {
      registerScope(sessionId, scope.scopeId, runId);
      patch(sessionId, { scope });
    }
    return scope;
  };

  /**
   * 一轮流式对话（**普通轮与工具续跑轮共用**）。
   *
   * * 装配好的消息 → provider.chat → 收集文本与工具调用；
   * * **有工具调用** → 助手轮落库（含 toolCalls）+ 挂「待确认」态：本轮**暂停**
   *   （status=awaiting_tool_approval），等用户点执行/拒绝——模型不得自动触发
   *   工具（与既有「AI 只给建议、用户执行」的安全模型一致）；
   * * **无工具调用** → 正常收尾（空回答判失败 / done / 落通知）。
   *
   * 取消器与 runId 由调用方（run/continueChain）在**首个 await 之前**创建并
   * 经 ctx 传入——本函数不再自建（Task 3：运行身份先于一切 await）。
   */
  const streamTurn = async (
    sessionId: string,
    ctx: {
      ac: AbortController;
      runId: string;
      /** 本 run 的 scope（null = 无绑定/开失败——插入面禁用）。 */
      scope: AiScope | null;
      /** 本轮取一次的执行档位（与工具描述同一份——审查 M-5：运行中切档
       *  不得让「描述说的档」与「发给后端的档」分叉）。 */
      mode: AiExecMode;
      /** 本轮发出的消息（已装配）。 */
      messages: ChatMessage[];
      /** 历史基准（落库时拼在本轮之前）。 */
      baseTurns: ChatTurn[];
      system: string;
      maxTokens: number;
      apiKey: string;
      meta: ProviderMeta;
      /** 可用工具（空 = 本轮不带 tools）。 */
      tools: ChatTool[];
      /** 本请求自己的工具绑定快照（还原模型工具调用用）。 */
      bindings: ReadonlyMap<string, McpToolBinding>;
      /** 本请求自己的**内建主机工具**绑定快照（随请求走，不读模块级注册表）。 */
      hostBindings: ReadonlyMap<string, HostToolBinding>;
      /** 已消耗的工具轮次（上限判定）。 */
      toolRounds: number;
      /** **执行护栏**（第三步自动档）：单轮命令步数上限与单轮总时长上限。
       *  超限即**不再执行**本轮后续命令，并把「已到上限」回灌给模型。 */
      guardrails: { maxSteps: number; maxDurationMs: number };
      redactOpts: RedactOptions;
      /** 完成落通知用（null = 本轮不发）。 */
      notify: { req: AiRequest; body: string } | null;
    },
  ): Promise<void> => {
    const { ac, runId } = ctx;
    controllers.set(sessionId, ac);
    // 运行身份守卫：控制器/切片/runId/旗标/目标存活/锁定 任一失配即弃权
    const alive = (): boolean => {
      if (controllers.get(sessionId) !== ac) return false;
      const st = get().sessions[sessionId];
      if (!st || st.request == null) return false;
      if (st.runId !== runId) return false;
      if (useVaultLockStore.getState().phase === "locked") return false;
      if (st.target && !isAiTargetLive(st.target, sessionFocusState())) return false;
      return true;
    };
    const startedAt = performance.now();
    const assistantTurn: ChatTurn = {
      role: "assistant",
      content: "",
      scopeId: ctx.scope?.scopeId ?? null,
      runId,
    };
    // scope 是否随正常收尾保留（完成/审批挂起保留授权；取消/出错撤销）
    let keepScope = false;
    patch(sessionId, {
      status: "running",
      answer: "",
      usage: null,
      modelUsed: null,
      elapsedMs: null,
      messages: [...ctx.baseTurns, assistantTurn],
      runningHostToolCallId: null,
      runningHostToolRunId: null,
      streamStartedRunId: null,
    });
    try {
      const provider = createProvider(ctx.meta, ctx.apiKey);
      let toolCalls: ToolCall[] = [];
      const stream = provider.chat({
        system: ctx.system,
        messages: ctx.messages,
        maxTokens: ctx.maxTokens,
        signal: ac.signal,
        ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
      });
      if (!alive()) return;
      patch(sessionId, { streamStartedRunId: runId });
      for await (const delta of stream) {
        if (!alive()) {
          rescueStrandedRun(sessionId, ac, runId); // 被取代不写；目标死亡/锁定归位 idle
          return;
        }
        if (ac.signal.aborted) break;
        assistantTurn.content += delta.text;
        if (delta.toolCalls?.length) toolCalls = mergeToolCalls(toolCalls, delta.toolCalls);
        const currentAnswer = redact(assistantTurn.content, ctx.redactOpts).text;
        patch(sessionId, {
          answer: assistantTurn.content,
          messages: [
            ...ctx.baseTurns,
            { ...assistantTurn, content: currentAnswer },
          ],
          status: "running",
          // 用量/模型：端点给了才更新（拿不到就是 null → UI 只显示耗时）。
          usage: delta.usage ?? slice(sessionId).usage,
          modelUsed: delta.model ?? slice(sessionId).modelUsed,
        });
      }
      if (!alive()) {
        rescueStrandedRun(sessionId, ac, runId);
        return;
      }
      // 注意：**这里不删 controller**——删了会让下面收尾段抛出的异常被 catch
      // 块的「已被本会话新一轮取代」早退吞掉（面板卡在 running 永不定稿）。
      // 删除交给 finally（只在还是同一个 controller 时删）。
      const done = !ac.signal.aborted;
      const elapsed = Math.round(performance.now() - startedAt);

      // --- 工具调用分支：内建主机工具**就地处置**；外部 MCP 工具挂待确认 ---
      if (toolCalls.length > 0) {
        const turn: ChatTurn = {
          role: "assistant",
          content: redact(assistantTurn.content, ctx.redactOpts).text,
          toolCalls,
          scopeId: ctx.scope?.scopeId ?? null,
          runId,
        };
        const base = [...ctx.baseTurns, turn];
        // 轮次上限（MAX_TOOL_ROUNDS）：超限就不再执行工具——把「已到上限」作为
        // tool 结果回给模型，续跑**不带工具**的一轮，让它据现有信息作答
        // （防模型无限调工具烧 token；BYOK 用户自掏腰包）。
        if (ctx.toolRounds >= MAX_TOOL_ROUNDS) {
          keepScope = true;
          const limitText = i18n.t("ai.tool.limitReached", { count: MAX_TOOL_ROUNDS });
          const toolTurns: ChatTurn[] = toolCalls.map((tc) => ({
            role: "tool",
            content: limitText,
            toolCallId: tc.id,
            toolName: tc.name,
          }));
          const next = [...base, ...toolTurns];
          patch(sessionId, { messages: next, pendingToolCalls: [] });
          await streamTurn(sessionId, {
            ...ctx,
            messages: toProviderMessages(next, ctx.redactOpts),
            baseTurns: next,
            tools: [],
          });
          return;
        }
        keepScope = true;
        // 分流：**内建主机工具**（只读三类 + 执行类）不需要外部 MCP 那种逐次
        // 审批——只读直接跑；执行类按模式：plan 只登记计划（一个字节都没执行），
        // manual 登记后**挂起本轮**等用户点确认（第二步）；
        // **外部 MCP 工具**仍逐次确认（既有安全模型不变）。
        const hostCalls = toolCalls.filter((tc) => ctx.hostBindings.has(tc.name));
        const mcpCalls = toolCalls.filter((tc) => !ctx.hostBindings.has(tc.name));
        // 第一个主机工具 await 前就保存整批协议与待确认项；停止不能丢掉
        // 同一响应里的 MCP 调用，也不能让已登记的 manual 步骤失去来源轮。
        patch(sessionId, {
          messages: base,
          pendingToolCalls: mcpCalls.map((tc) => toPendingToolCall(tc, ctx.bindings, runId)),
          toolRounds: ctx.toolRounds + 1,
        });
        if (hostCalls.length > 0) {
          const toolTurns: ChatTurn[] = [];
          const appendToolTurn = (turn: ChatTurn): void => {
            toolTurns.push(turn);
            patch(sessionId, { messages: [...base, ...toolTurns] });
          };
          /** Manual 档挂起的执行类调用数（>0 = 本轮就此暂停，等用户处置）。 */
          let deferredCalls = 0;
          /** 本轮**已发起**的执行类调用数（自动档护栏计数用）。 */
          let execCalls = 0;
          for (const tc of hostCalls) {
            if (!alive()) {
              rescueStrandedRun(sessionId, ac, runId);
              return;
            }
            const binding = ctx.hostBindings.get(tc.name) as HostToolBinding;
            const scope = ctx.scope;
            if (!scope) {
              appendToolTurn({
                role: "tool",
                content: i18n.t("ai.hostTool.noScope"),
                toolCallId: tc.id,
                toolName: binding.tool,
              });
              continue;
            }
            const mode = ctx.mode;
            // **执行护栏**（第三步自动档）：自动档下本轮的执行类调用**可能
            // 直接跑在主机上** → 步数与总时长到顶即**不再发起**（后端都不
            // 调，零副作用），并把「已到上限」如实回灌给模型。
            //
            // 语义要分清（两层护栏，各管一件事）：
            // * 这里的计数是**单轮提案预算**（每次 streamTurn 重置）——拦的是
            //   「模型一口气提议一大串命令」；
            // * **执行预算的真源在后端**（`check_auto_guardrails`，按作用域
            //   计数、跨续跑累计）——真正跑在主机上的条数由它收口，前端这份
            //   只是提前止损。所以「每轮 10 条 × 多轮」不会突破后端上限。
            // 手动档不在此计数：那里的命令要等用户点「执行」才跑，每次都
            // 有一次明确的用户动作，不需要轮内预算。
            if (binding.tool === "ottr_exec_command" && mode === "auto") {
              execCalls += 1;
              const roundElapsedMs = Math.round(performance.now() - startedAt);
              const overSteps = execCalls > ctx.guardrails.maxSteps;
              const overTime = roundElapsedMs >= ctx.guardrails.maxDurationMs;
              if (overSteps || overTime) {
                appendToolTurn({
                  role: "tool",
                  content: overTime
                    ? i18n.t("ai.auto.durationLimitReached", {
                        seconds: Math.round(ctx.guardrails.maxDurationMs / 1000),
                      })
                    : i18n.t("ai.auto.stepLimitReached", { count: ctx.guardrails.maxSteps }),
                  toolCallId: tc.id,
                  toolName: binding.tool,
                });
                continue;
              }
            }
            runningHostTools.set(sessionId, { runId, callId: tc.id });
            patch(sessionId, {
              runningHostToolCallId: tc.id,
              runningHostToolRunId: runId,
            });
            let out: HostToolOutcome;
            try {
              out = await runHostTool(
                scope,
                binding.tool,
                parseToolArgs(tc.arguments ?? ""),
                { mode, actionId: `${runId}:exec:${tc.id}` },
              );
            } finally {
              const active = runningHostTools.get(sessionId);
              if (active?.runId === runId && active.callId === tc.id) {
                runningHostTools.delete(sessionId);
              }
              const cur = get().sessions[sessionId];
              if (
                cur?.runningHostToolRunId === runId &&
                cur.runningHostToolCallId === tc.id
              ) {
                patch(sessionId, {
                  runningHostToolCallId: null,
                  runningHostToolRunId: null,
                });
              }
            }
            if (!alive()) {
              rescueStrandedRun(sessionId, ac, runId);
              return;
            }
            if (out.planStep) {
              const step: PlanStep = {
                ...out.planStep,
                // Manual 档：这次 tool call **先不答**——处置时按 id 回灌 tool 轮
                // （登记时把 id 记在步骤上）。plan 档当场就答过，不记 id
                // （否则会被当成待处置，把追问输入永久禁掉）。
                ...(out.deferred ? { toolCallIds: [tc.id], runId } : {}),
              };
              patch(sessionId, { plan: upsertPlanStep(slice(sessionId).plan, step) });
            }
            if (out.deferred) {
              deferredCalls += 1;
              continue; // 不答这条 tool call（等用户点执行/拒绝再回灌）
            }
            appendToolTurn({
              role: "tool",
              content: redact(out.content, ctx.redactOpts).text,
              toolCallId: tc.id,
              toolName: binding.tool,
            });
          }
          const next = [...base, ...toolTurns];
          if (mcpCalls.length > 0 || deferredCalls > 0) {
            // 混批（内建 + 外部）/ manual 挂起：外部那批仍挂待确认、manual 的
            // 执行类等用户处置——本轮就此暂停（模型不得自行触发工具）。
            patch(sessionId, {
              messages: next,
              pendingToolCalls: mcpCalls.map((tc) => toPendingToolCall(tc, ctx.bindings, runId)),
              toolRounds: ctx.toolRounds + 1,
              status: "awaiting_tool_approval",
              elapsedMs: elapsed,
            });
            return;
          }
          patch(sessionId, {
            messages: next,
            pendingToolCalls: [],
            toolRounds: ctx.toolRounds + 1,
          });
          // 续跑一轮：把工具结果回灌给模型，让它据实继续（plan 模式下即
          // 「继续把计划列全」）。
          await continueChain(sessionId, next);
          return;
        }
        patch(sessionId, {
          messages: base,
          pendingToolCalls: mcpCalls.map((tc) => toPendingToolCall(tc, ctx.bindings, runId)),
          toolRounds: ctx.toolRounds + 1,
          status: "awaiting_tool_approval",
          elapsedMs: elapsed,
        });
        return;
      }

      // --- 普通收尾 ---
      // assistant 轮落库前脱敏：模型回显的敏感值不留明文在历史里
      // （存储面与出网面都守住「内容一律脱敏后存」的契约）。
      // 插入绑定随轮落库（scopeId/runId）——生成于哪个终端就只能插回哪里。
      if (assistantTurn.content !== "") {
        patch(sessionId, {
          messages: [
            ...ctx.baseTurns,
            {
              role: "assistant",
              content: redact(assistantTurn.content, ctx.redactOpts).text,
              scopeId: ctx.scope?.scopeId ?? null,
              runId,
            },
          ],
        });
      }
      // **空回答 = 失败**（2026-11-02 审计）：端点返回 200 但正文不是 SSE
      // （反向代理的登录页/HTML 错误页）时，一个 delta 都不会来——此前会
      // 置成 done 且答案为空，用户看到「成功但一片空白」，没有任何错误提示。
      // 这里按失败收尾，并让用户看到可重试的错误面。
      if (done && assistantTurn.content.trim() === "") {
        patch(sessionId, {
          status: "error",
          errorKind: "request",
          error: i18n.t("ai.emptyAnswer"),
          elapsedMs: elapsed,
        });
        return;
      }
      if (done) keepScope = true;
      patch(sessionId, {
        status: done ? "done" : "aborted",
        elapsedMs: elapsed,
      });
      if (done && ctx.notify) {
        // --- 完成落通知（T12 管线预留位；取消不发；失败只记 console 不反噬）---
        try {
          await notify({
            kind: "ai",
            severity: "success",
            host_id: ctx.notify.req.hostId,
            title_key:
              ctx.notify.req.kind === "diagnose" ? "notify.title.aiDone" : "notify.title.aiExplain",
            body: ctx.notify.body,
            payload: { session_id: ctx.notify.req.sessionId, provider: ctx.meta.name },
          });
        } catch (e) {
          console.warn("[ai] notify failed:", e);
        }
      }
    } catch (e) {
      if (controllers.get(sessionId) !== ac) return;
      controllers.delete(sessionId);
      if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        patch(sessionId, { status: "aborted", messages: settlePartialReply(slice(sessionId)) });
        return;
      }
      // 断流/报错：把**半截** assistant 轮从历史里摘掉——它不完整，下一轮
      // 追问会把它当上下文发出去（模型拿到一段没写完的回答）。
      patch(sessionId, {
        status: "error",
        errorKind: "request",
        error: e instanceof Error ? e.message : String(e),
        messages: ctx.baseTurns,
      });
    } finally {
      if (controllers.get(sessionId) === ac) controllers.delete(sessionId);
      settleRunScope(sessionId, runId, keepScope);
    }
  };

  /**
   * 工具链续跑：把**完整历史**（含助手工具调用轮 + tool 结果轮）再发给模型，
   * 让模型据工具返回给出最终回答。
   *
   * 运行身份（runId+controller）在首个 await 前重建；设置与 key 重新取
   * （用户确认可能隔了很久，配置可能已变）；工具清单**现取**（请求内快照）；
   * scope 为本轮新开（插入授权随轮走）。
   */
  const continueChain = async (sessionId: string, messages: ChatTurn[]): Promise<void> => {
    const req = slice(sessionId).request;
    if (!req) return;
    if (slice(sessionId).conversationReadonly) return;
    const runId = newAiId("run");
    const ac = new AbortController();
    controllers.set(sessionId, ac);
    patch(sessionId, { runId, pendingToolCalls: [], runningToolCallId: null });
    const guard = (): boolean => {
      if (controllers.get(sessionId) !== ac) return false;
      const st = get().sessions[sessionId];
      if (!st || st.request == null || st.runId !== runId) return false;
      if (useVaultLockStore.getState().phase === "locked") return false;
      if (st.target && !isAiTargetLive(st.target, sessionFocusState())) return false;
      return true;
    };
    let settings: AiSettings;
    try {
      settings = await loadAiSettings();
    } catch (e) {
      if (!guard()) return;
      patch(sessionId, {
        status: "error",
        errorKind: "noProvider",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!guard()) return;
    const meta = activeProvider(settings.providers);
    if (!meta) {
      patch(sessionId, { status: "error", errorKind: "noProvider", error: null });
      return;
    }
    let apiKey: string;
    try {
      apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
    } catch (e) {
      if (!guard()) return;
      patch(sessionId, {
        status: "error",
        errorKind: "noKey",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!guard()) return;
    const redactOpts: RedactOptions = {
      hostname: settings.redaction.hostname,
      custom: settings.redaction.custom,
    };
    const scope = await openRunScope(sessionId, runId, guard);
    if (!guard()) return;
    const snapshot = await loadMcpToolSnapshot();
    if (!guard()) {
      await abandonRunScope(sessionId, runId);
      return;
    }
    // 内建主机工具（仅当会话有活目标时才有；有 scope 即证明目标此刻活着）。
    // **执行档位在本轮取一次**（审查 M-5）：工具描述与真正发给后端的 mode
    // 必须是同一个——用户在 run 进行中切档时，描述说 plan、实际发 manual
    // 会让模型按错的语义规划。
    const mode = slice(sessionId).mode ?? DEFAULT_AI_EXEC_MODE;
    const host = hostToolSnapshot({
      enabled: scope != null,
      mode,
      readProbe: readAiReadProbeEnabled(),
    });
    // 工具链的历史**只按轮数封顶**：按字符封顶会把工具返回（模型续跑的唯一
    // 依据）从历史里裁掉——模型拿不到结果就答不了。
    const capped = pruneOrphanToolTurns(capHistory(messages, Number.POSITIVE_INFINITY));
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const rawSubject =
      req.kind === "diagnose"
        ? req.command
        : req.kind === "explain"
          ? req.text
          : (lastUser?.content ?? "");
    await streamTurn(sessionId, {
      ac,
      runId,
      scope,
      mode,
      // 执行护栏（第三步）：从设置读（缺省 10 步 / 300 秒），工具轮里按它
      // 收口——超限不再发起执行类调用。
      guardrails: {
        maxSteps: settings.autoMaxSteps,
        maxDurationMs: settings.autoMaxDurationSecs * 1000,
      },
      messages: toProviderMessages(capped, redactOpts),
      baseTurns: capped,
      system: systemPrompt(
        req,
        snapshot.tools.length > 0,
        host.tools.length > 0,
      ),
      maxTokens: settings.maxTokens,
      apiKey,
      meta,
      tools: [...snapshot.tools, ...host.tools],
      bindings: snapshot.bindings,
      hostBindings: host.bindings,
      toolRounds: slice(sessionId).toolRounds ?? 0,
      redactOpts,
      notify: { req, body: commandExcerpt(redact(rawSubject, redactOpts).text) },
    });
  };

  return {
    sessions: {},

    /**
   * Ask Ottr 入口（批次四 P0）：为聚焦会话开一个「提问」态的 AI 面板。
   *
   * 同一活目标重开 = **续对话**：历史/草稿/对话 id 保留（close 只是摘掉
   * 「open」旗标，面板重开回到原对话）；目标已换代（重连）或旧对话只读 =
   * 自动开新对话——旧消息绝不换绑到新连接。
   */
  openAsk: (req) => {
    supersede(req.sessionId);
    const cur = slice(req.sessionId);
    const st = useSessionStore.getState();
    const resumable =
      cur.conversationId !== "" &&
      cur.target != null &&
      !cur.conversationReadonly &&
      isAiTargetLive(cur.target, {
        activeId: st.activeId,
        activePane: st.activePane,
        sessions: st.sessions,
      });
    if (resumable) {
      patch(req.sessionId, {
        request: { ...req, target: cur.target },
        // 在途运行已被 supersede——除非链停在审批挂起（无控制器、可续处置），
        // 否则回到 idle 态让用户直接发问。
        status: cur.status === "awaiting_tool_approval" ? cur.status : "idle",
        errorKind: null,
        error: null,
        seen: false,
        runId: null,
        scope: null,
      });
      return;
    }
    patch(req.sessionId, {
      request: { ...req, target: req.target ?? null },
      status: "idle",
      answer: "",
      errorKind: null,
      error: null,
      redactions: [],
      usage: null,
      modelUsed: null,
      elapsedMs: null,
      messages: [],
      pendingToolCalls: [],
      toolRounds: 0,
      runningToolCallId: null,
      conversationId: newAiId("conv"),
      target: req.target ?? null,
      scope: null,
      runId: null,
      draft: "",
      conversationReadonly: false,
      // 新对话 = 新执行上下文：模式复位到默认档，计划清单清空。
      mode: readDefaultAiExecMode(),
      plan: [],
    });
  },

  onCommandFailed: (req) => {
      void (async () => {
        try {
          const s = await loadAiSettings();
          if (!s.enabled) return;
        } catch {
          // settings 读不到：按开处理（能力面不因配置故障变哑）
        }
        supersede(req.sessionId);
        patch(req.sessionId, {
          request: req,
          status: "idle",
          answer: "",
          errorKind: null,
          error: null,
          redactions: [],
          usage: null,
          modelUsed: null,
          elapsedMs: null,
          // **新问题 = 新对话**：不清历史的话，run() 会把上一轮对话当上下文
          // 带上（同一会话连着两次诊断，模型看到的是两个不相关的问题 + 前一轮
          // 的答案 → 答非所问，且 token 白花一倍）。目标按此刻快照捕获。
          messages: [],
          pendingToolCalls: [],
          toolRounds: 0,
          runningToolCallId: null,
          conversationId: newAiId("conv"),
          target: captureTargetOfSession(req.sessionId),
          scope: null,
          runId: null,
          draft: "",
          conversationReadonly: false,
          // 新对话 = 新执行上下文：模式复位到默认档，计划清单清空。
          mode: readDefaultAiExecMode(),
          plan: [],
        });
        await get().run(req.sessionId);
      })();
    },

    openExplain: (req) => {
      supersede(req.sessionId);
      patch(req.sessionId, {
        request: req,
        status: "idle",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
        usage: null,
        modelUsed: null,
        elapsedMs: null,
        // 新问题 = 新对话（同 onCommandFailed：历史不重置就会串上下文）。
        messages: [],
        pendingToolCalls: [],
        toolRounds: 0,
        runningToolCallId: null,
        conversationId: newAiId("conv"),
        target: captureTargetOfSession(req.sessionId),
        scope: null,
        runId: null,
        draft: "",
        conversationReadonly: false,
        // 新对话 = 新执行上下文：模式复位到默认档，计划清单清空。
        mode: readDefaultAiExecMode(),
        plan: [],
      });
      void get().run(req.sessionId);
    },

    close: (sessionId) => {
      supersede(sessionId);
      void revokeAllScopes(sessionId);
      set((st) => {
        const cur = st.sessions[sessionId];
        if (!cur) return st;
        return {
          sessions: {
            ...st.sessions,
            [sessionId]: {
              ...cur,
              // close = 隐藏：摘「open」旗标（orb 可见性读 request == null），
              // 历史/草稿/对话 id/pending 保留——同活目标重开即续对话。
              request: null,
              status: "idle",
              answer: "",
              errorKind: null,
              error: null,
              usage: null,
              modelUsed: null,
              elapsedMs: null,
              runId: null,
              scope: null,
            },
          },
        };
      });
    },

    abort: (sessionId) => {
      const st = slice(sessionId);
      // 已登记的待确认步骤仍需要原 scope。只停止生成，不能把用户尚未处置
      // 的授权登记簿一并撤掉（close/newConversation 仍会全撤）。
      if (awaitingPlanSteps(st).length > 0) settleRunScope(sessionId, st.runId ?? "", true);
      supersede(sessionId);
      if (st.status === "running") {
        patch(sessionId, {
          status: "aborted",
          messages: settleStoppedReply(st),
          runningHostToolCallId: runningHostTools.get(sessionId)?.callId ?? null,
          runningHostToolRunId: runningHostTools.get(sessionId)?.runId ?? null,
        });
      }
    },

    interrupt: async (sessionId, text, expectedRunId) => {
      const st = slice(sessionId);
      const trimmed = text.trim();
      if (
        trimmed === "" || !st.request || st.status !== "running" || !st.runId ||
        st.streamStartedRunId !== st.runId || expectedRunId !== st.runId || st.conversationReadonly ||
        useVaultLockStore.getState().phase === "locked" ||
        (st.target && !isAiTargetLive(st.target, sessionFocusState())) ||
        (st.pendingToolCalls?.length ?? 0) > 0 ||
        st.runningToolCallId != null || st.runningHostToolCallId != null ||
        awaitingPlanSteps(st).length > 0 ||
        (st.plan ?? []).some((step) => step.status === "executing")
      ) return;
      // 必须在第一个 await 前停止：旧流此后即使继续吐字、抛错或返回工具，
      // 也不能覆盖插话。部分回答本来就在 messages 中，只定稿、不追加第二份。
      supersede(sessionId);
      patch(sessionId, { messages: settlePartialReply(st) });
      await get().run(sessionId, trimmed);
    },

    markSeen: (sessionId) => {
      if (slice(sessionId).request != null) patch(sessionId, { seen: true });
    },

    dropSession: (sessionId) => {
      get().close(sessionId);
      set((st) => {
        if (!(sessionId in st.sessions)) return st;
        const next = { ...st.sessions };
        delete next[sessionId];
        return { sessions: next };
      });
    },

    newConversation: (sessionId) => {
      supersede(sessionId);
      void revokeAllScopes(sessionId);
      if (slice(sessionId).request == null) return; // 无打开面板：无对话可换
      patch(sessionId, {
        status: "idle",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
        usage: null,
        modelUsed: null,
        elapsedMs: null,
        messages: [],
        pendingToolCalls: [],
        toolRounds: 0,
        runningToolCallId: null,
        conversationId: newAiId("conv"),
        runId: null,
        scope: null,
        draft: "",
        conversationReadonly: false,
        // 新对话 = 新执行上下文：模式复位到默认档，计划清单清空。
        mode: readDefaultAiExecMode(),
        plan: [],
      });
    },

    patchDraft: (sessionId, text) => {
      if (slice(sessionId).request == null) return; // 面板关闭拒收（无幽灵切片）
      patch(sessionId, { draft: text });
    },

    handleSessionLifecycle: ({ type, session }) => {
      if (type === "closed") {
        get().dropSession(session.id);
        return;
      }
      // 断开/重连：绑定目标失活 → 写授权（scope）全撤。
      void revokeAllScopes(session.id);
      if (type === "reconnected") {
        const cur = get().sessions[session.id];
        if (cur && cur.target && !isAiTargetLive(cur.target, sessionFocusState())) {
          patch(session.id, { conversationReadonly: true }); // 历史可见，续问须新对话
        }
      }
    },

    run: async (sessionId, followupText) => {
      const cur0 = slice(sessionId);
      const req = cur0.request;
      if (!req) return;
      // 运行中的普通请求只能由 interrupt 先撤旧 controller 后替换；已发往
      // 主机的工具调用不可取消，必须等它真正返回后才能开启下一轮。
      if (
        (cur0.status === "running" && controllers.has(sessionId)) ||
        cur0.runningHostToolCallId != null ||
        runningHostTools.has(sessionId)
      ) return;
      // 有待确认的工具调用 → 不开新链（会把用户还没处置的工具调用丢掉）。
      if ((cur0.pendingToolCalls ?? []).length > 0) return;
      // 有待处置的**执行步骤**（Manual 档）→ 同样不开新链：那次 tool call 还
      // 没被回答，插入新的一轮会让 provider 协议缺 tool 消息（400）。
      if (awaitingPlanSteps(cur0).length > 0) return;
      // 只读对话（重连换代）：续问须走新对话（openAsk 对新代数目标自动开）。
      if (cur0.conversationReadonly) return;
      // 追问轮（followupText 非空）：**不重取输出尾、不重注入主机备注**——
      // 首轮已经把这些发给模型了，追问只带对话历史（省 token、不重复出网）。
      // 「追问轮」的判据 = **带追问文本 且 已有对话历史**。
      // 只看文本会踩两个坑：① Ask Ottr 的首轮（问题在输入条里、尚无历史）
      // 会被误判成追问轮 → 拿不到上下文（输出尾/主机备注）；② 诊断的「重试」
      // （无追问文本）会把首轮上下文**再追加一遍**到历史里。
      const submittedText = typeof followupText === "string" && followupText.trim() !== ""
        ? followupText
        : null;
      // Ask 失败重试：优先取最近一条已归档的脱敏问题（provider/key 准备失败、
      // 流中断等都会归档）；设置加载失败等未归档情形回落草稿/失败缓存——
      // 绝不让已提交的问题随闭包消失，也不能用空串覆盖它。
      const retryAskTurn = submittedText == null && cur0.status === "error" && req.kind === "ask"
        ? [...cur0.messages].reverse().find((turn) => turn.role === "user" && turn.retryContent != null) ?? null
        : null;
      const failedSubmission = failedSubmissions.get(sessionId);
      const retryDraftText = submittedText == null && retryAskTurn == null &&
          cur0.status === "error" && req.kind === "ask"
        ? (cur0.draft.trim() !== ""
          ? cur0.draft
          : failedSubmission?.conversationId === cur0.conversationId ? failedSubmission.text : null)
        : null;
      const retryAskText = retryAskTurn?.retryContent ?? retryDraftText;
      const isRetryingAsk = submittedText == null && retryAskText != null;
      const archiveText = submittedText ?? retryDraftText;
      const conversationId = cur0.conversationId;
      // 追问判定：带新文本且已有历史＝追问；Ask 失败重试若此前还没有任何
      // 模型轮（assistant/tool），按首轮重组上下文（补回输出尾/主机备注）。
      const isFollowup = submittedText != null
        ? cur0.messages.length > 0
        : isRetryingAsk && cur0.messages.some((m) => m !== retryAskTurn && m.role !== "user");

      // 归档屏障：同一对话上一次提交尚未按其本轮设置脱敏入库前，拒收新提交
      //（防双 Enter 清掉新草稿、Stop 后迟到归档与新请求竞态错乱）。
      const previousSubmission = pendingSubmissions.get(sessionId);
      if (previousSubmission?.conversationId === conversationId) return;

      // --- runId + AbortController 先于一切 await（Task 3 铁律）---
      const runId = newAiId("run");
      const ac = new AbortController();
      controllers.set(sessionId, ac);
      patch(sessionId, {
        runId,
        status: "running",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
        usage: null,
        modelUsed: null,
        elapsedMs: null,
        // 新链 = 工具轮次清零（上一链的待确认项已在上一条守卫里挡掉）。
        pendingToolCalls: [],
        toolRounds: 0,
        runningToolCallId: null,
        runningHostToolCallId: null,
        runningHostToolRunId: null,
        ...(submittedText != null || retryDraftText != null ? { draft: "" } : {}),
      });
      // 被 本 run 取代的上一条在途链：其 scope 立即收权
      void revokeInflightScope(sessionId);

      // 身份守卫：一切 await 返回后复核（控制器/runId/旗标/目标活/未锁）。
      const guard = (): boolean => {
        if (controllers.get(sessionId) !== ac) return false;
        const st = get().sessions[sessionId];
        if (!st || st.request == null || st.runId !== runId) return false;
        if (useVaultLockStore.getState().phase === "locked") return false;
        if (st.target && !isAiTargetLive(st.target, sessionFocusState())) return false;
        return true;
      };

      // 提交按**本轮**设置脱敏后归档一次：Stop/close 只保留安全用户轮、绝不
      // 复活 request/status；新对话（conversationId 已变）不继承旧提交；
      // 归档失败（设置读不到等）原文留在模块私有缓存供重试，草稿仍空时恢复。
      const settingsPromise = loadAiSettings();
      const submission: { turn: ChatTurn | null } = { turn: null };
      let submissionReady: Promise<void> = Promise.resolve();
      if (archiveText != null) {
        const ready = settingsPromise.then((loaded) => {
          const cur = get().sessions[sessionId];
          if (!cur || cur.conversationId !== conversationId) return;
          const redactedSubmission = redact(archiveText, {
            hostname: loaded.redaction.hostname,
            custom: loaded.redaction.custom,
          }).text;
          const turn: ChatTurn = {
            role: "user",
            content: redactedSubmission,
            ...(req.kind === "ask" ? { retryContent: redactedSubmission } : {}),
          };
          submission.turn = turn;
          patch(sessionId, { messages: [...cur.messages, turn] });
          if (failedSubmission?.conversationId === conversationId) {
            failedSubmissions.delete(sessionId);
          }
        });
        const pending = { conversationId, ready };
        pendingSubmissions.set(sessionId, pending);
        submissionReady = ready;
        void ready.then(
          () => {
            if (pendingSubmissions.get(sessionId) === pending) pendingSubmissions.delete(sessionId);
          },
          () => {
            if (pendingSubmissions.get(sessionId) === pending) pendingSubmissions.delete(sessionId);
            failedSubmissions.set(sessionId, { conversationId, text: archiveText });
            const cur = get().sessions[sessionId];
            if (cur?.conversationId === conversationId && cur.draft === "") {
              patch(sessionId, { draft: archiveText });
            }
          },
        );
      }

      // --- 1. 设置（坏键独立回落）---
      let settings: AiSettings;
      try {
        settings = await settingsPromise;
        await submissionReady;
      } catch (e) {
        if (!guard()) return;
        patch(sessionId, {
          status: "error",
          errorKind: "noProvider",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      if (!guard()) {
        rescueStrandedRun(sessionId, ac, runId);
        return;
      }
      patch(sessionId, { settingsUsed: settings });

      // 首个未禁用的 provider（启用/禁用 2026-10-16）：禁用的默认项自动旁路，
      // 无可用（未配置或全部禁用）→ noProvider 错误面（带去设置引导）。
      const meta = activeProvider(settings.providers);
      if (!meta) {
        patch(sessionId, { status: "error", errorKind: "noProvider", error: null });
        return;
      }

      // --- 2. 明文 key 单点出库（vault secrets）---
      // key 未保存 → **空串**（fix 1/5 I-1）：openai-compatible 显式允许免 key
      // （Ollama 本地端点；OpenAICompatibleProvider 对空 key 不发 Authorization 头）。
      // Anthropic 需要 key 的校验在设置页保存侧（errKeyRequired）；这里空 key 直连
      // 会拿到端点 401 → request 错误面，不在此二次设卡。
      let apiKey: string;
      try {
        apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
      } catch (e) {
        if (!guard()) return;
        patch(sessionId, {
          status: "error",
          errorKind: "noKey",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      if (!guard()) {
        rescueStrandedRun(sessionId, ac, runId);
        return;
      }

      // --- 2.5 scope（每 run 一开；TTL 15 min，跨 run 缓存无益）---
      const scope = await openRunScope(sessionId, runId, guard);
      if (!guard()) {
        rescueStrandedRun(sessionId, ac, runId);
        return;
      }

      // --- 3. 组装上下文：脱敏（命令/选区 + 输出尾 8KB + 主机备注）---
      const redactOpts = {
        hostname: settings.redaction.hostname,
        custom: settings.redaction.custom,
      };
      // 追问轮：只把当前问题脱敏后并入历史（首轮上下文不重取）。
      // Ask 首轮失败重试没有 followupText，问题从已归档的脱敏 user turn 取回。
      const followupRaw = isRetryingAsk
        ? retryAskText ?? ""
        : (followupText as string);
      const followupRedacted = isFollowup
        ? redact(followupRaw, redactOpts)
        : null;
      const subject = isFollowup
        ? { text: followupRedacted?.text ?? "", findings: followupRedacted?.findings ?? [] }
        : redact(
            req.kind === "diagnose"
              ? req.command
              : req.kind === "ask"
                ? (retryAskText ?? followupText ?? "")
                : req.text,
            redactOpts,
          );
      let outputTail = "";
      let outputRedactions: RedactFinding[] = [];
      let hostContext = "";
      let hostCtxFindings: RedactFinding[] = [];
      if (!isFollowup) {
        // scope 通道（绑定目标且活着）：上下文经 ai_scope_context——同作用域的
        // 输出尾 + 归属主机备注一并返回，绝不按 hostId 重找运行时。
        if (scope && (req.kind === "diagnose" || req.kind === "ask")) {
          try {
            const ctxv = await aiSessionApi.context(scope.scopeId, TAIL_BYTES);
            if (!guard()) {
              await abandonRunScope(sessionId, runId);
              return;
            }
            const red = redact(ctxv.tail ?? "", redactOpts);
            outputTail = red.text;
            outputRedactions = red.findings;
            const hostCtx = buildHostContextBlock(ctxv.notes ?? null, redactOpts);
            hostCtxFindings = hostCtx.findings;
            hostContext = hostCtx.text ? `${i18n.t("ai.msg.hostContext")}:\n${hostCtx.text}` : "";
          } catch {
            // 上下文取数失败（会话刚死/锁定）：空输出照发（命令本身通常已足够）
          }
        } else {
          // legacy 通道（无绑定目标）：session_tail + fetchHostNotes（原路径）
          if ((req.kind === "diagnose" || req.kind === "ask") && req.rustId) {
            try {
              const tail = await vaultApi.sessionTail(req.rustId, TAIL_BYTES);
              const red = redact(tail, redactOpts);
              outputTail = red.text;
              outputRedactions = red.findings;
            } catch {
              // 会话已关/迟到：空输出照发诊断（命令本身通常已足够定位）
            }
          }
          // 主机备注注入（2026-11-02 批次一 A 项）：持久化在 vault 的上下文
          // （系统版本、服务管理方式、日志路径…），脱敏后随**首轮**发出。
          // 取数失败一律回落「无备忘段」——增强项不是前置条件。
          const notes = await fetchHostNotes(req.hostId);
          const hostCtx = buildHostContextBlock(notes, redactOpts);
          hostCtxFindings = hostCtx.findings;
          hostContext = hostCtx.text ? `${i18n.t("ai.msg.hostContext")}:\n${hostCtx.text}` : "";
        }
      }
      patch(sessionId, {
        redactions: [...subject.findings, ...outputRedactions, ...hostCtxFindings],
      });
      if (!guard()) {
        rescueStrandedRun(sessionId, ac, runId);
        await abandonRunScope(sessionId, runId);
        return;
      }

      // 空内容不诊断（2026-10-21 用户裁定，AI 层的第二道防线）：命令与输出
      // 尾都为空 = 无从诊断（模型只能回复「内容为空」，纯烧 token）——摘除
      // 本会话面板切片，请求不发。watch 层已有首道门卫（首个 D + 空命令文本），
      // 这里兜住其余路径（迟到的空 tail、未来新入口）。手动「解释」不受限
      // （选区非空才可达菜单）。
      if (
        !isFollowup &&
        req.kind === "diagnose" &&
        subject.text.trim() === "" &&
        outputTail.trim() === ""
      ) {
        await revokeAllScopes(sessionId);
        controllers.delete(sessionId);
        useAiStore.setState((s0) => {
          const next = { ...s0.sessions };
          delete next[sessionId];
          return { sessions: next };
        });
        return;
      }

      // --- 4. 流式（BYOK 直连；取消器按会话隔离）---
      // 对话历史：首轮 = 装配后的诊断上下文；追问轮 = 只带历史 + 本次追问。
      //
      // **历史出网前再脱敏一次**（幂等）：用户轮入库时已 redact，但 assistant
      // 轮是模型原文——模型可能把上下文里的敏感值**回显**出来（审计实测这条
      // 路径会绕过脱敏引擎再次出网）。redact 幂等，重复应用安全。
      const history = pruneOrphanToolTurns(
        capHistory(
          slice(sessionId).messages
            .filter((m) => m !== submission.turn && !(isRetryingAsk && m === retryAskTurn))
            .map((m) => ({
              ...m,
              content: redact(m.content, redactOpts).text,
            })),
        ),
      );
      const userContent = isFollowup
        ? subject.text
        : buildUserMessage(req, subject.text, outputTail, hostContext);
      // 重试 = **替换**末轮用户上下文（不追加重复问题）：首轮失败后历史以
      // 用户轮收尾，重发应重新装配那一轮（输出尾/备注可能已更新），而非
      // 再追加一份相同问题。
      const baseTurns =
        !isFollowup && history.length > 0 && history[history.length - 1].role === "user"
          ? history.slice(0, -1)
          : history;
      const messages: ChatMessage[] = [
        ...toProviderMessages(baseTurns, { enabled: false }),
        { role: "user", content: userContent },
      ];
      // 存储面也封顶：否则 store 里的 messages 无限增长（每轮追问又把全部
      // 历史重发）——封顶在「组装请求」与「落库」两处都做。
      const submittedTurn: ChatTurn = {
        role: "user",
        content: userContent,
        ...(req.kind === "ask" ? { retryContent: subject.text } : {}),
      };
      const turnsSoFar: ChatTurn[] = pruneOrphanToolTurns(
        capHistory([...baseTurns, submittedTurn]),
      );
      // 工具清单（批次五 P2）：**每次 run 现取**（server 的工具目录会变，不缓存）；
      // 取不到就当没有工具——增强项不是前置条件（AI 照常聊天）。
      // Task 3：绑定表随请求走（还原模型工具调用用请求自己的快照）。
      const snapshot = await loadMcpToolSnapshot();
      if (!guard()) {
        rescueStrandedRun(sessionId, ac, runId);
        await abandonRunScope(sessionId, runId);
        return;
      }
      // 内建主机工具（仅当会话有活目标时才有；有 scope 即证明目标此刻活着）。
      // 执行档位本轮取一次（与工具描述同一份——审查 M-5）。
      const mode = slice(sessionId).mode ?? DEFAULT_AI_EXEC_MODE;
      const host = hostToolSnapshot({
        enabled: scope != null,
        mode,
        readProbe: readAiReadProbeEnabled(),
      });
      await streamTurn(sessionId, {
        ac,
        runId,
        scope,
        mode,
        // 执行护栏（第三步）：设置读到的缺省值同样在这里生效。
        guardrails: {
          maxSteps: settings.autoMaxSteps,
          maxDurationMs: settings.autoMaxDurationSecs * 1000,
        },
        messages,
        baseTurns: turnsSoFar,
        system: systemPrompt(
          req,
          snapshot.tools.length > 0,
          host.tools.length > 0,
        ),
        maxTokens: settings.maxTokens,
        apiKey,
        meta,
        tools: [...snapshot.tools, ...host.tools],
        bindings: snapshot.bindings,
        hostBindings: host.bindings,
        toolRounds: 0,
        redactOpts,
        notify: { req, body: commandExcerpt(subject.text) },
      });
    },

    /**
     * 处置一个待确认的工具调用（批次五 P2）。
     *
     * * **执行**（approve=true）→ 调 MCP server（`mcp_server_call`），结果作为
     *   tool 消息入历史 → **续跑一轮**（把完整历史再发给模型）；
     * * **拒绝**（approve=false）→ 追加一条「用户拒绝执行」的 tool 消息，同样
     *   续跑一轮（模型据此换一种说法作答）。
     *
     * 同一时刻只允许一个工具在执行（挂起标记先于一切 await——双击第二击在
     * 同步检查被挡下）；执行前/后都复验运行身份（被取代的链不得执行/写回）。
     */
    resolveToolCall: async (sessionId, callId, approve) => {
      const st = slice(sessionId);
      if (st.runningToolCallId) return; // 已有工具在执行（防重复点击，同步挡下）
      const pending = (st.pendingToolCalls ?? []).find((p) => p.id === callId);
      if (!pending) return;
      // 运行身份复验：待确认项必须仍属于当前 run（被取代的链不得执行）。
      if (pending.runId != null && st.runId != null && pending.runId !== st.runId) return;
      // 挂起标记先于一切 await（R4：双击第二击在此同步挡下）。
      patch(sessionId, { runningToolCallId: callId });
      const capturedRunId = st.runId ?? null;
      // 丢弃路径收尾（fix round 1 I-1）：必须清挂起标记——close=hide 保留
      // 切片，不清会让审批按钮永久置灰（安全面变砖）。**pendingToolCalls
      // 刻意不清**：调用仍待处置，竞态平息（回到活目标/解锁）后可再批。
      const discard = (): void => {
        if (get().sessions[sessionId]) patch(sessionId, { runningToolCallId: null });
      };
      // 脱敏配置（工具返回也要脱敏后存——与「内容一律脱敏后存」纪律一致）。
      let redactOpts: RedactOptions = { hostname: true, custom: [] };
      try {
        const settings = await loadAiSettings();
        redactOpts = {
          hostname: settings.redaction.hostname,
          custom: settings.redaction.custom,
        };
      } catch {
        // 读不到就用默认规则（脱敏引擎的默认规则恒开）
      }
      // 执行前复验（批准点击与执行之间可能已被取代/关闭/锁定）。
      const before = slice(sessionId);
      if (before.request == null || before.runId !== capturedRunId) {
        discard();
        return;
      }
      if (useVaultLockStore.getState().phase === "locked") {
        discard();
        return;
      }
      let content: string;
      if (approve) {
        try {
          if (pending.serverId === "") {
            // 工具已不在本请求的快照里（server 被删/改名）→ 如实告诉模型，别猜。
            throw new Error(i18n.t("ai.tool.unknownTool"));
          }
          const result = await vaultApi.mcpClients.call(
            pending.serverId,
            pending.tool,
            pending.args,
          );
          content = result.text ?? "";
          if (result.isError) {
            content =
              content !== ""
                ? `${content}\n${i18n.t("ai.tool.failedTag")}`
                : i18n.t("ai.tool.failedTag");
          }
        } catch (e) {
          content = i18n.t("ai.tool.failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        content = i18n.t("ai.tool.rejected");
      }
      // 写回前复验：面板已关（不留幽灵写入）或已被新一轮取代 → 丢弃
      // （清挂起标记，pending 保留待再批）。
      const cur = slice(sessionId);
      if (!cur.request || cur.runId !== capturedRunId) {
        discard();
        return;
      }
      const toolTurn: ChatTurn = {
        role: "tool",
        content: redact(content, redactOpts).text,
        toolCallId: pending.id,
        toolName: pending.tool,
        serverName: pending.serverName,
      };
      const messages = [...cur.messages, toolTurn];
      const remaining = (cur.pendingToolCalls ?? []).filter((p) => p.id !== callId);
      patch(sessionId, {
        messages,
        pendingToolCalls: remaining,
        runningToolCallId: null,
      });
      if (remaining.length > 0) return; // 还有待确认项 → 等用户处置完再续跑
      await continueChain(sessionId, messages);
    },

    /**
     * 处置一条**待确认的计划步骤**（2026-11-04 第二步：Manual 模式）。
     *
     * * **执行**（approve=true）→ 调 `ai_scope_run_step(scopeId, stepId,
     *   actionId)`：目标 = **该步骤登记时的 scope**（不是当前焦点终端——
     *   切到别的终端后原卡仍打原目标），命令原文取登记簿里那条（前端不传
     *   命令，防前端改写）；结果（退出码 + 输出）作为 tool 轮回灌给模型 →
     *   **续跑一轮**；
     * * **拒绝**（approve=false）→ 把「已拒绝」作为 tool 轮回灌 → 同样续跑。
     *
     * 双重保险：前端按钮态（已执行/已拒绝的步骤不再给入口）+ 后端 actionId
     * 一次性消费（同一 actionId 二次调用被拒）。执行中的步骤同步置
     * `executing`（**先于一切 await**）——双击第二击在同步检查处被挡下。
     *
     * **档位升级**（2026-11-04 修补 I-1）：后端按**登记时落账的档位**判定执行权
     * （plan 档登记的步骤一律拒「plan mode does not execute」）→ approve=true
     * 时若该步骤登记时不是 manual 档，**先调后端 `ai_scope_upgrade_step` 升档**
     * （命令原文只从后端登记簿里取——前端不传命令），再执行升级后那条；升级
     * 后的清单条目改指新 stepId。
     */
    resolvePlanStep: async (sessionId, stepId, approve) => {
      const st = slice(sessionId);
      if (st.request == null) return; // 面板已关：无对话可处置
      // **规划档不提供执行入口**（后端也会拒）——前端不暴露。
      // 自动档**开放**执行入口：降级下来的步骤登记为**手动档**（等用户确认），
      // 不能因为会话档位是「自动」就把这条路堵死（否则降级 = 死路）。
      const sessionMode = st.mode ?? DEFAULT_AI_EXEC_MODE;
      if (sessionMode !== "manual" && sessionMode !== "auto") return;
      const step = (st.plan ?? []).find((s) => s.id === stepId);
      if (!step) return;
      // 自动档：**只**执行自动档降级下来的那类步骤（登记为手动档）。规划档
      // 登记的步骤在自动档**不**给执行入口——自动档的放行判断只走后端的
      // 白名单判定（走「升档」会绕开那道判定）。
      if (sessionMode === "auto" && (step.registeredMode ?? "plan") !== "manual") return;
      // 只处置「待执行」的步骤：执行中 / 已执行 / 已拒绝一律不再动
      // （重复点击的第一道闸）。
      if (step.status !== "planned") return;
      // 运行身份复验：步骤必须仍属于当前 run（被取代的链不得执行）。
      if (step.runId != null && st.runId != null && step.runId !== st.runId) return;
      // 目标绑定缺失（老数据 / 手工构造的步骤）→ 无从执行（没有 scope/action）。
      if (approve && (step.scopeId == null || step.actionId == null)) return;
      const capturedRunId = st.runId ?? null;
      const capturedConversationId = st.conversationId;
      const isCurrent = (): boolean => {
        const cur = get().sessions[sessionId];
        return cur != null && cur.request != null &&
          cur.conversationId === capturedConversationId && cur.runId === capturedRunId &&
          useVaultLockStore.getState().phase !== "locked";
      };
      // 挂起标记先于一切 await（双击第二击在此同步挡下）。
      patchPlanStep(sessionId, stepId, { status: "executing" });
      // **当前步骤 id**：档位升级成功后换成新登记的那条（清单里那一条改指新
      // 步骤）——后续回填按新 id 写（否则补丁打不回这条）。
      let liveStepId = stepId;
      // 丢弃路径收尾：把步骤放回「待执行」（竞态平息后可再批）。
      const discard = (): void => {
        if (slice(sessionId).conversationId === capturedConversationId) {
          patchPlanStep(sessionId, liveStepId, { status: "planned", result: undefined });
        }
      };
      // 脱敏配置（执行结果也要脱敏后存——与「内容一律脱敏后存」纪律一致）。
      let redactOpts: RedactOptions = { hostname: true, custom: [] };
      try {
        const settings = await loadAiSettings();
        redactOpts = {
          hostname: settings.redaction.hostname,
          custom: settings.redaction.custom,
        };
      } catch {
        // 读不到就用默认规则（脱敏引擎的默认规则恒开）
      }
      if (!isCurrent()) {
        discard();
        return;
      }
      let content: string;
      if (approve) {
        // --- 档位升级（plan 档登记 → manual 档）---
        // 后端按**登记时落账的档位**判定执行权：plan 档登记的步骤调 run_step
        // 必被拒（"plan mode does not execute"）。手动档的意义就是「我来确认
        // 执行」——用户在手动档点「执行」的那一刻，先让**后端**把这条步骤升到
        // manual 档（`ai_scope_upgrade_step`：命令原文只从登记簿里取，前端不传
        // 命令；新 actionId：已消费的 id 后端会拒「already consumed」），再执行
        // 升级后那条；manual 档登记的步骤走直路（不多一次调用）。
        let scopeId = step.scopeId as string;
        // 执行面认的是**登记簿里那条**（合并过的步骤：行标识与登记事实可能
        // 分家——行标识保持稳定，登记事实跟着当前那次登记走）。
        let execStepId = step.backendStepId ?? step.id;
        let execActionId = step.actionId as string;
        /** 升档失败的原因（非空 = 升级没做成，命令**没跑**）。 */
        let rearmError: string | null = null;
        if (needsModeUpgrade(step)) {
          try {
            const rearmed = await rearmPlanStep(scopeId, step, capturedRunId);
            if (!isCurrent()) {
              discard();
              return;
            }
            scopeId = rearmed.scopeId;
            execStepId = rearmed.stepId;
            execActionId = rearmed.actionId;
            liveStepId = rearmed.stepId;
            // 清单里那一条改指新步骤（重复点不再用旧 id）。
            patchPlanStep(sessionId, stepId, {
              id: rearmed.stepId,
              backendStepId: rearmed.stepId,
              actionId: rearmed.actionId,
              registeredMode: "manual",
            });
          } catch (e) {
            if (!isCurrent()) {
              discard();
              return;
            }
            rearmError = e instanceof Error ? e.message : String(e);
          }
        }
        if (rearmError !== null) {
          if (!isCurrent()) {
            discard();
            return;
          }
          // 升档失败 → 步骤 failed + 原因可见（沿用既有失败呈现，不吞错）。
          patchPlanStep(sessionId, liveStepId, {
            status: "failed",
            result: {
              exitCode: null,
              stdout: "",
              stderr: "",
              truncated: false,
              error: rearmError,
            },
          });
          content = i18n.t("ai.plan.rearmFailed", { error: rearmError });
        } else {
          try {
            const res = await aiSessionApi.runStep(scopeId, execStepId, execActionId);
            if (!isCurrent()) {
              discard();
              return;
            }
            const exitCode = res.exitCode ?? null;
            // 退出码非 0 = 步骤失败；**无退出码**（被信号杀掉 / 超时）同样算
            // 失败（null !== 0）。
            const failed = exitCode !== 0;
            const result: PlanStepResult = {
              exitCode,
              stdout: truncateForDisplay(res.stdout ?? ""),
              stderr: truncateForDisplay(res.stderr ?? ""),
              truncated: res.truncated === true,
              timedOut: res.timedOut === true,
            };
            patchPlanStep(sessionId, liveStepId, { status: failed ? "failed" : "done", result });
            // ★ 回灌给模型的内容要带**后端摘要**（`res.message`）：它区分
            // 「超时被中止」「非零退出码」「无退出码」三件事——只给退出码的话，
            // 超时那条看起来像「跑完了但没退出码」，模型会据此误判。
            content = i18n.t("ai.plan.runResult", {
              summary: res.message ?? "",
              exitCode: exitCode ?? "-",
              stdout: res.stdout ?? "",
              stderr: res.stderr ?? "",
            });
          } catch (e) {
            if (!isCurrent()) {
              discard();
              return;
            }
            const err = e instanceof Error ? e.message : String(e);
            const result: PlanStepResult = {
              exitCode: null,
              stdout: "",
              stderr: "",
              truncated: false,
              error: err,
            };
            patchPlanStep(sessionId, liveStepId, { status: "failed", result });
            content = i18n.t("ai.plan.runFailed", { error: err });
          }
        }
      } else {
        patchPlanStep(sessionId, stepId, { status: "rejected" });
        content = i18n.t("ai.plan.rejectedByUser");
      }
      // 写回前复验：面板已关（不留幽灵写入）或已被新一轮取代 → 丢弃。
      const cur = slice(sessionId);
      if (!cur.request || (cur.runId != null && capturedRunId != null && cur.runId !== capturedRunId)) {
        discard();
        return;
      }
      const redacted = redact(content, redactOpts).text;
      // tool 轮：按登记时记下的 tool call id 回灌（**每个都要答**——provider
      // 协议：assistant 的每个 tool_call 必须有对应 tool 消息，缺一个就 400）。
      const callIds = step.toolCallIds ?? [];
      const messages: ChatTurn[] = callIds.length
        ? [
            ...cur.messages,
            ...callIds.map((id) => ({
              role: "tool" as const,
              content: redacted,
              toolCallId: id,
              toolName: "ottr_exec_command",
            })),
          ]
        : [
            ...cur.messages,
            // plan 档登记的步骤（那次 tool call 当场就答过，没有待答 id）：
            // 结果以「用户轮」告知模型（tool 轮会是孤儿，被 prune 掉）。
            {
              role: "user" as const,
              content: redact(
                i18n.t("ai.plan.stepResult", { command: step.command, result: redacted }),
                redactOpts,
              ).text,
            },
          ];
      patch(sessionId, { messages });
      if (awaitingPlanSteps(slice(sessionId)).length > 0) {
        return; // 还有待处置的执行步骤 → 等用户处置完再续跑
      }
      if ((cur.pendingToolCalls ?? []).length > 0) return; // 还有待确认的 MCP 工具
      await continueChain(sessionId, messages);
    },

    /**
     * 切换会话级执行模式（2026-11-04 第一步）。
     *
     * 模式是**会话级**的：随对话保持（追问轮沿用），新对话复位到默认档。
     * 非法值一律归一到默认档（plan）——绝不落到更宽松的档。
     */
    setMode: (sessionId, mode) => {
      if (!(sessionId in get().sessions)) return; // 无切片：不留幽灵状态
      patch(sessionId, { mode: normalizeAiExecMode(mode) });
    },
  };
});

/** 便捷选择器：会话切片（无则空切片——组件侧免 undefined 分支）。 */
export function useSessionAi(sessionId: string): SessionAiState {
  return useAiStore((s) => s.sessions[sessionId]) ?? EMPTY_SLICE;
}
