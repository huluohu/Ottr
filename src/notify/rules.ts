// 告警规则引擎（Phase 3 Task 3，B5；Phase 4 Task 2 补 log 类——缺口②清偿）：
// 评估在 TS（裁定 #1：数据源是前端监控事件流 ottr://monitor 与进程采集
// monitor_ps、日志采样 monitor_log_tail，notify-core 同域；Rust 只做
// alert_rules CRUD 与 mark_fired 水位）。
//
// * 四类规则：
//   - disk：磁盘使用率 > threshold（%）——边沿触发（fired 锁存，低于阈值
//     复位再武装；持续超阈不重复告警，恢复后再次越阈才再告）；
//   - cpu：CPU% > threshold 连续 N 采样（consecutive 计数，复位=跌回阈下；
//     到 N 告一次并锁存，防每采样重复告）；
//   - process：进程消失——每轮 ps 采集快照 diff：上一轮在册、本轮缺席 →
//     告一次（fired 锁存，进程回归即复位再武装）；
//   - log：日志关键字（正则）——定期 tail 轮询（裁定：不复刻 tail -f 长驻
//     流，与会话生命周期解耦；字节级游标续读防重复告，轮转/截断语义见
//     advanceLogCursor）。多行样本逐行匹配，命中即告（fired 锁存——连续
//     错误只告一次，「安静一轮」复位再武装；限频沿管线聚合）。
// * 防风暴（清偿 Phase 1 M-1）：管线级计数聚合（core.ts 60s 窗口合并 +
//   payload.suppressed 计数）+ 规则级边沿锁存 + 规则级 rate_limit（秒，
//   last_fired 水位持久化——重启不重放）+ mute_window 静音窗（本地时区，
//   可跨午夜）。
// * 渠道路由：fire 的 payload 带 channel_ids（规则订阅面），core.ts ③分发
//   按 channel.subscribed 过滤（channelRegistry 挂载的适配器实现）。
// * 可测性：状态机 tick_* 纯函数（输入采样/快照，输出 fire/rearm/null）+
//   EngineDeps 注入（时钟/notify/ps 采集/log 采样/vault 回写）——单测零 Tauri 面。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "../i18n";
import { vaultApi, type AlertRule } from "../vault/api";
import type { MonitorMetrics } from "../monitor/monitorStore";
import { fetchProcesses, fetchLogTail, type LogTailSample } from "../monitor/api";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import { notify, type NotificationEvent } from "./core";

// ---------------------------------------------------------------------------
// 纯状态机（TDD 面）：tick 输入新采样，输出动作
// ---------------------------------------------------------------------------

/** 单规则的评估状态（进程内瞬态；last_fired 持久化在 DB）。 */
export interface RuleEvalState {
  /** 边沿锁存：已告警待复位（disk/process/log）；cpu 到 N 告后锁存。 */
  fired: boolean;
  /** cpu：连续超阈采样计数。 */
  consecutive: number;
  /** process：上一轮快照该进程是否在册（null = 首轮，只武装不评估）。 */
  prevPresent: boolean | null;
  /** log：字节级读取游标（null = 未武装——下一轮只 stat 记水位不匹配）。 */
  logCursor: LogCursor | null;
}

