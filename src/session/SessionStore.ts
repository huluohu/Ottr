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
// 凭据纪律：前端只持有 host_id；attach_host_session 在 Rust 侧解析/解密凭据，
// 本 store 永不接触明文。会话恢复（open_host_ids localStorage）只还原标签、
// 不自动连接（安全考虑：无人值守窗口重开不应悄悄发起 SSH 连接）。
import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Host } from "../vault/api";
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

/** `ottr://host-key-ask` 事件载荷（Rust HostKeyAskPayload 同构，serde snake_case）。 */
export interface HostKeyAskPayload {
  host_id: number;
  host_name: string;
  fingerprint: string;
  kind: "first" | "pending" | "changed";
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
        void get().connect(existing.id);
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
      status: "disconnected",
      rustId: null,
      attempt: 0,
      lastError: null,
      nextRetryAt: null,
      paneOf: null,
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
    if (opts?.autoConnect !== false) void get().connect(id);
    return id;
  },

  closeTab: (id) => {
    const st0 = get();
    // 分屏 pane 与标签同生命周期：根 + 全部 pane 一起收尾（drop/定时器/注册表）
    const doomed = st0.sessions.filter((s) => s.id === id || s.paneOf === id);
    for (const session of doomed) {
      cancelRetryTimer(session.id);
      unregisterSink(session.id);
      if (session.rustId) {
        // 主动 drop：Rust 转发循环就地取消（session-closed=cancelled，事件端忽略）
        void invoke("drop_session", { id: session.rustId }).catch(() => {});
      }
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
    // generation 守卫：作废在途 attach（迟到的成功不得覆盖手动态）
    const session = get().sessions.find((s) => s.id === id);
    if (session?.rustId) {
      void invoke("drop_session", { id: session.rustId }).catch(() => {});
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

    const chan = new Channel<unknown>();
    const sink = sinks.get(id);
    chan.onmessage = (m) => {
      try {
        sink?.write(toBytes(m));
      } catch {
        // 非二进制帧忽略（Phase 0 探针路径不适用于正式会话）
      }
    };
    const size = sink?.getSize() ?? { cols: 80, rows: 24 };

    try {
      const rustId = await invoke<string>("attach_host_session", {
        hostId: session.hostId,
        cols: size.cols,
        rows: size.rows,
        onData: chan,
      });
      if (gen !== generations.get(id) || !get().sessions.some((s) => s.id === id)) {
        // 孤儿收尾（评审 I-1，fix 1/5）：标签已关/手动断开/已换代期间 attach 才
        // 成功——rustId 若不落地就没人持有（closeTab 时 rustId 还是 null 无可
        // drop），Channel send 永不失败、转发循环不退、keepalive 也杀不掉健康
        // 连接上的孤儿（服务端 shell 同样滞留）。best-effort 显式丢弃。
        void invoke("drop_session", { id: rustId }).catch(() => {});
        return;
      }
      set((st) => ({
        sessions: patchSession(st.sessions, id, {
          status: "connected",
          rustId,
          attempt: 0,
          nextRetryAt: null,
          lastError: null,
        }),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
    const session = get().sessions.find(
      (s) => s.hostId === payload.host_id && s.status === "connecting",
    );
    if (!session) return; // 非我方发起的问询（无在途 connect）→ Rust 侧 60s 自行超时
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
      status: "disconnected",
      rustId: null,
      attempt: 0,
      lastError: null,
      nextRetryAt: null,
      paneOf: tabId,
    };
    set((s0) => ({
      sessions: [...s0.sessions, paneSession],
      trees: { ...s0.trees, [tabId]: splitLeaf(s0.trees[tabId], anchor, newId, dir) },
      activePane: { ...s0.activePane, [tabId]: newId },
    }));
    // 分屏即连同一主机（iTerm 惯例：新 pane 就是新会话）；连接失败走横幅，不连坐原 pane
    void get().connect(newId);
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
