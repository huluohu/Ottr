// 告警规则引擎单测（Phase 3 Task 3，B5）：纯状态机 tick（disk 边沿/锁存、
// cpu 持续窗口、process 快照 diff）、静音窗判定（含跨午夜）、fire 面
// （payload/文案/水位回写/规则级限频）、接线（ottr://monitor 采样入口 +
// 进程轮询按主机去重 + 采集失败不动快照）。i18n 用真实词典（en-US fallback）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  AlertEngine,
  alertEventOf,
  emptyEvalState,
  muteWindowContains,
  PROCESS_POLL_MS,
  ruleLabel,
  setAlertEngineDeps,
  tickCpu,
  tickDisk,
  tickProcess,
  type EngineDeps,
} from "./rules";
import type { AlertRule } from "../vault/api";
import type { MonitorMetrics } from "../monitor/monitorStore";
import type { NotificationEvent } from "./core";
import { disposeAlertEngine } from "./rules";

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 1,
    host_id: 7,
    kind: "disk",
    params: { mount: "/", threshold: 90 },
    channels: [3],
    rate_limit: 0,
    mute_window: null,
    last_fired: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("纯状态机", () => {
  it("disk：越阈 fire 一次锁存，持续超阈不重复，跌回阈下复位再武装", () => {
    const st = emptyEvalState();
    expect(tickDisk(st, { threshold: 90 }, 89.9)).toBeNull();
    expect(tickDisk(st, { threshold: 90 }, 90)).toBeNull(); // 严格大于
    expect(tickDisk(st, { threshold: 90 }, 90.1)).toBe("fire");
    expect(tickDisk(st, { threshold: 90 }, 95)).toBeNull(); // 锁存：不重复
    expect(tickDisk(st, { threshold: 90 }, 50)).toBe("rearm");
    expect(tickDisk(st, { threshold: 90 }, 91)).toBe("fire"); // 复位后再告
  });

  it("cpu：连续 N 采样越阈才 fire，中途跌落清零，fire 后锁存到复位", () => {
    const st = emptyEvalState();
    const params = { threshold: 80, consecutive: 3 };
    expect(tickCpu(st, params, 90)).toBeNull(); // 1/3
    expect(tickCpu(st, params, 95)).toBeNull(); // 2/3
    expect(tickCpu(st, params, 50)).toBeNull(); // 跌落清零
    expect(st.consecutive).toBe(0);
    expect(tickCpu(st, params, 91)).toBeNull();
    expect(tickCpu(st, params, 92)).toBeNull();
    expect(tickCpu(st, params, 93)).toBe("fire"); // 3/3
    expect(tickCpu(st, params, 99)).toBeNull(); // 锁存
    expect(tickCpu(st, params, 10)).toBe("rearm"); // 复位
    expect(tickCpu(st, params, 99)).toBeNull();
    expect(tickCpu(st, params, 99)).toBeNull();
    expect(tickCpu(st, params, 99)).toBe("fire");
  });

  it("cpu：consecutive<1 按 1 处理（立即告）；params 缺字段按 0 阈值", () => {
    const st = emptyEvalState();
    expect(tickCpu(st, { threshold: 80, consecutive: 0 }, 90)).toBe("fire");
    const st2 = emptyEvalState();
    expect(tickCpu(st2, {}, 0)).toBeNull(); // threshold 缺省 0：0 不严格大于
    expect(tickCpu(st2, {}, 0.5)).toBe("fire"); // >0 即越阈（缺字段 = 最敏感）
  });

  it("process：首轮武装不发；在册→缺席 fire 一次；缺席持续不重复；回归复位", () => {
    const st = emptyEvalState();
    expect(tickProcess(st, true)).toBeNull(); // 首轮武装
    expect(tickProcess(st, true)).toBeNull();
    expect(tickProcess(st, false)).toBe("fire"); // 消失
    expect(tickProcess(st, false)).toBeNull(); // 缺席持续：锁存
    expect(tickProcess(st, true)).toBe("rearm"); // 回归复位
    expect(tickProcess(st, false)).toBe("fire"); // 再消失再告
  });

  it("静音窗：窗内命中、窗外不命中、跨午夜（22:00-08:00）双向", () => {
    expect(muteWindowContains("22:00-08:00", new Date(2026, 8, 29, 23, 30))).toBe(true);
    expect(muteWindowContains("22:00-08:00", new Date(2026, 8, 29, 7, 59))).toBe(true);
    expect(muteWindowContains("22:00-08:00", new Date(2026, 8, 29, 12, 0))).toBe(false);
    expect(muteWindowContains("09:00-18:00", new Date(2026, 8, 29, 10, 0))).toBe(true);
    expect(muteWindowContains("09:00-18:00", new Date(2026, 8, 29, 18, 0))).toBe(false); // 右开
    expect(muteWindowContains("09:00-18:00", new Date(2026, 8, 29, 8, 59))).toBe(false);
  });
});

