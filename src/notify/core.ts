// 统一通知管线（Task 12，spec §7）：枢纽在 TS——
//   notify(event) ─┬─ ① 应用内通知中心（vault notifications 表，Rust 命令落库）
//                  ├─ ② 系统通知（tauri-plugin-notification；前台静默）
//                  └─ ③ 外部渠道（Phase 3 挂载，channels 空数组 = 接口先留）
//
// 语义裁定（task-12 简报/裁定 #1、#3）：
//   * 限频聚合：同 key（kind + host_id）60s 窗口内只放行首条——传输连败/重连
//     风暴聚合成一条，绝不灌表也不弹系统通知；放行才开新窗口（首条时间戳起算）。
//   * 按 kind 静音（存 vault settings `notify.muted_kinds`）：静音 = 管线入口
//     丢弃（不落表、不弹、不分发）——「关掉这类通知」的直译语义。
//   * 系统通知前台静默：窗口持有焦点时只落①不弹②（用户正看着应用，中心
//     已足够）；失焦（后台/最小化）才弹。Phase 1 定值不做配置项（可配挂账）。
//   * 事件源不改（T10/T7 既有 Tauri 事件原样订阅）：transfer_end 成功不通知
//     （噪音），失败/取消通知；session-closed 仅异常断开（closed/ipc_failed）
//     通知，主动关闭（cancelled）不通知。AI 事件 Phase 1 无（T13 加）。
// 可测性：Tauri 面（时间/焦点/系统通知）收口在 NotifyPorts 可注入端口；
// store 纯 zustand，单测直接驱动 notify() + 假端口（见 core.test.ts）。
import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "../i18n";
import { vaultApi, type Notification, type NotificationInput } from "../vault/api";
import type { TransferEndPayload } from "../files/TransferStore";
import { useTransferStore } from "../files/TransferStore";
import type { SessionClosedPayload } from "../session/SessionStore";
import { useSessionStore } from "../session/SessionStore";
import type { HostKeyChangedPayload } from "../vault/api";

// ---------------------------------------------------------------------------
// 类型（事件源 → 管线入参；kind 是静音键）
// ---------------------------------------------------------------------------

/** 事件类别（T13 起 AI 诊断完成入管线——迁移 0005 kind 列无约束）。
 * 静音键按 kind：ai 诊断完成通知可独立静音（NotificationCenter 类型区）。
 * Phase 3 Task 3（B5）：告警规则引擎的事件走 "alert"（同样可独立静音）。
 * Phase 3 Task 6（B9）：主机指纹巡检的 changed 告警走 "security"（独立静音位）。
 * Phase 4 Task 1（缺口①）：cron 定时任务完成/失败走 "cron"（独立静音位，
 * 默认不静音——语义裁定见 src/cron/events.ts 文件头）。 */
export type NotifyKind = "transfer" | "session" | "ai" | "alert" | "security" | "cron";
/** severity 合法集（Rust notifications::SEVERITIES / DB CHECK 同集）。 */
export type NotifySeverity = "info" | "success" | "warning" | "error";

export interface NotificationEvent {
  kind: NotifyKind;
  severity: NotifySeverity;
  /** 关联主机（可空——事件未必能反查到主机行；限频 key 的一部分）。 */
  host_id: number | null;
  /** i18n 词典键（中心渲染与系统通知标题都用 t(title_key)）。 */
  title_key: string;
  /** 展示文本（远端路径 / 主机名 / 错误消息——事件自带内容，不进词典）。 */
  body: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 可注入端口（测试假件注入点；生产 = 默认实现）
// ---------------------------------------------------------------------------

export interface NotifyPorts {
  now: () => number;
  /** 窗口是否持有焦点（②前台静默判定）。 */
  focused: () => boolean;
  /** 系统通知②（标题/正文已定型；权限申请与静默丢弃都在实现内）。 */
  system: (title: string, body: string) => Promise<void>;
}

/** 默认端口：plugin-notification JS API（macOS 首次调用触发系统授权；未授权
 * 时请求一次，仍拒绝则静默丢弃——系统通知是尽力而为面，绝不阻塞①落库）。 */
const defaultPorts: NotifyPorts = {
  now: () => Date.now(),
  focused: () => (typeof document !== "undefined" ? document.hasFocus() : false),
  system: async (title, body) => {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) {
      await sendNotification({ title, body });
    }
  },
};

let ports: NotifyPorts = defaultPorts;

/** 测试注入假端口（传 null 复位默认）。 */
export function setNotifyPorts(next: NotifyPorts | null): void {
  ports = next ?? defaultPorts;
}

// ---------------------------------------------------------------------------
// ③ 外部渠道分发点（Phase 3 挂载；空数组 = 接口先留）
// ---------------------------------------------------------------------------

