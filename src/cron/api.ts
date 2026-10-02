// cron 定时任务（Phase 4 Task 1，缺口①）invoke 契约层：类型与 Rust
// `src-tauri/src/commands/cron.rs` serde 面逐字对齐（batch/api 同款纪律）。
// 命令：
//   cj_list / cj_create / cj_update / cj_delete      配置面（锁定门卫内）
//   cj_runs(cronId, limit)                           运行历史（明文读面）
//   cj_trigger(id)                                   手动触发一轮（同步等结果）
//   cj_next_fire(schedule, afterSecs?)               下次触发时刻（UI 预览）
//   cj_run_output(path)                              输出正文（sidecar 读面）
// 事件：ottr://cron-run（CronRunEvent，接线见 ./events.ts）。
import { invoke } from "@tauri-apps/api/core";

/** Rust `CronJob` 同构（cron_jobs 行；channels = notify_channels.id 数组）。 */
export interface CronJob {
  id: number;
  host_id: number;
  /** 五段式 cron 表达式（如 0 12 * * 1；分 时 日 月 周）。 */
  schedule: string;
  /** 远端执行的脚本/命令（exec 通道）。 */
  script: string;
  channels: number[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Rust `CronJobInput` 同构（create/update 全量替换式提交）。 */
export interface CronJobInput {
  host_id: number;
  schedule: string;
  script: string;
  channels: number[];
  enabled: boolean;
}

/** 单轮运行状态（Rust CronRunStatus serde snake_case）。 */
export type CronRunStatus = "ok" | "failed" | "timeout" | "missed";

/** Rust `cron_runs` 行同构（output_path = sidecar 文件；正文经 cj_run_output 读）。 */
export interface CronRun {
  id: number;
  cron_id: number;
  status: CronRunStatus;
  exit_code: number | null;
  output_digest: string | null;
  output_path: string | null;
  duration_ms: number;
  ts: number;
}

/** `ottr://cron-run` 事件载荷（Rust CronRunEvent 同构）。channel_ids 供
 * 外部渠道订阅路由（spec §7③：cron_jobs.channels）。 */
export interface CronRunEvent {
  run_id: number;
  cron_id: number;
  host_id: number;
  status: CronRunStatus;
  exit_code: number | null;
  duration_ms: number;
  ts: number;
  output_digest: string | null;
  truncated: boolean;
  error: string | null;
  channel_ids: number[];
}

export const cronApi = {
  list: () => invoke<CronJob[]>("cj_list"),
  create: (input: CronJobInput) => invoke<CronJob>("cj_create", { input }),
  update: (id: number, input: CronJobInput) => invoke<CronJob>("cj_update", { id, input }),
  remove: (id: number) => invoke<void>("cj_delete", { id }),
  /** 某任务最近 `limit` 条运行历史（ts 降序）。 */
  runs: (cronId: number, limit: number) => invoke<CronRun[]>("cj_runs", { cronId, limit }),
  /** 手动触发一轮（同步等结果；单轮有 Rust 侧限时兜底）。 */
  trigger: (id: number) => invoke<CronRunEvent>("cj_trigger", { id }),
  /** 下次触发时刻（unix 秒）；schedule 非法 → reject（表单即时校验面）。 */
  nextFire: (schedule: string, afterSecs?: number) =>
    invoke<number | null>("cj_next_fire", { schedule, afterSecs }),
  /** 输出正文（path 必须是 cj_runs 回传的 sidecar 路径——Rust 侧目录守卫）。 */
  runOutput: (path: string) => invoke<string>("cj_run_output", { path }),
};
