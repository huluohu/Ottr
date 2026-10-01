// 批量执行（Phase 3 Task 4，B6）invoke 契约层：类型与 Rust
// `src-tauri/src/commands/batch.rs` serde 面逐字对齐（vault/api 同款纪律）。
// 命令：
//   batch_exec(targets, concurrency?, timeoutSecs?) → batch_id（立即返回，
//     结果经 ottr://batch-result 逐主机事件流回，见 ./events.ts）
//   batch_cancel(batchId) → 是否确有在跑批次
import { invoke } from "@tauri-apps/api/core";

/** 单主机目标（Rust BatchTargetInput 同构）。command 已是 per-host 渲染后的
 * 最终命令串（变量表单在前端渲染，Rust 不关心模板面）；session_id 为空串 =
 * 未连接（Rust resolve 必败 → per-host failed 结果，表格如实呈现）。 */
export interface BatchTargetInput {
  host_id: number;
  name: string;
  session_id: string;
  command: string;
}

/** 单主机状态（Rust BatchStatus serde snake_case）。 */
export type BatchStatus = "ok" | "failed" | "timeout" | "canceled";

/** `ottr://batch-result` 事件载荷（Rust BatchResultEvent 同构）。stdout/stderr
 * 已在 Rust 侧摘要截断（前 80 + 尾 20 行、64KB 上限），truncated 标记展示用。 */
export interface BatchResult {
  batch_id: string;
  host_id: number;
  name: string;
  status: BatchStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
  error: string | null;
}

export const batchApi = {
  /** 发起批量执行：返回 batch_id（不等结果）。 */
  exec: (targets: BatchTargetInput[], concurrency: number, timeoutSecs: number) =>
    invoke<string>("batch_exec", { targets, concurrency, timeoutSecs }),
  /** 取消批次（剩余主机不再发起；在途 exec 等自然完成/超时）。 */
  cancel: (batchId: string) => invoke<boolean>("batch_cancel", { batchId }),
};
