// cron 事件接线（Phase 4 Task 1）：ottr://cron-run → CronStore（面板活性）
// + 统一通知管线 notify(kind=cron)。
//
// 【通知语义裁定（简报「muted-by-default 或 kind=cron 可静音」二选一）】
// 选 **kind=cron 独立静音位、默认不静音**（NotificationCenter 类型区多一档）：
// * cron 完成通知走完整管线（①中心 + ②系统 + ③按 cron_jobs.channels 订阅的
//   外部渠道），默认可见——「任务跑完/跑挂了」是运维要害面，默认静音会把
//   失败吞进历史表；
// * 风暴面由管线既有两道闸兜住：限频 key 细化到 `cron:{host}:{job}`
//   （core.rateKeyOf 扩展，alert:host:rule 同款）——同任务 60s 窗口聚合一条；
//   系统通知前台静默。每分钟任务 ≤1 条/分（聚合语义，真夹具端到端的
//   「2 轮 → 通知 1 条」即此口径）；嫌吵的用户按 kind 静音一行开关。
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
  return notify({
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
  });
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