describe("fire 面", () => {
  it("alertEventOf：payload 带渠道路由/模板变量，body 走 i18n 插值", () => {
    const e = alertEventOf(
      rule({ kind: "disk", params: { mount: "/data", threshold: 85 } }),
      "web-01",
      "91.0%",
    );
    expect(e.kind).toBe("alert");
    expect(e.severity).toBe("warning");
    expect(e.host_id).toBe(7);
    expect(e.title_key).toBe("alert.title.disk");
    expect(e.body).toBe("web-01 disk /data at 91.0% (threshold 85%)");
    expect(e.payload).toMatchObject({
      rule_id: 1,
      rule_kind: "disk",
      host_name: "web-01",
      value: "91.0%",
      channel_ids: [3],
    });
    expect((e.payload as Record<string, unknown>)["rule_label"]).toBe("Disk /data");
  });

  it("ruleLabel 三类文案（en-US 词典面）", () => {
    expect(ruleLabel(rule({ kind: "disk", params: { mount: "/", threshold: 90 } }))).toBe("Disk /");
    expect(
      ruleLabel(rule({ kind: "cpu", params: { threshold: 85, consecutive: 3 } })),
    ).toBe("CPU>85% x 3");
    expect(ruleLabel(rule({ kind: "process", params: { comm: "nginx" } }))).toBe("Process nginx");
  });

  it("applyAction：rate_limit 内不重发；fire 后回写 last_fired 水位", async () => {
    const engine = new AlertEngine();
    const notified: unknown[] = [];
    const deps: EngineDeps = {
      now: () => 1_700_000_000_000,
      notify: async (e) => {
        notified.push(e);
        return true;
      },
      touchFired: vi.fn(async () => {}),
      fetchProcesses: async () => [],
      hostByRustId: () => null,
      sessionByHost: () => null,
    };
    setAlertEngineDeps(deps);
    // 内存水位 100s 前；rate_limit=300 → 拒发
    (engine as unknown as { lastFired: Map<number, number> }).lastFired.set(1, 1_699_999_900);
    await engine.applyAction(rule({ rate_limit: 300 }), "web-01", "fire", "91%");
    expect(notified).toHaveLength(0);

    // rate_limit=0 → 放行 + 回写
    await engine.applyAction(rule({ rate_limit: 0 }), "web-01", "fire", "91%");
    expect(notified).toHaveLength(1);
    expect(deps.touchFired).toHaveBeenCalledWith(1, 1_700_000_000);
  });

  it("applyAction：静音窗内抑制（不通知不回写）", async () => {
    const engine = new AlertEngine();
    const notified: unknown[] = [];
    // 2026-09-29T23:30:00Z 本地时区不可控——直接构造命中的 Date：用 now 驱动
    const fixed = new Date(2026, 8, 29, 23, 30).getTime();
    const deps: EngineDeps = {
      now: () => fixed,
      notify: async (e) => {
        notified.push(e);
        return true;
      },
      touchFired: vi.fn(async () => {}),
      fetchProcesses: async () => [],
      hostByRustId: () => null,
      sessionByHost: () => null,
    };
    setAlertEngineDeps(deps);
    await engine.applyAction(rule({ mute_window: "22:00-08:00" }), "web-01", "fire", "91%");
    expect(notified).toHaveLength(0);
    expect(deps.touchFired).not.toHaveBeenCalled();
  });
});

