// SessionStore（Task 7，A6）：多标签会话管理的全局状态机。
//
// 状态机（每会话独立）：
//   disconnected ──connect()──▶ connecting ──attach 成功──▶ connected
//        ▲                          │                          │
//        │        attach 失败（host key 拒绝）→ disconnected    │ 连接丢失
//        │                          │（首次连接失败不自动重连）  ▼
//        │                          ▼                reconnecting ──退避到期──▶ connecting
//        └────── 达到重连上限 ── reconnecting（ottr://session-closed）   ▲
//                                   │ ottr://host-key-ask            │ attach 成功
//                                   ▼                                │
//                            waiting_host_key ──decideHostKey(true)──┘
//   手动断开（disconnect/closeTab）→ cancelled，任何挂起重连/在途 attach 作废
//   （generation 计数守卫，迟到的 attach 成功不覆盖手动态）。
//
// 重连策略（简报定值）：指数退避 1/2/4/8/16s、30s 封顶，最多 5 次
// （可配 settings，暂 localStorage——vault settings 表迁移点，见 SETTINGS_KEY 注释）；
// keepalive 60s 在 Rust 传输层（russh keepalive_interval，不进数据流），
// 前端只消费 `ottr://session-closed` 事件驱动重连。
//
// BL-501 防线（T0，2026-10-01）：①openTab/splitPane 的新会话 connect 经
// deferConnect 投递宏任务——同步上下文里 invoke attach 的响应会被 WKWebView
// IPC 静默丢失（实证见 deferConnect 注释）；②attach 看门狗 100s 兜底复位
// （Rust 侧限时上限 ≈95s 之后），杜绝「永久正在连接」；③onData sink 每次
// 现查（同步 connect 时 Terminal 尚未挂载，闭包捕获恒 undefined）。
//
// 凭据纪律：前端只持有 host_id；attach_host_session 在 Rust 侧解析/解密凭据，
// 本 store 永不接触明文。会话恢复（open_host_ids localStorage）只还原标签、
// 不自动连接（安全考虑：无人值守窗口重开不应悄悄发起 SSH 连接）。
import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Host, HostProtocol } from "../vault/api";
import {
  closeLeaf,
  leaf,
  leaves,
  splitLeaf,
  setRatioAt,
  type PaneTree,
} from "../terminal/split";

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "waiting_host_key";

/** `ottr://host-key-ask` 事件载荷（Rust HostKeyAskPayload 同构，serde snake_case）。
 * 跳板链逐跳问询（Phase 2 Task 2）：host_id = 该跳自己的主机 id（裁定时按它
 * 落端点信任锚）；hop = 跳序号（0 起，弹窗带「第 N 跳」标识）；origin_host_id =
 * 发起连接的主机（问询归属在途 connect 的标签）。直连问询两字段缺省。 */
export interface HostKeyAskPayload {
  host_id: number;
  host_name: string;
  fingerprint: string;
  kind: "first" | "pending" | "changed";
  hop?: number;
  origin_host_id?: number;
}

/** 弹窗态的问询（挂上发起问询的会话）。 */
export interface HostKeyAsk extends HostKeyAskPayload {
  sessionId: string;
}

/** `ottr://session-closed` 事件载荷（Rust SessionClosedPayload 同构）。 */
export interface SessionClosedPayload {
  id: string;
  reason: "cancelled" | "closed" | "ipc_failed";
}

export interface Session {
  /** 标签 id（uuid，跨重连稳定）；Rust 会话 id 另存 rustId。 */
  id: string;
  hostId: number;
  hostName: string;
  address: string;
  port: number;
  username: string | null;
  /** 主机协议（Phase 2 Task 5）：ftp/ftps = 纯文件会话（无 PTY 终端）。 */
  protocol: HostProtocol;
  /** 跳板链归属（host.jump_chain_id 会话内拷贝；分屏 pane 与标签同源）：
   * 非空 = attach 走链式路径，Rust 侧 connect 预算 = 75s×(跳数+1)——
   * attach 看门狗只护直连（见 ATTACH_WATCHDOG_MS 注释），链式不武装。 */
  jumpChainId: number | null;
  status: SessionStatus;
  /** 当前 Rust 侧会话 id（attach 成功后非空；重连期间清空）。 */
  rustId: string | null;
  /** 已进行的自动重连次数（0 = 从未断线/已成功复位）。 */
  attempt: number;
  lastError: string | null;
  /** 下一次自动重连的绝对时刻（Date.now 基）；null = 无挂起重连。 */
  nextRetryAt: number | null;
  /** 分屏归属（Task 8）：null = 标签根会话（TabBar 只渲染根）；
   * 非空 = 所属标签根会话 id（一个标签一棵 pane 树，树叶 id = 会话 id）。 */
  paneOf: string | null;
  /** 会话编码（Task 9，A9）：初值 = host encoding_override（支持集内）兜底
   * utf-8；setSessionEncoding 切换（即切即生效，不写回 host）。
   * 【语义裁定（fix 1/5）】重连=新会话：connect 成功后编码一律从
   * encodingOverride 重新派生——手动切换只活在当前连接内，不跨重连。 */
  encoding: SessionEncoding;
  /** host.encoding_override 的派生值（支持集内，兜底 utf-8；重连下发源）。 */
  encodingOverride: SessionEncoding;
  /** detect_hint 提示（Rust `ottr://encoding-hint`）：非空 = 展示
   * 「检测到 GBK，切换？」提示条；接受/忽略后清空（per-host 一次，可关）。 */
  encodingHint: SessionEncoding | null;
  /** 生产环境主机标记（Phase 2 Task 11，B11）：终端 pane 红框 + TabBar PROD
   * 徽标的依据；host.is_production 的会话内拷贝（分屏 pane 与标签同源）。 */
  isProduction: boolean;
  /** 监控开关（Phase 3 Task 1，B4 上半）：host.monitor_enabled 的会话内拷贝。
   * attach 成功后按它决定是否 monitor_start（仅标签根会话——分屏 pane 与根
   * 同主机，多份采样是纯浪费；面板消费面在 MonitorSidebar）。可选 = 存量测试
   * 夹具/旧构造点不必逐个补字段，消费面统一 `=== true`（缺省关，安全侧）。 */
  monitorEnabled?: boolean;
}

