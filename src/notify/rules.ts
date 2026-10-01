// 告警规则引擎（Phase 3 Task 3，B5）——评估在 TS（裁定 #1：数据源是前端
// 监控事件流 ottr://monitor 与进程采集 monitor_ps，notify-core 同域；Rust 只
// 做 alert_rules CRUD 与 mark_fired 水位）。
//
// * 三类规则（MVP 裁定 #1：日志关键字类延后——tail 会话管理复杂度，见
//   task-3 报告）：
//   - disk：磁盘使用率 > threshold（%）——边沿触发（fired 锁存，低于阈值
//     复位再武装；持续超阈不重复告警，恢复后再次越阈才再告）；
//   - cpu：CPU% > threshold 连续 N 采样（consecutive 计数，复位=跌回阈下；
//     到 N 告一次并锁存，防每采样重复告）；
//   - process：进程消失——每轮 ps 采集快照 diff：上一轮在册、本轮缺席 →
//     告一次（fired 锁存，进程回归即复位再武装）。
// * 防风暴（清偿 Phase 1 M-1）：管线级计数聚合（core.ts 60s 窗口合并 +
//   payload.suppressed 计数）+ 规则级边沿锁存 + 规则级 rate_limit（秒，
//   last_fired 水位持久化——重启不重放）+ mute_window 静音窗（本地时区，
//   可跨午夜）。
// * 渠道路由：fire 的 payload 带 channel_ids（规则订阅面），core.ts ③分发
//   按 channel.subscribed 过滤（channelRegistry 挂载的适配器实现）。
// * 可测性：状态机 tick_* 纯函数（输入采样/快照，输出 fire/rearm/null）+
//   EngineDeps 注入（时钟/notify/ps 采集/vault 回写）——单测零 Tauri 面。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "../i18n";
import { vaultApi, type AlertRule } from "../vault/api";
import type { MonitorMetrics } from "../monitor/monitorStore";
import { fetchProcesses } from "../monitor/api";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import { notify, type NotificationEvent } from "./core";

// ---------------------------------------------------------------------------
// 纯状态机（TDD 面）：tick 输入新采样，输出动作
// ---------------------------------------------------------------------------

/** 单规则的评估状态（进程内瞬态；last_fired 持久化在 DB）。 */
export interface RuleEvalState {
  /** 边沿锁存：已告警待复位（disk/process）；cpu 到 N 告后锁存。 */
  fired: boolean;
  /** cpu：连续超阈采样计数。 */
  consecutive: number;
  /** process：上一轮快照该进程是否在册（null = 首轮，只武装不评估）。 */
  prevPresent: boolean | null;
}

export function emptyEvalState(): RuleEvalState {
  return { fired: false, consecutive: 0, prevPresent: null };
}

export type RuleAction = "fire" | "rearm" | null;

/** disk 规则：value > threshold 且未锁存 → fire（锁存）；value < threshold →
 * 复位再武装（rearm 仅诊断面，无通知）。等值不触发（严格大于）。 */
export function tickDisk(
  state: RuleEvalState,
  params: Record<string, unknown>,
  usedPercent: number,
): RuleAction {
  const threshold = Number(params["threshold"] ?? 0);
  if (usedPercent > threshold) {
    if (!state.fired) {
      state.fired = true;
      return "fire";
    }
  } else if (state.fired) {
    state.fired = false;
    return "rearm";
  }
  return null;
}

/** cpu 规则：连续 consecutive 个采样 > threshold → fire 一次（锁存，跌回
 * 阈下复位并清零计数）。consecutive 非法（<1）按 1 处理。 */
export function tickCpu(
  state: RuleEvalState,
  params: Record<string, unknown>,
  cpuPercent: number,
): RuleAction {
  const threshold = Number(params["threshold"] ?? 0);
  const need = Math.max(1, Math.floor(Number(params["consecutive"] ?? 1)));
  if (cpuPercent > threshold) {
    if (state.fired) return null; // 锁存中：不再重复告
    state.consecutive += 1;
    if (state.consecutive >= need) {
      state.fired = true;
      return "fire";
    }
  } else {
    state.consecutive = 0;
    if (state.fired) {
      state.fired = false;
      return "rearm";
    }
  }
  return null;
}