/** 外部通知渠道接口（spec §7③）。Phase 3 实现体经 channelRegistry 挂载——
 * 管线对渠道数与失败彼此无感（单渠道失败只记 console）。
 *
 * 【签名演进（Phase 3 Task 3，裁定可演进）】新增可选 `subscribed` 订阅过滤：
 * 渠道声明自己收哪些事件（alert 规则按 channels 数组路由——spec §7「按
 * alert_rules.channels 订阅」）；缺省（undefined）= 收一切事件（Phase 1 形态
 * 与既有测试语义不变）。transfer/session/ai 事件无 channel_ids，alert 渠道
 * 的 subscribed 恒 false——外部渠道只吃显式订阅的告警。 */
export interface NotificationChannel {
  /** 渠道名（日志/诊断面）。 */
  name: string;
  /** 分发一条已放行的事件（限频/静音已在前）。 */
  send: (event: NotificationEvent) => Promise<void>;
  /** 渠道连通性自检（设置页「发送测试」用）。 */
  test: () => Promise<void>;
  /** 订阅过滤（可选；缺省 = 收一切已放行事件）。 */
  subscribed?: (event: NotificationEvent) => boolean;
}

/** 渠道挂载点（Phase 1 恒空——循环零次，接口形状由 NotificationChannel 定）。 */
export const channels: NotificationChannel[] = [];

// ---------------------------------------------------------------------------
// 管线核心
// ---------------------------------------------------------------------------

/** 限频窗口（裁定 #1 定值 60s）。 */
export const RATE_WINDOW_MS = 60_000;

/** 同 key 限频表：key → 上次放行时刻（只在放行时刷新——窗口从首条起算）。 */
const lastSeen = new Map<string, number>();

/** 【M-1 清偿（Phase 3 Task 3，B5）】聚合计数表：key → 窗口内被放行式丢弃
 * 的条数。Phase 1 的丢弃是静默的（「合并成一条」丢掉了"还有 N 条"的事实
 * ——传输风暴/告警风暴的量级不可见）；现升级为计数聚合：窗口内每丢一条
 * +1，下一条放行时把计数注入 payload.suppressed 后清零。 */
const suppressedCount = new Map<string, number>();

/** 限频 key：kind + host_id（同主机同类事件聚合；无主机按 kind 聚合）。
 * 【I-1（fix round 1）】alert 类细化含 rule_id（`alert:host:rule`）——「同
 * rule 60s 窗口合并」的直译语义：同主机不同规则各自独立开窗，规则 2 的告警
 * 不再被规则 1 的窗口吞掉（否则 suppressed 计数并入他规则事件、按错误
 * channel_ids 路由）；【Phase 4 Task 1】cron 类细化含 cron_id
 * （`cron:host:job`）——每分钟任务 2 轮内聚合成 1 条（端到端口径），不同
 * 任务互不吞；其余 kind 维持 Phase 1 口径不变。 */
export function rateKeyOf(event: NotificationEvent): string {
  if (event.kind === "alert") {
    const ruleId = event.payload?.["rule_id"] ?? "-";
    return `alert:${event.host_id ?? "-"}:${ruleId}`;
  }
  if (event.kind === "cron") {
    const cronId = event.payload?.["cron_id"] ?? "-";
    return `cron:${event.host_id ?? "-"}:${cronId}`;
  }
  return `${event.kind}:${event.host_id ?? "-"}`;
}

/** 系统通知标题（事件标题键 → 当前语言文案；i18n/index.ts 不反向依赖本模块，无环）。 */
function eventTitle(event: NotificationEvent): string {
  return i18n.t(event.title_key);
}

/** 投递面开关（可选；缺省 = 全开）。`system` = ②系统通知；cron 完成的
 * ok 轮静默②（Phase 4 Task 1 裁定：例行走完的例行成功是噪音——transfer
 * 「成功不通知」同款先例；失败/missed 照常弹）。③外部渠道不受此开关影响
 * （显式订阅 = 用户要这条流，cron_jobs.channels 订阅 ok 轮照推）。 */
export interface NotifyDelivery {
  system?: boolean;
}

/**
 * 管线入口：静音 → 限频 → ①落库（红点/列表）→ ②系统通知（前台静默）→
 * ③渠道分发。返回是否放行（测试断言面）。
 *
 * 任何一步失败都不抛（通知是尽力而为面）：落库失败跳过①继续②③；②③失败
 * 只记 console——通知链路故障不得反噬事件源（传输/会话状态机）。
 */
