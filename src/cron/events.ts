// cron 事件接线（Phase 4 Task 1）：ottr://cron-run → CronStore（面板活性）
// + 统一通知管线 notify(kind=cron)。
//
// 【通知语义裁定（简报「muted-by-default 或 kind=cron 可静音」二选一）】
// 选 **kind=cron 独立静音位、默认不静音**（NotificationCenter 类型区多一档），
// 叠加**投递分级**（真窗实验 2026-10-02 的噪音实证驱动，见 task-1-report §6）：
// * ①中心：每轮都进（运行历史流；CronPanel 另有专史）；
// * ②系统通知：仅 failed/timeout/missed（例行走完的成功是噪音——transfer
//   「成功不通知」同款先例；真窗实测每分钟 ok 轮逐分钟弹系统通知不可接受）；
// * ③外部渠道：按 cron_jobs.channels 显式订阅路由（订阅含 ok 轮——「任务
//   完成推送」是订阅的本意，spec §7③）。
// * 风暴面由管线既有两道闸兜住：限频 key 细化到 `cron:{host}:{job}`
//   （core.rateKeyOf 扩展，alert:host:rule 同款）——同任务 60s 窗口聚合一条
//   （每分钟任务 2 轮落同一窗口时 → 1 条，端到端口径）；嫌吵按 kind 静音。
// * severity：ok=success / missed=warning / failed|timeout=error。
//
// 【宿主裁定】事件源在 Rust 调度器（关窗到托盘照发）；本监听在 webview——
// 隐藏仍存活，管线照走；App 真退出 = 两侧同停（文档语义，task-1-report §4）。
//
// 【缺陷 17（审计截图「cronMissed 风暴」，2026-10-04 裁定）】持续 missed 只告警
// 一次（状态锁存）：无会话的 */5 任务每轮 missed → 限频窗（60s）一过就再弹，
// 未读风暴。锁存语义：missed_latched[host:job]=true 后续 missed 轮在管线入口
// 整体丢弃（不落通知中心、不弹系统通知——cron_runs 落库与 cron-run 事件照发，
// 「持续未执行」的呈现面 = CronPanel 徽标 + 运行历史，而非通知）；任意非
// missed 轮（ok/failed/timeout = 恢复有会话执行过）重置锁存，下一轮 missed
// 重新首告。调度语义照旧：Rust 侧每轮如实落库+发事件，静默只在本管线。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useVaultStore } from "../vault/store";
import { notify } from "../notify/core";
import type { CronRunEvent, CronRunStatus } from "./api";
import { useCronStore } from "./cronStore";

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** missed 状态锁存表（缺陷 17）：键 `host_id:cron_id` → 该任务持续 missed 中。
 * 非 missed 轮移除键（恢复重置）；模块级即可——webview 单实例，锁存活进程
 * 生命周期，与限频表同款无持久化需求。 */
const missedLatched = new Set<string>();

/** 锁存键（纯函数，可测）。 */
export function missedLatchKey(event: CronRunEvent): string {
  return `${event.host_id}:${event.cron_id}`;
}

/** 测试隔离用：清空 missed 锁存表（生产不调用）。 */
export function resetMissedLatchForTests(): void {
  missedLatched.clear();
}

/** severity 判定单点（ok/missed/failed/timeout → 管线四档）。 */
export function severityOf(status: CronRunStatus): "success" | "warning" | "error" {
  switch (status) {
    case "ok":
      return "success";
    case "missed":
      return "warning";
    default:
      return "error"; // failed / timeout
  }
}

/** 通知标题键（i18n；正文带主机名与状态细节）。 */
export function titleKeyOf(status: CronRunStatus): string {
  switch (status) {
    case "ok":
      return "notify.title.cronOk";
    case "missed":
      return "notify.title.cronMissed";
    case "timeout":
      return "notify.title.cronTimeout";
    default:
      return "notify.title.cronFailed";
  }
}

/** 事件 → 通知管线（导出供单测直驱；限频/静音在管线内）。
 * 缺陷 17：missed 锁存——持续 missed 只首告一次，非 missed 轮重置（见模块文档）。 */
export function notifyCronRun(event: CronRunEvent): Promise<boolean> {
  const key = missedLatchKey(event);
  if (event.status === "missed") {
    if (missedLatched.has(key)) return Promise.resolve(false);
    missedLatched.add(key);
  } else {
    missedLatched.delete(key); // ok/failed/timeout = 恢复面：锁存重置
  }
  const hostName =
    useVaultStore.getState().hosts.find((h) => h.id === event.host_id)?.name ??
    `#${event.host_id}`;
  const detail =
    event.error ??
    (event.exit_code != null ? `exit ${event.exit_code}` : `${event.duration_ms}ms`);
  return notify(
    {
      kind: "cron",
      severity: severityOf(event.status),
      host_id: event.host_id === 0 ? null : event.host_id,
      title_key: titleKeyOf(event.status),
      body: `${hostName} · ${detail}`,
      payload: {
        cron_id: event.cron_id,
        channel_ids: event.channel_ids,
        status: event.status,
        exit_code: event.exit_code,
        duration_ms: event.duration_ms,
        output_digest: event.output_digest,
      },
    },
    // ②系统通知仅异常轮（ok 例行成功静默；③渠道不受影响——订阅面照推）
    { system: event.status !== "ok" },
  );
}

/** 注册 cron 运行事件监听（幂等；App 挂载链调用一次）。 */
export async function initCronEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  unlisteners.push(
    await listen<CronRunEvent>("ottr://cron-run", (e) => {
      useCronStore.getState().onRunEvent(e.payload);
      void notifyCronRun(e.payload);
    }),
  );
}

/** 卸载监听（测试/热重载清理用）。 */
export function disposeCronEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}