// --- 会话编码（Task 9，A9） --------------------------------------------------

/** 会话编码支持集（与 Rust encoding_from_str / ottr-term Decoder 同口径；
 * big5 等其余 T8 菜单候选 Rust 侧无解码器，显式不支持）。 */
export const SESSION_ENCODINGS = ["utf-8", "gbk", "gb18030"] as const;
export type SessionEncoding = (typeof SESSION_ENCODINGS)[number];

/** 编码 id → 展示名（徽标/提示条用；编码名不作 i18n）。 */
export function encodingName(e: SessionEncoding): string {
  return e === "utf-8" ? "UTF-8" : e === "gbk" ? "GBK" : "GB18030";
}

/** host 表 encoding_override 字符串 → 支持集内编码；无法识别 → null（兜底 utf-8）。 */
export function parseSessionEncoding(v: string | null | undefined): SessionEncoding | null {
  return (SESSION_ENCODINGS as readonly string[]).includes(v ?? "")
    ? (v as SessionEncoding)
    : null;
}

/** 编码徽标点击循环序（utf-8 → gbk → gb18030 → utf-8）。 */
export function nextEncoding(e: SessionEncoding): SessionEncoding {
  return SESSION_ENCODINGS[(SESSION_ENCODINGS.indexOf(e) + 1) % SESSION_ENCODINGS.length];
}

const HINT_DISMISSED_KEY = "ottr.encoding.hintDismissed";

/** 已「不再提示」的 hostId 集（localStorage；「一次性可关」= 接受/忽略后同
 * host 不再弹，含换标签/重连）。 */
export function loadDismissedEncodingHosts(): number[] {
  try {
    const raw = localStorage.getItem(HINT_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function persistDismissedEncodingHosts(ids: number[]): void {
  try {
    localStorage.setItem(HINT_DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // 持久化失败不阻塞提示条
  }
}

/** `ottr://encoding-hint` 事件载荷（Rust EncodingHintPayload 同构）。 */
export interface EncodingHintPayload {
  /** Rust 会话 id（按 rustId 反查会话）。 */
  id: string;
  /** 固定 "gbk"（Rust 侧仅 detect_hint 命中 GBK 家族才发事件）。 */
  encoding: "gbk";
}

export interface SessionSettings {
  /** 自动重连上限（简报默认 5）。 */
  maxReconnectAttempts: number;
}

// --- 常量与纯函数（可测面） --------------------------------------------------

/** 重连退避基数/封顶（简报：1/2/4/8/16/30s 封顶）。 */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

/** 第 attempt 次（1 起）重连前的等待：2^(n-1) 秒，30s 封顶。 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
}

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/** settings 迁移点（Task 8 settings 表落地后改走 vault；注释钉住） */
const SETTINGS_KEY = "ottr.settings.session";
/** 会话恢复迁移点（同上）：open_host_ids 暂存 localStorage。 */
export const OPEN_TABS_KEY = "ottr.session.openHostIds";

function loadSettings(): SessionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionSettings>;
      if (typeof parsed.maxReconnectAttempts === "number" && parsed.maxReconnectAttempts >= 0) {
        return { maxReconnectAttempts: parsed.maxReconnectAttempts };
      }
    }
  } catch {
    // 损坏/不可用 → 默认值
  }
  return { maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS };
}

function loadOpenTabIds(): number[] {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number");
  } catch {
    return [];
  }
}

function persistOpenTabs(sessions: Session[]): void {
  // 只持久化标签根（paneOf=null）：分屏 pane 属于标签内部布局，恢复时由用户重开
  try {
    localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify(sessions.filter((s) => s.paneOf === null).map((s) => s.hostId)),
    );
  } catch {
    // 持久化失败不阻塞会话管理
  }
}

/** Rust Raw 帧应为 ArrayBuffer（Phase 0 定案）；string 仅 base64 fallback 时出现。 */
export function toBytes(m: unknown): Uint8Array {
  if (m instanceof ArrayBuffer) return new Uint8Array(m);
  if (m instanceof Uint8Array) return m;
  if (typeof m === "string") {
    const bin = atob(m);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`unexpected channel message type: ${typeof m}`);
}

// --- 终端 sink 与计时器（非响应式，模块级注册表） ----------------------------

/** 每会话的终端写入口 + 尺寸（SessionTerminal 挂载时注册）。 */
export interface TerminalSink {
  write: (bytes: Uint8Array) => void;
  /** 当前 cols/rows（attach 时取；未挂载回落 80x24）。 */
  getSize: () => { cols: number; rows: number };
}