export async function notify(
  event: NotificationEvent,
  deliver: NotifyDelivery = {},
): Promise<boolean> {
  const { muted } = useNotifyStore.getState();
  if (muted.includes(event.kind)) {
    return false; // 静音：管线入口丢弃（不落表不弹不分发）
  }
  const key = rateKeyOf(event);
  const now = ports.now();
  const last = lastSeen.get(key);
  if (last !== undefined && now - last < RATE_WINDOW_MS) {
    // 限频：窗口内聚合——不再静默丢弃，计数挂账（M-1），下条放行时随行
    suppressedCount.set(key, (suppressedCount.get(key) ?? 0) + 1);
    return false;
  }
  lastSeen.set(key, now);
  // 放行即结算窗口账目：窗口内被聚合的条数注入 payload.suppressed（0 不注
  // ——payload 形状对无聚合场景保持原样），随后清零开新账。
  const suppressed = suppressedCount.get(key) ?? 0;
  suppressedCount.delete(key);
  if (suppressed > 0) {
    event = { ...event, payload: { ...event.payload, suppressed } };
  }

  // ① 应用内通知中心
  try {
    const input: NotificationInput = {
      kind: event.kind,
      severity: event.severity,
      host_id: event.host_id,
      title_key: event.title_key,
      body: event.body,
      payload: event.payload ?? null,
    };
    const row = await vaultApi.notifications.insert(input);
    useNotifyStore.getState().onInserted(row);
  } catch (e) {
    // 非 Tauri 环境（纯浏览器 dev）/ 后端不可达：①降级，②③照走
    console.warn("[notify] insert failed:", e);
  }

  // ② 系统通知（前台静默；deliver.system=false = 事件级静默——cron ok 轮）
  if (deliver.system !== false && !ports.focused()) {
    try {
      await ports.system(eventTitle(event), event.body);
    } catch (e) {
      console.warn("[notify] system notification failed:", e);
    }
  }

  // ③ 外部渠道（Phase 3 挂载；subscribed 缺省 = 收一切——Phase 1 形态兼容）
  for (const channel of channels) {
    if (channel.subscribed && !channel.subscribed(event)) {
      continue; // 渠道未订阅该事件（alert 规则按 channels 数组路由）
    }
    try {
      await channel.send(event);
    } catch (e) {
      console.warn(`[notify] channel ${channel.name} failed:`, e);
    }
  }
  return true;
}

/** 测试隔离：清空限频表与聚合计数（窗口状态不进 store——进程内瞬态）。 */
export function resetRateLimiter(): void {
  lastSeen.clear();
  suppressedCount.clear();
}

// ---------------------------------------------------------------------------
// 事件源接线（不改事件源——订阅 T10/T7 既有 Tauri 事件，富化主机上下文）
// ---------------------------------------------------------------------------

/** `ottr://transfer-end` → 通知失败/取消（成功不通知，噪音裁定）。
 * 主机上下文：transfer_id → TransferStore 条目（rustId）→ SessionStore 反查
 * host（host_id 进限频 key + 通知行 host_id）；查不到（应用重启后迟到的
 * 事件）按无主机聚合，body 退化为 transfer_id。 */
export function onTransferEnd(payload: TransferEndPayload): Promise<boolean> {
  if (payload.status === "done") {
    return Promise.resolve(false); // 成功不通知
  }
  const item = useTransferStore
    .getState()
    .items.find((it) => it.transferId === payload.transfer_id);
  const session = item?.rustId
    ? useSessionStore.getState().sessions.find((s) => s.rustId === item.rustId)
    : undefined;
  const failed = payload.status === "failed";
  const what = item?.remotePath ?? payload.transfer_id;
  const body = failed ? (payload.message ? `${what} — ${payload.message}` : what) : what;
  return notify({
    kind: "transfer",
    severity: failed ? "error" : "warning",
    host_id: session?.hostId ?? null,
    title_key: failed ? "notify.title.transferFailed" : "notify.title.transferCancelled",
    body,
    payload: {
      transfer_id: payload.transfer_id,
      status: payload.status,
      remote_path: item?.remotePath ?? null,
      local_path: item?.localPath ?? null,
    },
  });
}

/** `ottr://session-closed` → 仅异常断开通知（closed/ipc_failed；cancelled =
 * 主动关闭不通知）。与 SessionStore.onSessionClosed 同门卫：rustId 查不到的
 * 迟到事件静默（标签已关；那种情况 Rust 侧本来也是 cancelled 收尾）。 */
export function onSessionClosed(payload: SessionClosedPayload): Promise<boolean> {
  if (payload.reason === "cancelled") {
    return Promise.resolve(false); // 主动关闭（关标签/手动断开）
  }
  const session = useSessionStore.getState().sessions.find((s) => s.rustId === payload.id);
  if (!session) {
    return Promise.resolve(false); // 未知会话（迟到事件）——静默
  }
  return notify({
    kind: "session",
    severity: "warning",
    host_id: session.hostId,
    title_key: "notify.title.sessionLost",
    body: session.hostName,
    payload: { session_id: payload.id, reason: payload.reason },
  });
}