describe("接线面", () => {
  function metrics(over: Partial<MonitorMetrics> = {}): MonitorMetrics {
    return {
      cpu_percent: 10,
      mem_used_percent: 10,
      mem_total_kb: 1,
      mem_used_kb: 1,
      load_one: 0,
      load_five: 0,
      load_fifteen: 0,
      net_rx_bps: 0,
      net_tx_bps: 0,
      disk: [{ filesystem: "/dev/sda1", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: 50, mount: "/" }],
      ...over,
    };
  }

  function engineDeps(): { deps: EngineDeps; notified: unknown[]; touch: Mock } {
    const notified: unknown[] = [];
    const touch = vi.fn(async () => {});
    const deps: EngineDeps = {
      now: () => 1_700_000_000_000,
      notify: async (e) => {
        notified.push(e);
        return true;
      },
      touchFired: touch,
      fetchProcesses: async () => [{ comm: "nginx" }],
      hostByRustId: (rustId) =>
        rustId === "pty-1" ? { hostId: 7, hostName: "web-01" } : null,
      sessionByHost: (hostId) =>
        hostId === 7 ? { rustId: "pty-1", hostName: "web-01" } : null,
    };
    setAlertEngineDeps(deps);
    return { deps, notified, touch };
  }

  beforeEach(() => {
    setAlertEngineDeps(null);
    disposeAlertEngine();
  });

  it("onMonitorSample：未知 rustId 静默；disk 越阈 fire 一次", async () => {
    const { notified } = engineDeps();
    const engine = new AlertEngine();
    (engine as unknown as { rules: AlertRule[] }).rules = [rule()];
    await engine.onMonitorSample("pty-none", metrics({ disk: [{ filesystem: "x", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: 95, mount: "/" }] }));
    expect(notified).toHaveLength(0);

    const sample = metrics({ disk: [{ filesystem: "x", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: 95, mount: "/" }] });
    await engine.onMonitorSample("pty-1", sample);
    expect(notified).toHaveLength(1);
    expect((notified[0] as { payload: Record<string, unknown> }).payload["value"]).toBe("95.0%");

    await engine.onMonitorSample("pty-1", sample); // 锁存不重复
    expect(notified).toHaveLength(1);
  });

  it("onMonitorSample：mount 无该挂载点跳过；cpu 持续到 consecutive 才 fire", async () => {
    const { notified } = engineDeps();
    const engine = new AlertEngine();
    (engine as unknown as { rules: AlertRule[] }).rules = [
      rule({ id: 2, kind: "disk", params: { mount: "/data", threshold: 90 } }),
      rule({ id: 3, kind: "cpu", params: { threshold: 80, consecutive: 2 } }),
    ];
    await engine.onMonitorSample("pty-1", metrics({ cpu_percent: 90 }));
    expect(notified).toHaveLength(0); // disk 无 /data 挂载点；cpu 1/2
    await engine.onMonitorSample("pty-1", metrics({ cpu_percent: 90 }));
    expect(notified).toHaveLength(1);
    expect((notified[0] as { title_key: string }).title_key).toBe("alert.title.cpu");
  });

  it("pollProcesses：按主机去重一次 ps；进程消失 fire；采集失败不动快照", async () => {
    const { deps: baseDeps, notified } = engineDeps();
    const engine = new AlertEngine();
    (engine as unknown as { rules: AlertRule[] }).rules = [
      rule({ id: 4, kind: "process", params: { comm: "nginx" } }),
      rule({ id: 5, kind: "process", params: { comm: "sshd" } }),
    ];
    const psSpy = vi.fn(async () => [{ comm: "nginx" }, { comm: "sshd" }]);
    setAlertEngineDeps({ ...baseDeps, fetchProcesses: psSpy as unknown as EngineDeps["fetchProcesses"] });
    await engine.pollProcesses(); // 首轮武装
    expect(psSpy).toHaveBeenCalledTimes(1); // 两规则同主机共享一次 ps
    expect(notified).toHaveLength(0);

    psSpy.mockResolvedValue([{ comm: "sshd" }]); // nginx 消失
    await engine.pollProcesses();
    expect(notified).toHaveLength(1);
    expect((notified[0] as { payload: Record<string, unknown> }).payload["value"]).toBe("nginx");

    psSpy.mockRejectedValue(new Error("session down"));
    await engine.pollProcesses(); // 采集失败：不误报（nginx 缺席仍锁存，快照不动）
    expect(notified).toHaveLength(1);
  });
});

