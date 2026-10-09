// `ottr://batch-result` 事件 → BatchStore 接线（Phase 3 Task 4，B6）。
// App 挂载链调用一次（initMonitorEvents 同款惯例）；App.test 侧 stub。
// 事件名契约（Rust 侧 commands/batch.rs）：
//   ottr://batch-result  BatchResultEvent — { batch_id, host_id, name, status,
//   exit_code, stdout, stderr, truncated, duration_ms, error }
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useBatchStore } from "./batchStore";
import type { BatchResult } from "./api";

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** 注册批量结果事件监听（幂等；StrictMode 双挂载只接一次）。 */
export async function initBatchEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  unlisteners.push(
    await listen<BatchResult>("ottr://batch-result", (e) => {
      useBatchStore.getState().onBatchResult(e.payload);
    }),
  );
}

/** 卸载监听（测试/热重载清理用）。 */
export function disposeBatchEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}