const sinks = new Map<string, TerminalSink>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function registerSink(sessionId: string, sink: TerminalSink): void {
  sinks.set(sessionId, sink);
}
export function unregisterSink(sessionId: string): void {
  sinks.delete(sessionId);
}

/** host key 拒绝的可识别错误串（Rust Error::HostKeyRejected Display 前缀）。 */
export function isHostKeyRejection(err: string): boolean {
  return err.includes("host key rejected");
}

// --- 会话结束钩子（Phase 2 Task 7 会话纪要）----------------------------------
// 「会话收尾」三时机（closeTab / disconnect / 自动重连耗尽转 disconnected）向
// App 注入的钩子派发一次（消费方 = src/ai/summary.ts onSessionEnded，异步生成
// 会话纪要）。store 保持纯状态机、不反向依赖 AI 链路（setAiSettingsOpener 同
// 惯例）；钩子异常绝不反噬状态机（closeTab/disconnect 是用户交互主路径）。

/** 会话收尾信息（钩子入参；纪要生成链只需要归属三元组）。 */
export interface SessionEndInfo {
  hostId: number;
  /** 前端会话 id（标签 uuid，跨重连稳定——history.session_id 同源）。 */
  id: string;
  hostName: string;
}

let sessionEndHook: ((info: SessionEndInfo) => void) | null = null;

/** 注入/摘除会话结束钩子（App 挂载时接 onSessionEnded；null = 摘除）。 */
export function setSessionEndHook(fn: ((info: SessionEndInfo) => void) | null): void {
  sessionEndHook = fn;
}

/** 会话收尾派发（同步返回；钩子自身负责 fire-and-forget 与静默）。 */
function emitSessionEnded(session: Session): void {
  const hook = sessionEndHook;
  if (!hook) return;
  try {
    hook({ hostId: session.hostId, id: session.id, hostName: session.hostName });
  } catch (e) {
    console.warn("[session] end hook failed:", e);
  }
}

// --- store ------------------------------------------------------------------