describe("M-1 聚合计数（管线级，core.ts 清偿挂账）", () => {
  it("窗口内丢弃计数，下条放行时 payload.suppressed 结算", async () => {
    const { notify, resetRateLimiter, RATE_WINDOW_MS, channels } = await import("./core");
    const seen: unknown[] = [];
    channels.push({ name: "m1fake", send: async (e) => void seen.push(e), test: async () => {} });
    const { setNotifyPorts } = await import("./core");
    const clock = { t: 2_000_000 };
    setNotifyPorts({ now: () => clock.t, focused: () => true, system: async () => {} });
    const inv = (await import("@tauri-apps/api/core")).invoke as unknown as Mock;
    inv.mockImplementation(async () => ({ id: 1 }));

    const ev = {
      kind: "session" as const,
      severity: "warning" as const,
      host_id: 5,
      title_key: "notify.title.sessionLost",
      body: "cache-01",
      payload: { reason: "closed" },
    };
    expect(await notify(ev)).toBe(true); // 放行开窗
    for (let i = 0; i < 3; i++) {
      clock.t += 1000;
      expect(await notify(ev)).toBe(false); // 窗口内聚合（计数 3）
    }
    clock.t += RATE_WINDOW_MS;
    expect(await notify(ev)).toBe(true); // 过期放行：结算
    const last = seen[seen.length - 1] as { payload?: Record<string, unknown> };
    expect(last.payload?.["suppressed"]).toBe(3);
    resetRateLimiter();
    channels.length = 0;
  });

  it("进程轮询间隔常量：60s（独立于监控采样间隔）", () => {
    expect(PROCESS_POLL_MS).toBe(60_000);
  });
});

