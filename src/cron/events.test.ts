// cron 事件接线测试（Phase 4 Task 1）：ottr://cron-run → notify(kind=cron) 的
// 管线语义——kind=cron 独立静音位（默认放行）、限频 key 细化 `cron:{host}:{job}`
// （每分钟任务 2 轮 → 通知 1 条的聚合口径，真夹具端到端同口径）、severity 分档、
// 外部渠道按 channel_ids 订阅路由。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

import "../i18n";
import { resetRateLimiter, setNotifyPorts, useNotifyStore, type NotifyPorts } from "../notify/core";
import { channels } from "../notify/core";
import { notifyCronRun, severityOf, titleKeyOf } from "./events";
import type { CronRunEvent } from "./api";

function event(over: Partial<CronRunEvent>): CronRunEvent {
  return {
    run_id: 1,
    cron_id: 7,
    host_id: 3,
    status: "ok",
    exit_code: 0,
    duration_ms: 120,
    ts: 1_800_000_000,
    output_digest: null,
    truncated: false,
    error: null,
    channel_ids: [5],
    ...over,
  };
}

let now = 1_000_000;
const sysCalls: string[] = [];

function fakePorts(): NotifyPorts {
  return {
    now: () => now,
    focused: () => false, // 失焦 → ②系统通知必走（断言面）
    system: async (title, body) => {
      sysCalls.push(`${title}|${body}`);
    },
  };
}

beforeEach(() => {
  now = 1_000_000;
  sysCalls.length = 0;
  setNotifyPorts(fakePorts());
  resetRateLimiter();
  useNotifyStore.setState({ muted: [], items: [], unread: 0 });
});

afterEach(() => {
  setNotifyPorts(null);
  resetRateLimiter();
});

describe("cron 通知语义", () => {
  it("投递分级：ok → ①中心放行但 ②系统通知静默（例行成功不弹）", async () => {
    const allowed = await notifyCronRun(event({ status: "ok" }));
    expect(allowed).toBe(true); // ok 轮放行（①落库 + ③渠道照走）
    expect(sysCalls).toHaveLength(0);
  });

  it("异常轮照常弹系统通知（missed → warning）", async () => {
    const allowed = await notifyCronRun(
      event({ status: "missed", exit_code: null, error: "no live session" }),
    );
    expect(allowed).toBe(true);
    expect(sysCalls).toHaveLength(1);
    const [title] = sysCalls[0].split("|");
    // 标题必须经 i18n 解析为文案（词典键原文 = 未解析）
    expect(title).not.toContain("notify.title.");
    expect(titleKeyOf("missed")).toBe("notify.title.cronMissed");
  });

  it("severity 与标题键分档", () => {
    expect(severityOf("ok")).toBe("success");
    expect(severityOf("missed")).toBe("warning");
    expect(severityOf("failed")).toBe("error");
    expect(severityOf("timeout")).toBe("error");
    expect(titleKeyOf("missed")).toBe("notify.title.cronMissed");
    expect(titleKeyOf("timeout")).toBe("notify.title.cronTimeout");
    expect(titleKeyOf("failed")).toBe("notify.title.cronFailed");
  });

  it("同任务 2 轮（60s 窗口内）→ 聚合 1 条（限频 key cron:{host}:{job}）", async () => {
    // 用 missed 轮测聚合（异常轮才弹②——断言面）；ok 轮聚合语义相同（②本静默）
    expect(await notifyCronRun(event({ status: "missed", exit_code: null }))).toBe(true);
    now += 5_000; // 5s 后第二轮（真实节奏）
    expect(await notifyCronRun(event({ status: "missed", exit_code: null, run_id: 2 }))).toBe(false);
    expect(sysCalls).toHaveLength(1); // 第二轮被聚合，只放行首条
    // 另一任务不受同窗口吞并（不同 cron_id 各自开窗）
    now += 5_000;
    expect(await notifyCronRun(event({ status: "missed", exit_code: null, cron_id: 8 }))).toBe(true);
    expect(sysCalls).toHaveLength(2);
    // 窗口（60s）过后同任务再放行
    now += 60_000;
    expect(await notifyCronRun(event({ status: "missed", exit_code: null, run_id: 3 }))).toBe(true);
    expect(sysCalls).toHaveLength(3);
  });

  it("kind=cron 可静音：静音后管线入口丢弃（不落表不弹不分发）", async () => {
    useNotifyStore.setState({ muted: ["cron"] });
    const allowed = await notifyCronRun(event({}));
    expect(allowed).toBe(false);
    expect(sysCalls).toHaveLength(0);
  });

  it("channel_ids 进 payload（③外部渠道按 cron_jobs.channels 路由）", async () => {
    const seen: string[] = [];
    channels.push({
      name: "test-channel",
      send: async () => {},
      test: async () => {},
      subscribed: (e) => {
        seen.push(String(e.kind));
        const ids = e.payload?.["channel_ids"];
        return Array.isArray(ids) && (ids as number[]).includes(5);
      },
    });
    try {
      await notifyCronRun(event({ channel_ids: [5] }));
      expect(seen).toEqual(["cron"]);
    } finally {
      const idx = channels.findIndex((c) => c.name === "test-channel");
      if (idx >= 0) channels.splice(idx, 1);
    }
  });

  it("missed 事件 host_id=0 归一为无主机（限频按 job 聚合不悬空）", async () => {
    const allowed = await notifyCronRun(
      event({ status: "missed", exit_code: null, host_id: 0, error: "no live session for host 3 (not connected)" }),
    );
    expect(allowed).toBe(true);
    expect(sysCalls[0]).toContain("no live session");
  });
});