/** process 规则：上一轮在册（prevPresent=true）且本轮缺席 → fire（锁存）；
 * 本轮在册 → 复位。首轮（prevPresent=null）只武装。 */
export function tickProcess(state: RuleEvalState, present: boolean): RuleAction {
  const prev = state.prevPresent;
  state.prevPresent = present;
  if (prev === null) return null; // 首轮武装
  if (prev && !present) {
    if (!state.fired) {
      state.fired = true;
      return "fire";
    }
    return null; // 锁存中（缺席持续不重复告）
  }
  if (present && state.fired) {
    state.fired = false; // 进程回归：复位再武装
    return "rearm";
  }
  return null;
}

/** 静音窗判定："HH:MM-HH:MM"（本地时区，可跨午夜；start==end = 恒静音）。 */
export function muteWindowContains(window: string, date: Date): boolean {
  const [start, end] = window.split("-");
  const toMin = (s: string): number => {
    const [h, m] = s.split(":");
    return Number(h) * 60 + Number(m);
  };
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const a = toMin(start);
  const b = toMin(end);
  return a <= b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b;
}

// ---------------------------------------------------------------------------
// 事件构造（fire 面）：i18n 文案 + payload（渠道路由/模板变量/M-1 计数挂点）
// ---------------------------------------------------------------------------

/** alert 事件 payload（channelRegistry 的 subscribed 与 webhook 模板变量消费）。 */
export interface AlertPayload {
  rule_id: number;
  rule_kind: AlertRule["kind"];
  /** 人类可读规则名（{{rule}} 模板变量；i18n 组装）。 */
  rule_label: string;
  host_name: string;
  /** 触发值（已格式化："92.4%" / "98% × 5 采样" / "nginx"）。 */
  value: string;
  channel_ids: number[];
}

/** 规则标签（i18n：disk → 「磁盘(/)」形态；webhook {{rule}} 与通知中心副标题）。 */
export function ruleLabel(rule: AlertRule): string {
  const p = rule.params as Record<string, unknown>;
  switch (rule.kind) {
    case "disk":
      return i18n.t("alert.label.disk", { mount: String(p["mount"] ?? "/") });
    case "cpu":
      return i18n.t("alert.label.cpu", {
        threshold: String(p["threshold"] ?? "?"),
        consecutive: String(p["consecutive"] ?? 1),
      });
    case "process":
      return i18n.t("alert.label.process", { comm: String(p["comm"] ?? "?") });
    default:
      return i18n.t(`alert.kind.${rule.kind}`);
  }
}