describe("I-1（fix round 1）：聚合 key 细化含 rule_id + 水位只在放行后推进", () => {
  function alertEvent(ruleId: number, hostId = 7) {
    return {
      kind: "alert" as const,
      severity: "warning" as const,
      host_id: hostId,
      title_key: "alert.title.disk",
      body: "web-01",
      payload: { rule_id: ruleId, channel_ids: [ruleId] },
    };
  }

  it("rateKeyOf：alert 按 rule_id 分窗（同主机两规则不同 key），其余 kind 维持口径", async () => {
    const { rateKeyOf } = await import("./core");
    expect(rateKeyOf(alertEvent(1))).toBe("alert:7:1");
    expect(rateKeyOf(alertEvent(2))).toBe("alert:7:2"); // 同主机不同规则：不同 key
    expect(rateKeyOf(alertEvent(1, 8))).toBe("alert:8:1"); // 不同主机：不同 key
    expect(rateKeyOf({ ...alertEvent(1), kind: "transfer", payload: {} })).toBe("transfer:7");
    expect(rateKeyOf({ ...alertEvent(1), kind: "transfer", host_id: null, payload: {} })).toBe(
      "transfer:-",
    );
  });

  /** 真管线集成底座：core.notify 全真（假时钟 + invoke echo）+ 按渠道 id 订阅的假渠道。 */
  async function wireRealPipeline(clock: { t: number }) {
    const core = await import("./core");
    const { setNotifyPorts, resetRateLimiter, channels, useNotifyStore } = core;
    const inv = (await import("@tauri-apps/api/core")).invoke as unknown as Mock;
    inv.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "notify_insert") {
        const input = args!.input as { kind: string };
        return { id: 1, ...input, read: false, ts: 1 };
      }
      return {};
    });
    useNotifyStore.setState({ items: [], unread: 0, muted: [] });
    resetRateLimiter();
    setNotifyPorts({ now: () => clock.t, focused: () => true, system: async () => {} });
    channels.length = 0;
    const received: { id: number; events: NotificationEvent[] }[] = [1, 2].map((id) => ({
      id,
      events: [],
    }));
    for (const c of received) {
      channels.push({
        name: `fake#${c.id}`,
        send: async (e) => void c.events.push(e),
        test: async () => {},
        subscribed: (e) => {
          const ids = e.payload?.["channel_ids"];
          return e.kind === "alert" && Array.isArray(ids) && (ids as number[]).includes(c.id);
        },
      });
    }
    return { core, received };
  }

  function engineWithRealNotify(
    rules: AlertRule[],
    notify: (e: NotificationEvent) => Promise<boolean>,
    touch: Mock,
    clock: { t: number },
  ): AlertEngine {
    const engine = new AlertEngine();
    (engine as unknown as { rules: AlertRule[] }).rules = rules;
    setAlertEngineDeps({
      now: () => clock.t, // 引擎与管线共用同一假时钟
      notify,
      touchFired: touch,
      fetchProcesses: async () => [],
      hostByRustId: (rustId) =>
        rustId === "pty-1" ? { hostId: 7, hostName: "web-01" } : null,
      sessionByHost: (hostId) =>
        hostId === 7 ? { rustId: "pty-1", hostName: "web-01" } : null,
    });
    return engine;
  }

  function diskMetrics(percent: number): MonitorMetrics {
    return {
      cpu_percent: 10,
      mem_used_percent: 10,
      mem_total_kb: 1,
      mem_used_kb: 1,
      load_one: 0,
      load_five: 0,
      load_fifteen: 0,
      net_rx_bps: 0,
      net_tx_bps: 0,
      disk: [{ filesystem: "x", total_kb: 1, used_kb: 1, avail_kb: 0, used_percent: percent, mount: "/" }],
    };
  }

  it("同主机两规则同刻 fire：各自窗口放行、各自渠道按 channel_ids 收到自己的告警", async () => {
    const clock = { t: 3_000_000 };
    const { received } = await wireRealPipeline(clock);
    const touch = vi.fn(async () => {});
    const engine = engineWithRealNotify(
      [
        rule({ id: 1, host_id: 7, channels: [1], params: { mount: "/", threshold: 90 } }),
        rule({ id: 2, host_id: 7, channels: [2], params: { mount: "/", threshold: 80 } }),
      ],
      (await import("./core")).notify,
      touch,
      clock,
    );

    await engine.onMonitorSample("pty-1", diskMetrics(95)); // 两规则同刻越阈
    await waitForTick();
    expect(received[0].events).toHaveLength(1); // 规则 1 渠道只收规则 1
    expect(received[1].events).toHaveLength(1); // 规则 2 渠道只收规则 2（不被规则 1 窗口吞）
    expect(received[0].events[0].payload?.["rule_id"]).toBe(1);
    expect(received[0].events[0].payload?.["channel_ids"]).toEqual([1]);
    expect(received[1].events[0].payload?.["rule_id"]).toBe(2);
    expect(received[1].events[0].payload?.["channel_ids"]).toEqual([2]);
    expect(touch).toHaveBeenCalledTimes(2); // 两规则水位各自回写（nowSec = ms/1000）
    expect(touch).toHaveBeenCalledWith(1, 3_000);
    expect(touch).toHaveBeenCalledWith(2, 3_000);
  });

  it("同规则被聚合时不回写水位；出窗后重放且 suppressed 结算", async () => {
    const clock = { t: 3_000_000 };
    const { received } = await wireRealPipeline(clock);
    const touch = vi.fn(async () => {});
    const engine = engineWithRealNotify(
      [rule({ id: 2, host_id: 7, channels: [2], params: { mount: "/", threshold: 90 } })],
      (await import("./core")).notify,
      touch,
      clock,
    );
    const above = diskMetrics(95);
    const below = diskMetrics(50);

    // t0：放行开窗（水位 = nowSec 3000）
    await engine.onMonitorSample("pty-1", above);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(2, 3_000);
    // t0+10s：恢复→再越阈重 fire → 落自身窗口内被聚合 → 水位不推进、不回写
    await engine.onMonitorSample("pty-1", below); // rearm
    clock.t += 10_000;
    await engine.onMonitorSample("pty-1", above);
    expect(touch).toHaveBeenCalledTimes(1); // 被聚合吞掉：不回写
    // t0+61s：出窗重放（恢复→越阈）→ 放行 + suppressed 结算 + 水位推进
    await engine.onMonitorSample("pty-1", below);
    clock.t += 51_000;
    await engine.onMonitorSample("pty-1", above);
    expect(touch).toHaveBeenCalledTimes(2);
    expect(touch).toHaveBeenLastCalledWith(2, 3_061);
    await waitForTick();
    const pushed = received[1].events;
    expect(pushed).toHaveLength(2); // 首条 + 出窗重放条
    expect(pushed[1].payload?.["suppressed"]).toBe(1); // 窗口内聚合 1 条随行
  });
});

/** 微任务排空（fire-and-forget 的 notify 链路落定）。 */
async function waitForTick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}