let seq = 0;
function newSessionId(): string {
  return `tab-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

interface SessionStore {
  sessions: Session[];
  activeId: string | null;
  hostKeyAsk: HostKeyAsk | null;
  settings: SessionSettings;
  /** 分屏 pane 树（Task 8）：键 = 标签根会话 id；树叶 id = 会话 id。 */
  trees: Record<string, PaneTree>;
  /** 各标签的聚焦 pane（键 = 标签根 id；分屏/搜索/右键菜单的目标）。 */
  activePane: Record<string, string>;
  /** 搜索栏打开时目标会话 id（null = 关闭；右键菜单「搜索」/⌘F 置位）。 */
  searchSessionId: string | null;

  /** 双击主机树/⌘K 选中：开新标签并立即连接（同主机已开则只激活）。返回标签 id。 */
  openTab: (host: Host, opts?: { autoConnect?: boolean }) => string;
  /** 关标签 = drop_session（主动断开不重连）；分屏 pane 一并收尾。 */
  closeTab: (id: string) => void;
  /** 激活标签（不触发连接）。 */
  setActive: (id: string) => void;
  /** 手动断开（保留标签，状态回 disconnected）。 */
  disconnect: (id: string) => void;
  /** 连接（connect 首连与重连共用；失败按错误类别分派）。 */
  connect: (id: string) => Promise<void>;
  /** 安排第 attempt 次自动重连（指数退避；超上限转 disconnected）。 */
  scheduleReconnect: (id: string) => void;
  /** ottr://host-key-ask 事件入口：置 waiting_host_key + 弹窗态。 */
  onHostKeyAsk: (payload: HostKeyAskPayload) => void;
  /** 确认框裁定：accept=true 放行在途 attach；false = 主动断开（Rust 侧已拒）。 */
  decideHostKey: (accept: boolean) => Promise<void>;
  /** ottr://session-closed 事件入口：仅对 connected 会话触发重连（cancelled 忽略）。 */
  onSessionClosed: (payload: SessionClosedPayload) => void;
  /** 启动恢复：按 open_host_ids 还原标签（不自动连接——安全考虑，见文件头）。 */
  restoreTabs: (hosts: Host[]) => number;
  loadSettings: () => void;

  // --- 分屏（Task 8） -------------------------------------------------------
  /** 在标签的聚焦 pane 处分裂（dir 透传 split.ts），新 pane 连同一主机并聚焦。 */
  splitPane: (tabId: string, dir: "row" | "column") => void;
  /** 关闭单个 pane（根 pane = 关标签）；兄弟子树提升，聚焦移交给存活 pane。 */
  closePane: (sessionId: string) => void;
  /** 点击/键盘聚焦某 pane（分屏与搜索的目标）。 */
  setActivePane: (tabId: string, sessionId: string) => void;
  /** 拖拽分隔条：path 定位 split 节点（split.ts dividers 的 path 语义）。 */
  setPaneRatio: (tabId: string, path: readonly number[], ratio: number) => void;
  /** 打开搜索栏并定位到会话（null = 关闭）。 */
  openSearch: (sessionId: string | null) => void;
  /** ⌘R 历史面板插入（Task 15）：命令文本写入当前聚焦 pane 的 PTY——
   * write_session 不带回车（T13 惯例：落进输入行由用户确认执行）。
   * 无活动会话/未连接时静默（面板侧照常关闭）。 */
  insertToFocusedPane: (text: string) => void;

  // --- 会话编码（Task 9，A9） -----------------------------------------------
  /** 切换会话编码：状态即变 + Rust 侧 set_session_encoding（残字结算文本写回
   * 终端）；未连接时只记状态（connect 成功后统一下发）。 */
  setSessionEncoding: (id: string, encoding: SessionEncoding) => void;
  /** ottr://encoding-hint 事件入口：按 rustId 反查会话；已是目标编码或该 host
   * 已「不再提示」则忽略。 */
  onEncodingHint: (payload: EncodingHintPayload) => void;
  /** 提示条「切换」：切到提示编码 + 同 host 记「不再提示」。 */
  acceptEncodingHint: (id: string) => void;
  /** 提示条「忽略」：同 host 记「不再提示」（一次性可关）。 */
  dismissEncodingHint: (id: string) => void;
}

/** 会话内联状态补丁（找不到会话时静默——迟到事件的常规路径）。 */
function patchSession(sessions: Session[], id: string, patch: Partial<Session>): Session[] {
  return sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

function cancelRetryTimer(id: string): void {
  const t = retryTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    retryTimers.delete(id);
  }
}

/** 新建会话的 connect 投递到宏任务（BL-501 根因修复，T0 实证）。
 * openTab/splitPane 在同一事件处理器里同步 `set()`（zustand +
 * useSyncExternalStore 触发同步重渲染）后**立刻** invoke attach——该上下文下
 * WKWebView 的 invoke 响应（及 onData 通道帧）会**静默丢失**：Rust 命令正常
 * 执行完毕（attach 完整落账、probe/inject 任务全跑完），前端 promise 永不
 * settle → 永久停留「正在连接」。确定性复现：首连成功 → ✕ 关标签 → ⌘K 重连
 * （3/3）；连「同运行首个 attach」与「同会话自动重连」均不受影响。投递到
 * setTimeout(0) 脱开该同步上下文后恢复正常。防御纵深另有 connect() 的
 * attach 看门狗（ATTACH_WATCHDOG_MS）。 */
function deferConnect(id: string): void {
  setTimeout(() => {
    void useSessionStore.getState().connect(id);
  }, 0);
}

// --- attach 看门狗（BL-501 防御纵深，T0） ------------------------------------
// invoke 响应可能被 WKWebView IPC 层静默丢失（T0 实证：触发面见 deferConnect
// 注释；Rust 命令侧一切正常完成）。响应一旦丢失，await 永不 settle，会话永久
// 停留「正在连接」且无任何错误面。看门狗在超出 Rust 侧全部限时上限（TOFU 问询
// 60s 含于 connect 限时 75s 内 + open_pty/request_shell 各 10s ≈ 95s）后仍无
// settle 时，把会话复位为 disconnected（带 lastError），让用户可重试；若丢失的
// 响应只是迟到，随后照常走守卫路径（gen 未变 → 迟到成功照常落 connected；用户
// 已重试 → 孤儿分支 drop_session 清掉迟到会话），两条出路都收敛。
// **只护直连**（评审 I-2，fix 1/5）：链式预算 75s×(跳数+1)（2 跳合法最坏 ≈170s
// > 100s），前端拿不到跳数、不可缩放——链式不武装，由 Rust 侧全程超时兜底
// （见 connect() 武装点注释）。
const ATTACH_WATCHDOG_MS = 100_000;
const attachWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

function armAttachWatchdog(id: string, gen: number): void {
  cancelAttachWatchdog(id);
  attachWatchdogs.set(
    id,
    setTimeout(() => {
      attachWatchdogs.delete(id);
      const st = useSessionStore.getState();
      const session = st.sessions.find((s) => s.id === id);
      // 守卫：换代/关标签/已 settle（rustId 落地）均不触发；waiting_host_key 也
      // 覆盖（问询 60s + 决议后握手全程都在 100s 上限内，正常路径到不了这里）。
      if (
        gen !== generations.get(id) ||
        !session ||
        session.rustId !== null ||
        (session.status !== "connecting" && session.status !== "waiting_host_key")
      ) {
        return;
      }
      useSessionStore.setState((prev) => ({
        sessions: patchSession(prev.sessions, id, {
          status: "disconnected",
          lastError: "attach: no response from backend (watchdog)",
          nextRetryAt: null,
        }),
      }));
    }, ATTACH_WATCHDOG_MS),
  );
}

function cancelAttachWatchdog(id: string): void {
  const t = attachWatchdogs.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    attachWatchdogs.delete(id);
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeId: null,
  hostKeyAsk: null,
  settings: { maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS },
  trees: {},
  activePane: {},
  searchSessionId: null,

  loadSettings: () => set({ settings: loadSettings() }),

  openTab: (host, opts) => {
    const existing = get().sessions.find((s) => s.hostId === host.id);
    if (existing) {
      set({ activeId: existing.id });
      if (opts?.autoConnect !== false && existing.status === "disconnected") {
        // 同款 deferConnect（评审 I-1，fix 1/5）：set({activeId}) 后同任务同步
        // connect 与钉死触发面（同步 set → 同任务 invoke）同构——⌘K 再点已断线
        // 标签即真实路径。scheduleReconnect 的 connect 本就在 retry timer
        // （宏任务）里，不受影响；此处是漏网之鱼。
        deferConnect(existing.id);
      }
      return existing.id;
    }
    const id = newSessionId();
    const session: Session = {
      id,
      hostId: host.id,
      hostName: host.name,
      address: host.address,
      port: host.port,
      username: host.username,
      protocol: host.protocol ?? "ssh",
      jumpChainId: host.jump_chain_id ?? null,
      status: "disconnected",
      rustId: null,
      attempt: 0,
      lastError: null,
      nextRetryAt: null,
      paneOf: null,
      encodingOverride: parseSessionEncoding(host.encoding_override) ?? "utf-8",
      encoding: parseSessionEncoding(host.encoding_override) ?? "utf-8",
      encodingHint: null,
      isProduction: host.is_production ?? false,
      monitorEnabled: host.monitor_enabled ?? false,
    };
    set((st) => {
      const sessions = [...st.sessions, session];
      persistOpenTabs(sessions);
      return {
        sessions,
        activeId: id,
        trees: { ...st.trees, [id]: leaf(id) },
        activePane: { ...st.activePane, [id]: id },
      };
    });
    if (opts?.autoConnect !== false) deferConnect(id);
    return id;
  },

  closeTab: (id) => {
    const st0 = get();
    // 分屏 pane 与标签同生命周期：根 + 全部 pane 一起收尾（drop/定时器/注册表）
    const doomed = st0.sessions.filter((s) => s.id === id || s.paneOf === id);
    for (const session of doomed) {
      cancelRetryTimer(session.id);
      cancelAttachWatchdog(session.id);
      unregisterSink(session.id);
      if (session.rustId) {
        // 主动 drop：Rust 转发循环就地取消（session-closed=cancelled，事件端忽略）
        void invoke("drop_session", { id: session.rustId }).catch(() => {});
      }
      // 会话收尾（Task 7 纪要）：关标签 = 会话结束（手动断开也生成，裁定 #1）
      emitSessionEnded(session);
    }
    const doomedIds = new Set(doomed.map((s) => s.id));
    if (st0.hostKeyAsk && doomedIds.has(st0.hostKeyAsk.sessionId)) {
      // 关掉等待确认的标签：同步回拒绝，别让 Rust 侧问询白挂 60s
      void invoke("host_key_decision", {
        hostId: st0.hostKeyAsk.host_id,
        fingerprint: st0.hostKeyAsk.fingerprint,
        accept: false,
      }).catch(() => {});
    }
    set((st) => {
      const sessions = st.sessions.filter((s) => !doomedIds.has(s.id));
      persistOpenTabs(sessions);
      const activeId =
        st.activeId != null && doomedIds.has(st.activeId)
          ? (sessions.filter((s) => s.paneOf === null).slice(-1)[0]?.id ?? null)
          : st.activeId;
      const trees = { ...st.trees };
      const activePane = { ...st.activePane };
      delete trees[id];
      delete activePane[id];
      return {
        sessions,
        activeId,
        trees,
        activePane,
        hostKeyAsk:
          st.hostKeyAsk && doomedIds.has(st.hostKeyAsk.sessionId) ? null : st.hostKeyAsk,
        searchSessionId:
          st.searchSessionId != null && doomedIds.has(st.searchSessionId)
            ? null
            : st.searchSessionId,
      };
    });
  },

  setActive: (id) => set({ activeId: id }),

  disconnect: (id) => {
    cancelRetryTimer(id);
    cancelAttachWatchdog(id);
    // generation 守卫：作废在途 attach（迟到的成功不得覆盖手动态）
    const session = get().sessions.find((s) => s.id === id);
    if (session?.rustId) {
      void invoke("drop_session", { id: session.rustId }).catch(() => {});
    }
    if (session) {
      // 会话收尾（Task 7 纪要）：手动断开也是会话结束（裁定 #1）
      emitSessionEnded(session);
    }
    bumpGeneration(id);
    set((st) => ({
      sessions: patchSession(st.sessions, id, {
        status: "disconnected",
        rustId: null,
        attempt: 0,
        nextRetryAt: null,
        lastError: null,
      }),
    }));
  },

  connect: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    // priorAttempts > 0 = 本会话曾连接成功过（这次 connect 是断线重连路径的一步）；
    // 首连失败不自动重连（认证/网络错误重试易变成打凭据的循环），只标终态。
    const priorAttempts = session.attempt;
    const gen = bumpGeneration(id);
    set((st) => ({
      sessions: patchSession(st.sessions, id, {
        status: "connecting",
        lastError: null,
        nextRetryAt: null,
      }),
    }));
    // 看门狗只护直连（评审 I-2，fix 1/5）：链式 connect 预算 = 75s×(跳数+1)
    // （每跳还各挂 60s 问询），前端无跳数不可缩放——100s 会对逐跳答问询稍慢的
    // 合法挂起误复位 + 随后孤儿 drop 误杀真会话。链式由 Rust 侧全程 tokio
    // timeout（75s×(跳数+1) + open_pty/request_shell 各 10s）兜底，命令必 settle；
    // IPC 响应丢失的触发面已被 deferConnect 结构性移除，链式不再叠第二道兜底。
    if (session.jumpChainId == null) armAttachWatchdog(id, gen);

    // FTP/FTPS 会话（Phase 2 Task 5）：纯文件面——无 PTY、无 on_data 通道、
    // 无 host key TOFU（Rust 侧 ftp_attach 直接连，不产生 host-key-ask 事件）。
    const isFtp = session.protocol === "ftp" || session.protocol === "ftps";
    const chan = new Channel<unknown>();
    chan.onmessage = (m) => {
      try {
        // sink 每次 onmessage 现查（不闭包捕获）：openTab/splitPane 的同步 connect
        // 早于 Terminal 挂载注册 sink——捕获时恒为 undefined 会让整段会话输出静默。
        sinks.get(id)?.write(toBytes(m));
      } catch {
        // 非二进制帧忽略（Phase 0 探针路径不适用于正式会话）
      }
    };
    const size = sinks.get(id)?.getSize() ?? { cols: 80, rows: 24 };

    try {
      const rustId = isFtp
        ? await invoke<string>("ftp_attach_host_session", { hostId: session.hostId })
        : await invoke<string>("attach_host_session", {
            hostId: session.hostId,
            cols: size.cols,
            rows: size.rows,
            onData: chan,
          });
      cancelAttachWatchdog(id);
      if (gen !== generations.get(id) || !get().sessions.some((s) => s.id === id)) {
        // 孤儿收尾（评审 I-1，fix 1/5）：标签已关/手动断开/已换代期间 attach 才
        // 成功——rustId 若不落地就没人持有（closeTab 时 rustId 还是 null 无可
        // drop），Channel send 永不失败、转发循环不退、keepalive 也杀不掉健康
        // 连接上的孤儿（服务端 shell 同样滞留）。best-effort 显式丢弃。
        // 状态不在此复位（BL-501 终审「复位 connecting」提议的语义裁定，T0）：
        // gen 失配时状态必已属于更新的 generation——disconnect 自身复位
        // disconnected、更新 connect 自置 connecting——此处再写状态会**覆盖更新
        // generation 的在途状态**；`!exists` 支则会话已删、无可复位。两支均无
        // 「停留 connecting」残留（状态机推演见 task-0 报告），静默返回即正确收尾。
        void invoke("drop_session", { id: rustId }).catch(() => {});
        return;
      }
      // 会话编码（Task 9；语义裁定 fix 1/5）：重连=新会话——编码一律从 host
      // encoding_override 重新派生（Rust attach 侧同一来源初始化，两处口径一致），
      // 无条件 set_session_encoding 显式对齐（含 utf-8，自愈式同步）；上一会话的
      // 手动切换不跨重连（切换不写回 host，徽标随 session.encoding 复位，
      // 与 Rust 实际解码一致）。把 Rust 侧残留的解码状态也一并覆盖。
      const override =
        parseSessionEncoding(
          get().sessions.find((s) => s.id === id)?.encodingOverride,
        ) ?? "utf-8";
      set((st) => ({
        sessions: patchSession(st.sessions, id, {
          status: "connected",
          rustId,
          attempt: 0,
          nextRetryAt: null,
          lastError: null,
          encoding: override,
        }),
      }));
      void invoke("set_session_encoding", { id: rustId, encoding: override }).catch(() => {});
      // 监控采样启动（Phase 3 Task 1，B4 上半）：host 开了监控的标签根会话
      // attach 成功即开（仅根——分屏 pane 与根同主机，多份采样纯浪费）。
      // 会话收尾（关标签/断开）由 Rust 侧 session_down 摘除采样任务，前端
      // 无需对位 stop；重连 = 新 rustId = 新采样窗口。
      if (session.monitorEnabled && session.paneOf === null) {
        void invoke("monitor_start", { id: rustId }).catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      cancelAttachWatchdog(id);
      if (gen !== generations.get(id) || !get().sessions.some((s) => s.id === id)) return;
      if (isHostKeyRejection(msg)) {
        // 主机密钥被拒（用户拒绝/超时/changed 默认拒）：终态，不自动重连
        set((st) => ({
          sessions: patchSession(st.sessions, id, {
            status: "disconnected",
            lastError: msg,
            rustId: null,
            nextRetryAt: null,
          }),
        }));
        return;
      }
      // 首次连接失败不自动重连；断线重连（此前连接成功过）才走 scheduleReconnect。
      if (priorAttempts > 0) {
        set((st) => ({
          sessions: patchSession(st.sessions, id, { status: "reconnecting", lastError: msg }),
        }));
        get().scheduleReconnect(id);
      } else {
        set((st) => ({
          sessions: patchSession(st.sessions, id, {
            status: "disconnected",
            lastError: msg,
            nextRetryAt: null,
          }),
        }));
      }
    }
  },

  scheduleReconnect: (id) => {
    const st = get();
    const session = st.sessions.find((s) => s.id === id);
    if (!session) return;
    const attempt = session.attempt + 1;
    if (attempt > st.settings.maxReconnectAttempts) {
      cancelRetryTimer(id);
      // 会话收尾（Task 7 纪要）：自动重连耗尽 = 会话终态（异常断开在重连进行中
      // 不生成——session_id 跨重连稳定，会话可能继续；耗尽才收口）
      emitSessionEnded(session);
      set((prev) => ({
        sessions: patchSession(prev.sessions, id, {
          status: "disconnected",
          nextRetryAt: null,
          rustId: null,
        }),
      }));
      return;
    }
    const delay = reconnectDelayMs(attempt);
    cancelRetryTimer(id);
    set((prev) => ({
      sessions: patchSession(prev.sessions, id, {
        attempt,
        status: "reconnecting",
        rustId: null,
        nextRetryAt: Date.now() + delay,
      }),
    }));
    retryTimers.set(
      id,
      setTimeout(() => {
        retryTimers.delete(id);
        void get().connect(id);
      }, delay),
    );
  },

  onHostKeyAsk: (payload) => {
    // 归属（Phase 2 Task 2）：链式连接的逐跳问询落在链上 hop 主机上——
    // origin_host_id 才是发起连接的主机（前端据此找到在途 connect 的标签）；
    // 直连问询无 origin 字段，host_id 即发起方。
    const originId = payload.origin_host_id ?? payload.host_id;
    const session = get().sessions.find(
      (s) => s.hostId === originId && s.status === "connecting",
    );
    if (!session) {
      // 无在途 connect 的问询（跳板链编辑器的「测试连接」/孤儿问询）：仍弹
      // 确认框——裁定的 host_key_decision 不依赖会话；不弹则 Rust 侧 60s
      // 超时按拒绝收尾。sessionId 空串 = 无关联会话（弹窗关闭只经裁定按钮）。
      set({ hostKeyAsk: { ...payload, sessionId: "" } });
      return;
    }
    set({
      hostKeyAsk: { ...payload, sessionId: session.id },
      sessions: patchSession(get().sessions, session.id, { status: "waiting_host_key" }),
    });
  },

  decideHostKey: async (accept) => {
    const ask = get().hostKeyAsk;
    if (!ask) return;
    set({ hostKeyAsk: null });
    try {
      await invoke("host_key_decision", {
        hostId: ask.host_id,
        fingerprint: ask.fingerprint,
        accept,
      });
    } catch (e) {
      // 问询已超时/已裁定：Rust 侧报错；会话按拒绝收尾（下方统一处理）
      if (accept) {
        set((st) => ({
          sessions: patchSession(st.sessions, ask.sessionId, {
            status: "disconnected",
            lastError: String(e),
          }),
        }));
        return;
      }
    }
    if (!accept) {
      // 拒绝：Rust 策略回 false → 在途 attach 以 host key rejected 失败（终态）。
      // 直接标 disconnected，文案由 connect 的错误路径或这里补齐。
      set((st) => ({
        sessions: patchSession(st.sessions, ask.sessionId, {
          status: "disconnected",
          lastError: "host key rejected by user decision",
        }),
      }));
    }
    // accept：不改状态——在途 attach 继续走（waiting_host_key → connected）。
    // 注意 waiting → connecting 的展示由 attach 解析自然完成（无中间动作）。
  },

  onSessionClosed: (payload) => {
    const session = get().sessions.find((s) => s.rustId === payload.id);
    if (!session) return; // 未知会话（已关标签）——忽略
    if (payload.reason === "cancelled") return; // 主动关闭，不重连
    if (session.status !== "connected") return; // 手动断开/已在重连——忽略迟到事件
    set((st) => ({
      sessions: patchSession(st.sessions, session.id, { rustId: null }),
    }));
    get().scheduleReconnect(session.id);
  },

  restoreTabs: (hosts) => {
    const ids = loadOpenTabIds();
    let restored = 0;
    for (const hostId of ids) {
      const host = hosts.find((h) => h.id === hostId);
      if (!host) continue; // 主机已删除：跳过（持久化随下次开关标签自愈）
      get().openTab(host, { autoConnect: false });
      restored++;
    }
    return restored;
  },

  // --- 分屏（Task 8） -------------------------------------------------------

  splitPane: (tabId, dir) => {
    const st = get();
    const root = st.sessions.find((s) => s.id === tabId && s.paneOf === null);
    const tree = st.trees[tabId];
    if (!root || !tree) return;
    const from = st.activePane[tabId] ?? tabId;
    // 聚焦 pane 可能刚被关闭等竞态清掉：回退到树的第一个存活叶
    const anchor = leaves(tree).includes(from) ? from : leaves(tree)[0];
    if (!anchor) return;
    const newId = newSessionId();
    const paneSession: Session = {
      id: newId,
      hostId: root.hostId,
      hostName: root.hostName,
      address: root.address,
      port: root.port,
      username: root.username,
      protocol: root.protocol,
      jumpChainId: root.jumpChainId, // pane 与标签同源（链式归属随根）
      status: "disconnected",
      rustId: null,
      attempt: 0,
      lastError: null,
      nextRetryAt: null,
      paneOf: tabId,
      encodingOverride: root.encodingOverride, // pane 与标签同源（重连派生一致）
      encoding: root.encoding, // 分屏 pane 沿用标签的会话编码
      encodingHint: null,
      isProduction: root.isProduction, // pane 与标签同源（分屏沿用生产标记）
      monitorEnabled: root.monitorEnabled, // pane 与标签同源（监控归属一致）
    };
    set((s0) => ({
      sessions: [...s0.sessions, paneSession],
      trees: { ...s0.trees, [tabId]: splitLeaf(s0.trees[tabId], anchor, newId, dir) },
      activePane: { ...s0.activePane, [tabId]: newId },
    }));
    // 分屏即连同一主机（iTerm 惯例：新 pane 就是新会话）；连接失败走横幅，不连坐原 pane
    deferConnect(newId);
  },

  closePane: (sessionId) => {
    const st = get();
    const session = st.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const tabId = session.paneOf ?? sessionId; // 根 pane 的关闭 = 关标签
    if (tabId === sessionId) {
      get().closeTab(sessionId);
      return;
    }
    const tree = st.trees[tabId];
    if (!tree) return;
    const next = closeLeaf(tree, sessionId);
    // 会话收尾（同 closeTab 的 pane 部分；定时器/注册表对已清项幂等）
    cancelRetryTimer(sessionId);
    cancelAttachWatchdog(sessionId);
    unregisterSink(sessionId);
    if (session.rustId) {
      void invoke("drop_session", { id: session.rustId }).catch(() => {});
    }
    if (st.hostKeyAsk?.sessionId === sessionId) {
      void invoke("host_key_decision", {
        hostId: st.hostKeyAsk.host_id,
        fingerprint: st.hostKeyAsk.fingerprint,
        accept: false,
      }).catch(() => {});
    }
    set((s0) => ({
      sessions: s0.sessions.filter((s) => s.id !== sessionId),
      searchSessionId: s0.searchSessionId === sessionId ? null : s0.searchSessionId,
    }));
    if (next === null) {
      // 树空了（关掉最后一个 pane）→ 标签一并消亡；closeTab 幂等收尾剩余状态
      get().closeTab(tabId);
      return;
    }
    set((s0) => {
      const activePane = { ...s0.activePane };
      if (activePane[tabId] === sessionId) {
        activePane[tabId] = leaves(next)[0] ?? tabId; // 聚焦移交存活 pane
      }
      return { trees: { ...s0.trees, [tabId]: next }, activePane };
    });
  },

  setActivePane: (tabId, sessionId) =>
    set((st) => ({ activePane: { ...st.activePane, [tabId]: sessionId } })),

  setPaneRatio: (tabId, path, ratio) =>
    set((st) => {
      const tree = st.trees[tabId];
      if (!tree) return {};
      return { trees: { ...st.trees, [tabId]: setRatioAt(tree, path, ratio) } };
    }),

  openSearch: (sessionId) => set({ searchSessionId: sessionId }),

  insertToFocusedPane: (text) => {
    const st = get();
    const focused =
      st.activeId != null ? (st.activePane[st.activeId] ?? st.activeId) : null;
    const session = st.sessions.find((s) => s.id === focused);
    if (!session?.rustId) return; // 无活动终端/未连接：无处插入（静默）
    void invoke("write_session", {
      id: session.rustId,
      bytes: Array.from(new TextEncoder().encode(text)),
    }).catch(() => {}); // 写失败（会话刚断）静默——同击键路径的容错口径
  },

  // --- 会话编码（Task 9，A9） -----------------------------------------------

  setSessionEncoding: (id, encoding) => {
    set((st) => ({
      sessions: patchSession(st.sessions, id, { encoding, encodingHint: null }),
    }));
    const session = get().sessions.find((s) => s.id === id);
    if (!session?.rustId) return; // 未连接：只记状态，connect 成功后统一下发
    void invoke<string>("set_session_encoding", { id: session.rustId, encoding })
      .then((flushed) => {
        // 残字结算文本（切换瞬间的批尾不完整序列，通常为空）写回终端——字节永不静默丢弃
        if (flushed) {
          sinks.get(id)?.write(new TextEncoder().encode(flushed));
        }
      })
      .catch(() => {});
  },

  onEncodingHint: (payload) => {
    // 挂账（fix 1/5 评审记录，不实现）：hint 事件与 connect resolve 存在理论
    // 竞态——探测任务在 attach 成功后 spawn，但 emit 若先于前端 rustId 落地，
    // 会被下方「未知会话」分支静默丢弃（该轮提示不弹，无重试）。概率极低
    // （同一 attach 完成事件的两条 IPC，事件通道通常后到）；若实测可复现，
    // 兜底方案 = 按 hostId 反查（payload 无 hostId，需 Rust 侧补字段）。
    const session = get().sessions.find((s) => s.rustId === payload.id);
    if (!session) return; // 未知会话（已关标签）——忽略
    if (session.encoding !== "utf-8") return; // 已在非 UTF-8 编码，无需提示
    if (loadDismissedEncodingHosts().includes(session.hostId)) return; // 同 host 一次性可关
    set((st) => ({
      sessions: patchSession(st.sessions, session.id, {
        encodingHint: parseSessionEncoding(payload.encoding) ?? "gbk",
      }),
    }));
  },

  acceptEncodingHint: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session?.encodingHint) return;
    const encoding = session.encodingHint;
    persistDismissedEncodingHosts([
      ...new Set([...loadDismissedEncodingHosts(), session.hostId]),
    ]);
    get().setSessionEncoding(id, encoding);
  },

  dismissEncodingHint: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    persistDismissedEncodingHosts([
      ...new Set([...loadDismissedEncodingHosts(), session.hostId]),
    ]);
    set((st) => ({
      sessions: patchSession(st.sessions, id, { encodingHint: null }),
    }));
  },
}));

// --- generation 守卫 ---------------------------------------------------------
// 每次连接/手动断开递增；在途 attach 解析时代数不符即丢弃（StrictMode 双挂载、
// 手动断开竞态、重连期间旧 connect 迟到成功——都不允许覆盖当前状态）。
const generations = new Map<string, number>();
function bumpGeneration(id: string): number {
  const next = (generations.get(id) ?? 0) + 1;
  generations.set(id, next);
  return next;
}