export function emptyEvalState(): RuleEvalState {
  return { fired: false, consecutive: 0, prevPresent: null, logCursor: null };
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

// ---------------------------------------------------------------------------
// log 规则（Phase 4 Task 2，缺口②）：字节游标推进 + 关键字匹配
// ---------------------------------------------------------------------------

/** 日志读取游标（字节级；inode 参与轮转判定）。 */
export interface LogCursor {
  inode: number | null;
  /** 已消费到的字节偏移（下轮 `tail -c +offset+1`；0 = 从头）。 */
  offset: number;
}

/** 游标推进结果：新游标 + 本轮完整行（错位/不可判轮 = 空行集）。 */
export interface LogAdvance {
  cursor: LogCursor | null;
  lines: string[];
}

/** 游标推进（纯函数；轮转/截断语义在此钉死）：
 * * 未武装（cursor=null）：只记水位（inode + 文件尾偏移），不匹配——
 *   武装轮不回放历史内容（重启/新建规则防旧账风暴）；文件不可判（inode
 *   null）维持未武装；
 * * 文件消失（sample.inode=null）：游标原地保留不消费（重现为旧 inode →
 *   走截断；新 inode → 走轮转）；
 * * 轮转（inode 变）：本轮数据是按旧偏移从新文件切出的错位碎片 → 丢弃，
 *   游标归零——下轮从新文件头起读（新建日志文件通常为空，正文零丢失）；
 * * 截断（同 inode 变小，copytruncate/手动 truncate）：本轮数据错位 →
 *   丢弃，游标归零——truncate 后的新正文下轮整段读入；
 * * 正常续读：消费本轮完整行（残缺尾行 Rust 侧已截在 data 外，字节账
 *   data_bytes 只入完整行），offset 前推。 */
export function advanceLogCursor(
  cursor: LogCursor | null,
  sample: Pick<LogTailSample, "inode" | "size" | "data" | "data_bytes">,
): LogAdvance {
  if (!cursor) {
    if (sample.inode === null) return { cursor: null, lines: [] };
    return { cursor: { inode: sample.inode, offset: sample.size }, lines: [] };
  }
  if (sample.inode === null) return { cursor, lines: [] };
  if (sample.inode !== cursor.inode) {
    return { cursor: { inode: sample.inode, offset: 0 }, lines: [] };
  }
  if (sample.size < cursor.offset) {
    return { cursor: { inode: cursor.inode, offset: 0 }, lines: [] };
  }
  if (sample.data_bytes <= 0 || sample.data === "") {
    return { cursor, lines: [] };
  }
  // data 以 "\n" 结尾（Rust 侧按最后 \n 截断）：split 尾元素必为 ""
  const lines = sample.data.split("\n").slice(0, -1);
  return {
    cursor: { inode: cursor.inode, offset: cursor.offset + sample.data_bytes },
    lines,
  };
}

/** log 规则 tick：多行样本逐行匹配（正则，未锚定 = 子串语义）；命中 →
 * fire 一次锁存（持续命中不重复告）；安静样本（零命中）→ 复位再武装。
 * 非法正则静默跳过（UI 保存前校验挡第一道；DB 手改的坏值不炸引擎）。 */
export function tickLog(
  state: RuleEvalState,
  params: Record<string, unknown>,
  lines: string[],
): RuleAction {
  let re: RegExp;
  try {
    re = new RegExp(String(params["pattern"] ?? ""));
  } catch {
    return null;
  }
  const hit = lines.some((l) => re.test(l));
  if (hit) {
    if (!state.fired) {
      state.fired = true;
      return "fire";
    }
    return null; // 锁存中：连续错误不重复告
  }
  if (state.fired) {
    state.fired = false;
    return "rearm";
  }
  return null;
}

/** log 采样间隔（秒）：interval_secs 下限 5（轮询 tick 5s，低于 tick 无
 * 意义，越界收敛到下限）、缺省 10、非法值收敛缺省。 */
export function logIntervalSecs(params: Record<string, unknown>): number {
  const raw = Number(params["interval_secs"]);
  return Number.isFinite(raw) ? Math.max(5, Math.floor(raw)) : 10;
}

/** 命中行摘录（value 面）：trim 后截 160 字符（通知 body 单行可读）。 */
export function logLineExcerpt(line: string): string {
  const t = line.trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

/** 首个命中行（无命中/非法正则 = null；非法正则不抛——轮询面静默）。 */
export function firstMatch(pattern: string, lines: string[]): string | null {
  try {
    const re = new RegExp(pattern);
    return lines.find((l) => re.test(l)) ?? null;
  } catch {
    return null;
  }
}

/** 静音窗判定："HH:MM-HH:MM"（本地时区，可跨午夜；start==end = 空窗，恒不静音）。 */
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
    case "log":
      return i18n.t("alert.label.log", {
        path: String(p["path"] ?? "?"),
        pattern: String(p["pattern"] ?? "?"),
      });
    default:
      // 四类已全覆盖（default 仅类型兜底；i18n.t 的模板串键面在 kind 收敛
      // never 后不再是合法键，取固定键）
      return i18n.t("alert.kindLog");
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
    path: String(p["path"] ?? ""),
    pattern: String(p["pattern"] ?? ""),
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

/** 日志轮询 tick（毫秒）：每 tick 检查各 log 规则的 interval_secs 门槛
 * （缺省 10s、下限 5s——tick 之下无意义）。log 采样同 ps 一样是按需轻量
 * exec：一条 stat+tail 复合命令，无长驻通道。 */
export const LOG_POLL_MS = 5_000;

/** 引擎端口（生产 = Tauri/stores/vaultApi；测试注入假件）。 */
export interface EngineDeps {
  now: () => number;
  notify: (event: NotificationEvent) => Promise<boolean>;
  /** 触发水位回写（fire 后调用；失败只记 console——水位丢 = 极端场景重启后
   * 可能重告一次，无害侧）。 */
  touchFired: (id: number, ts: number) => Promise<void>;
  /** 进程快照采集（comm 集合）。 */
  fetchProcesses: (rustId: string) => Promise<{ comm: string }[]>;
  /** 日志尾部采样（offset=null 武装轮）；失败上抛由引擎按「不动游标」处置。 */
  fetchLogTail: (
    rustId: string,
    path: string,
    offset: number | null,
  ) => Promise<LogTailSample>;
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
  fetchLogTail: async (rustId, path, offset) => await fetchLogTail(rustId, path, offset),
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
  /** log 规则上次采样时刻（interval 门槛内存面；reload 清零即全部立即采样）。 */
  private lastPolled = new Map<number, number>();
  private polling = false;
  private logPolling = false;

  /** 装载规则（设置页保存后调用；失败保留现役——评估不因设置页读失败中断）。 */
  async reload(): Promise<void> {
    try {
      this.rules = await vaultApi.alertRules.list();
      this.states.clear();
      this.lastFired.clear();
      this.lastPolled.clear();
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

  /** 日志关键字轮询（Phase 4 T2）：按主机分桶（会话未连接 = 静默，游标
   * 不动——同 process「断连不误报」纪律）；逐规则 interval 门槛 + 独立
   * in-flight 互斥（不叠发）。采样失败（exec 断/路径不安全）= 不动游标
   * 不评估（会话断开期间不告不漏——恢复后从原游标续读）。 */
  async pollLogs(): Promise<void> {
    if (this.logPolling) return;
    this.logPolling = true;
    try {
      const nowMs = deps.now();
      const byHost = new Map<number, AlertRule[]>();
      for (const rule of this.rules) {
        if (rule.kind !== "log") continue;
        const last = this.lastPolled.get(rule.id);
        if (last !== undefined && nowMs - last < logIntervalSecs(rule.params as Record<string, unknown>) * 1000) {
          continue; // interval 门槛未到
        }
        const list = byHost.get(rule.host_id) ?? [];
        list.push(rule);
        byHost.set(rule.host_id, list);
      }
      for (const [hostId, rules] of byHost) {
        const session = deps.sessionByHost(hostId);
        if (!session) continue; // 主机未连接：规则静默（不武装不消费）
        for (const rule of rules) {
          const p = rule.params as Record<string, unknown>;
          const path = String(p["path"] ?? "");
          const st = this.stateOf(rule);
          try {
            const sample = await deps.fetchLogTail(session.rustId, path, st.logCursor?.offset ?? null);
            const adv = advanceLogCursor(st.logCursor, sample);
            st.logCursor = adv.cursor;
            this.lastPolled.set(rule.id, nowMs);
            const action = tickLog(st, p, adv.lines);
            await this.applyAction(
              rule,
              session.hostName,
              action,
              firstMatch(String(p["pattern"] ?? ""), adv.lines) ?? "",
            );
          } catch (e) {
            console.warn(`[alerts] log tail failed for rule ${rule.id} (${path}):`, e);
            // 采集失败：游标/采样时刻都不动——下轮从原位续读，不漏不重
          }
        }
      }
    } finally {
      this.logPolling = false;
    }
  }

  /** 告警放行面：静音窗 → 规则级 rate_limit（last_fired 水位）→ notify →
   * **放行才回写水位**。【I-1（fix round 1）】水位乐观写入 + 未放行回滚：
   * 写在前 = notify 在途时挡住同规则并发重入（风暴守卫）；管线返回 false
   * （被 60s 窗口聚合 / kind 静音）= 本次告警未真正送达——不推进 last_fired
   * 也不 touchFired，规则级 rate_limit 不被聚合吞掉的告警挤后，出窗后自然
   * 重放。公开（非 private）供单测直驱 fire 判定——限频/静音窗/水位回写的
   * TDD 面与 tick_* 同级。 */
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
    const prevWatermark = last;
    this.lastFired.set(rule.id, nowSec); // 乐观写（挡 notify 在途重入）
    let released: boolean;
    try {
      released = await deps.notify(alertEventOf(rule, hostName, value));
    } catch (e) {
      console.warn("[alerts] notify failed:", e);
      released = true; // notify 契约 = 尽力而为不抛；假件异常按已投递计（水位照推进）
    }
    if (!released) {
      // 被聚合/静音吞掉：回滚水位——不回写 DB，出窗后重放不丢
      if (prevWatermark === undefined) this.lastFired.delete(rule.id);
      else this.lastFired.set(rule.id, prevWatermark);
      return;
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
let logTimer: ReturnType<typeof setInterval> | null = null;

/** 注册监控事件监听 + 装载规则 + 启动进程/日志轮询（幂等；StrictMode 双挂载只接一次）。 */
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
  logTimer = setInterval(() => void engine.pollLogs(), LOG_POLL_MS);
}

/** 卸载监听与轮询（测试/热重载清理用）。 */
export function disposeAlertEngine(): void {
  if (unlisten) unlisten();
  unlisten = null;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  if (logTimer !== null) clearInterval(logTimer);
  logTimer = null;
  wired = false;
}