/** fire → NotificationEvent（title_key 按 kind 入词典；body 走 i18n 插值）。 */
export function alertEventOf(
  rule: AlertRule,
  hostName: string,
  value: string,
): NotificationEvent {
  const p = rule.params as Record<string, unknown>;
  const payload: AlertPayload = {
    rule_id: rule.id,
    rule_kind: rule.kind,
    rule_label: ruleLabel(rule),
    host_name: hostName,
    value,
    channel_ids: rule.channels,
  };
  const bodyVars: Record<string, string> = {
    host: hostName,
    rule: payload.rule_label,
    value,
    threshold: String(p["threshold"] ?? ""),
    mount: String(p["mount"] ?? "/"),
    comm: String(p["comm"] ?? ""),
  };
  return {
    kind: "alert",
    severity: "warning",
    host_id: rule.host_id,
    title_key: `alert.title.${rule.kind}`,
    body: i18n.t(`alert.body.${rule.kind}`, bodyVars),
    payload: payload as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// 引擎（接线面）：订阅 ottr://monitor + 进程轮询 + notify 管线对接
// ---------------------------------------------------------------------------

/** 进程快照轮询间隔（毫秒；ps 采集是独立轻量 exec，与监控采样间隔解耦）。 */
export const PROCESS_POLL_MS = 60_000;

/** 引擎端口（生产 = Tauri/stores/vaultApi；测试注入假件）。 */
export interface EngineDeps {
  now: () => number;
  notify: (event: NotificationEvent) => Promise<boolean>;
  /** 触发水位回写（fire 后调用；失败只记 console——水位丢 = 极端场景重启后
   * 可能重告一次，无害侧）。 */
  touchFired: (id: number, ts: number) => Promise<void>;
  /** 进程快照采集（comm 集合）。 */
  fetchProcesses: (rustId: string) => Promise<{ comm: string }[]>;
  /** rustId → 根会话主机（hostId/hostName）；找不到 = 迟到事件静默。 */
  hostByRustId: (rustId: string) => { hostId: number; hostName: string } | null;
  /** hostId → 根会话（进程轮询取数面）；未连接/主机已删 = null 静默。 */
  sessionByHost: (hostId: number) => { rustId: string; hostName: string } | null;
}

/** 根会话解析（stores 生产实现；T1 裁定采样/取数只挂标签根会话）。 */
function rootSessionOf(
  pred: (s: { rustId: string | null; paneOf: string | null; hostId: number }) => boolean,
): { rustId: string; hostName: string; hostId: number } | null {
  const s = useSessionStore.getState().sessions.find(pred);
  if (!s || s.rustId === null) return null;
  const host = useVaultStore.getState().hosts.find((h) => h.id === s.hostId);
  return { rustId: s.rustId, hostName: host?.name ?? s.hostName, hostId: s.hostId };
}

export const defaultDeps: EngineDeps = {
  now: () => Date.now(),
  notify,
  touchFired: (id, ts) => vaultApi.alertRules.touchFired(id, ts),
  fetchProcesses: async (rustId) => await fetchProcesses(rustId),
  hostByRustId: (rustId) => {
    // 事件 id 必中根会话的 rustId；pane 与根同主机但另有 rustId，不在此反查面。
    const s = rootSessionOf((it) => it.rustId === rustId && it.paneOf === null);
    return s ? { hostId: s.hostId, hostName: s.hostName } : null;
  },
  sessionByHost: (hostId) => {
    const s = rootSessionOf(
      (it) => it.hostId === hostId && it.paneOf === null && it.rustId !== null,
    );
    return s ? { rustId: s.rustId, hostName: s.hostName } : null;
  },
};

let deps: EngineDeps = defaultDeps;

/** 测试注入假端口（null 复位默认）。 */
export function setAlertEngineDeps(next: EngineDeps | null): void {
  deps = next ?? defaultDeps;
}

export class AlertEngine {
  private rules: AlertRule[] = [];
  private states = new Map<number, RuleEvalState>();
  /** 防火墙：last_fired 的内存镜像（reload 后从 DB 行同步）。 */
  private lastFired = new Map<number, number>();
  private polling = false;

  /** 装载规则（设置页保存后调用；失败保留现役——评估不因设置页读失败中断）。 */
  async reload(): Promise<void> {
    try {
      this.rules = await vaultApi.alertRules.list();
      this.states.clear();
      this.lastFired.clear();
      for (const r of this.rules) {
        if (r.last_fired !== null) this.lastFired.set(r.id, r.last_fired);
      }
    } catch (e) {
      console.warn("[alerts] reload rules failed:", e);
    }
  }

  rulesOf(hostId: number, kind: AlertRule["kind"]): AlertRule[] {
    return this.rules.filter((r) => r.host_id === hostId && r.kind === kind);
  }

  /** ottr://monitor 采样入口（events 接线调用）：只吃 sample 帧的指标面。 */
  async onMonitorSample(rustId: string, metrics: MonitorMetrics): Promise<void> {
    const host = deps.hostByRustId(rustId);
    if (!host) return;
    // disk：逐挂载点规则取该挂载点使用率（mount 缺省 "/"）；无该挂载点跳过
    for (const rule of this.rulesOf(host.hostId, "disk")) {
      const mount = String((rule.params as Record<string, unknown>)["mount"] ?? "/");
      const disk = metrics.disk.find((d) => d.mount === mount);
      if (!disk) continue;
      const action = tickDisk(this.stateOf(rule), rule.params as Record<string, unknown>, disk.used_percent);
      await this.applyAction(rule, host.hostName, action, `${disk.used_percent.toFixed(1)}%`);
    }
    // cpu：持续窗口
    for (const rule of this.rulesOf(host.hostId, "cpu")) {
      const action = tickCpu(this.stateOf(rule), rule.params as Record<string, unknown>, metrics.cpu_percent);
      const need = Math.max(1, Math.floor(Number((rule.params as Record<string, unknown>)["consecutive"] ?? 1)));
      await this.applyAction(
        rule,
        host.hostName,
        action,
        i18n.t("alert.value.cpuSamples", { value: Math.round(metrics.cpu_percent), count: need }),
      );
    }
  }

  /** 进程快照轮询（有 process 规则的主机才发采集；按主机去重共享一次 ps）。 */
  async pollProcesses(): Promise<void> {
    if (this.polling) return; // 上一轮未收口跳过（不叠发 exec）
    this.polling = true;
    try {
      const byHost = new Map<number, AlertRule[]>();
      for (const rule of this.rules) {
        if (rule.kind !== "process") continue;
        const list = byHost.get(rule.host_id) ?? [];
        list.push(rule);
        byHost.set(rule.host_id, list);
      }
      for (const [hostId, rules] of byHost) {
        const session = deps.sessionByHost(hostId);
        if (!session) continue; // 主机未连接：规则静默等下一轮（不误报消失）
        let comms: Set<string>;
        try {
          comms = new Set((await deps.fetchProcesses(session.rustId)).map((p) => p.comm));
        } catch (e) {
          console.warn(`[alerts] ps fetch failed for host ${hostId}:`, e);
          continue; // 采集失败不动快照态（会话断开期间不误报进程消失）
        }
        for (const rule of rules) {
          const comm = String((rule.params as Record<string, unknown>)["comm"] ?? "");
          const action = tickProcess(this.stateOf(rule), comms.has(comm));
          await this.applyAction(rule, session.hostName, action, comm);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /** 告警放行面：静音窗 → 规则级 rate_limit（last_fired 水位）→ notify →
   * 回写水位。fire 后无论管线是否放行都落水位（管线聚合是第二道防线的
   * 语义：本规则至少尝试过一次）。公开（非 private）供单测直驱 fire 判定
   * ——限频/静音窗/水位回写的 TDD 面与 tick_* 同级。 */
  async applyAction(
    rule: AlertRule,
    hostName: string,
    action: RuleAction,
    value: string,
  ): Promise<void> {
    if (action === "rearm" || action === null) return;
    const nowMs = deps.now();
    if (
      rule.mute_window &&
      muteWindowContains(rule.mute_window, new Date(nowMs))
    ) {
      // 静音窗内抑制；状态机锁存已在 tick 侧置位——出窗后不补发（静音即
      // 「窗内不打扰」；恢复越阈的下一轮边沿仍会正常告）
      return;
    }
    const nowSec = Math.floor(nowMs / 1000);
    const last = this.lastFired.get(rule.id);
    if (rule.rate_limit > 0 && last !== undefined && nowSec - last < rule.rate_limit) {
      return; // 规则级限频（管线 60s 之外的第二档）
    }
    this.lastFired.set(rule.id, nowSec);
    try {
      await deps.notify(alertEventOf(rule, hostName, value));
    } catch (e) {
      console.warn("[alerts] notify failed:", e);
    }
    try {
      await deps.touchFired(rule.id, nowSec);
    } catch (e) {
      console.warn("[alerts] touch fired failed:", e);
    }
  }

  private stateOf(rule: AlertRule): RuleEvalState {
    let st = this.states.get(rule.id);
    if (!st) {
      st = emptyEvalState();
      this.states.set(rule.id, st);
    }
    return st;
  }
}

// ---------------------------------------------------------------------------
// 接线（App 挂载链调用一次；幂等）
// ---------------------------------------------------------------------------

export const engine = new AlertEngine();

let wired = false;
let unlisten: UnlistenFn | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 注册监控事件监听 + 装载规则 + 启动进程轮询（幂等；StrictMode 双挂载只接一次）。 */
export async function initAlertEngine(): Promise<void> {
  if (wired) return;
  wired = true;
  await engine.reload();
  unlisten = await listen<{ id: string; status: string; metrics: MonitorMetrics | null }>(
    "ottr://monitor",
    (e) => {
      if (e.payload.status === "sample" && e.payload.metrics) {
        void engine.onMonitorSample(e.payload.id, e.payload.metrics);
      }
    },
  );
  pollTimer = setInterval(() => void engine.pollProcesses(), PROCESS_POLL_MS);
}

/** 卸载监听与轮询（测试/热重载清理用）。 */
export function disposeAlertEngine(): void {
  if (unlisten) unlisten();
  unlisten = null;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  wired = false;
}