/** `ottr://host-key-changed` → security 告警（B9 指纹巡检）：巡检核在 Rust 侧
 * 已完成 mark_changed 落账，这里只进通知管线（①中心 + ②系统 + ③渠道）。
 * host_id 恒 null——端点键（address:port）与 hosts 行是弱关联（删主机重建
 * 不换端点），限频按 kind 聚合即可（同轮多端点漂移合并成一条恰是想要的）。 */
export function onHostKeyChanged(payload: HostKeyChangedPayload): Promise<boolean> {
  return notify({
    kind: "security",
    severity: "error",
    host_id: null,
    title_key: "notify.title.hostKeyChanged",
    body: payload.host_key,
    payload: { host_key: payload.host_key, anchor: payload.anchor, seen: payload.seen },
  });
}

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** 注册管线事件监听 + 拉初始态（幂等；StrictMode 双挂载只接一次）。
 * App 挂载时调用一次（与 initSessionEvents/initTransferEvents 并列）。 */
export async function initNotifyEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  unlisteners.push(
    await listen<TransferEndPayload>("ottr://transfer-end", (e) => {
      void onTransferEnd(e.payload);
    }),
  );
  unlisteners.push(
    await listen<SessionClosedPayload>("ottr://session-closed", (e) => {
      void onSessionClosed(e.payload);
    }),
  );
  unlisteners.push(
    await listen<HostKeyChangedPayload>("ottr://host-key-changed", (e) => {
      void onHostKeyChanged(e.payload);
    }),
  );
  await useNotifyStore.getState().bootstrap();
}

/** 卸载监听（测试/热重载清理用）。 */
export function disposeNotifyEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}

// ---------------------------------------------------------------------------
// store（通知中心数据态 + 静音配置；UI 与管线共用）
// ---------------------------------------------------------------------------

/** vault settings 键：静音的 kind 数组（JSON）。 */
export const MUTED_SETTING_KEY = "notify.muted_kinds";

interface NotifyStore {
  items: Notification[];
  unread: number;
  /** 静音的 kind 集（管线入口判定 + 中心 UI 开关）。 */
  muted: NotifyKind[];
  /** 初始：静音配置 + 列表 + 未读数（失败静默——通知面不可用不阻塞应用）。 */
  bootstrap: () => Promise<void>;
  /** ①落库回执进 store（notify() 调用；置顶 + 未读+1）。 */
  onInserted: (row: Notification) => void;
  /** 面板打开时刷新（多端一致性兜底）。 */
  refresh: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;
  /** 切换 kind 静音（先改本地再落 settings——UI 即时反馈，写失败下次再试）。 */
  toggleMuted: (kind: NotifyKind) => void;
}

export const useNotifyStore = create<NotifyStore>((set, get) => ({
  items: [],
  unread: 0,
  muted: [],

  bootstrap: async () => {
    try {
      const stored = await vaultApi.settings.get<NotifyKind[]>(MUTED_SETTING_KEY);
      set({ muted: Array.isArray(stored) ? stored : [] });
    } catch {
      // settings 不可达：保持默认（全不静音）
    }
    await get().refresh();
  },

  onInserted: (row) =>
    set((st) => ({
      items: [row, ...st.items].slice(0, 200),
      unread: st.unread + 1,
    })),

  refresh: async () => {
    try {
      const [items, unread] = await Promise.all([
        vaultApi.notifications.list(200),
        vaultApi.notifications.unreadCount(),
      ]);
      set({ items, unread });
    } catch {
      // 后端不可达：保留现状（红点由下次 bootstrap 校正）
    }
  },

  markRead: async (id) => {
    set((st) => {
      const wasUnread = st.items.some((n) => n.id === id && !n.read);
      return {
        items: st.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
        unread: wasUnread ? st.unread - 1 : st.unread,
      };
    });
    try {
      await vaultApi.notifications.markRead(id);
    } catch {
      // 落库失败：本地已读态保留（下次 refresh 对齐真源）
    }
  },

  markAllRead: async () => {
    set((st) => ({
      items: st.items.map((n) => ({ ...n, read: true })),
      unread: 0,
    }));
    try {
      await vaultApi.notifications.markRead(null);
    } catch {
      // 同上
    }
  },

  clear: async () => {
    set({ items: [], unread: 0 });
    try {
      await vaultApi.notifications.clear();
    } catch {
      // 同上
    }
  },

  toggleMuted: (kind) => {
    const muted = get().muted.includes(kind)
      ? get().muted.filter((k) => k !== kind)
      : [...get().muted, kind];
    set({ muted });
    void vaultApi.settings.set(MUTED_SETTING_KEY, muted).catch(() => {
      // settings 写失败：会话内静音态仍生效，持久化下次切换时重试
    });
  },
}))
