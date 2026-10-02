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
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useVaultStore } from "../vault/store";
import { notify } from "../notify/core";
import type { CronRunEvent, CronRunStatus } from "./api";
import { useCronStore } from "./cronStore";

let wired = false;
const unlisteners: UnlistenFn[] = [];

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

/** 事件 → 通知管线（导出供单测直驱；限频/静音在管线内）。 */
export function notifyCronRun(event: CronRunEvent): Promise<boolean> {
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
