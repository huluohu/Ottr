// Tauri 传输事件 → TransferStore 接线（Task 10）。FilePanel 挂载前调用一次；
// 独立模块让 store 保持纯状态机（测试无需 mock @tauri-apps/api/event）。
// 事件名契约（Rust 侧 lib.rs spawn_transfer/progress_emitter）：
//   ottr://transfer-begin    TransferBeginPayload — 传输启动（含身份四元组）
//   ottr://transfer-progress TransferProgressPayload — 进度（100ms 节流，首末帧必发）
//   ottr://transfer-end      TransferEndPayload — done/failed/cancelled 收尾
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useTransferStore,
  type TransferBeginPayload,
  type TransferEndPayload,
  type TransferProgressPayload,
} from "./TransferStore";

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** 注册传输事件监听（幂等；StrictMode 双挂载只接一次）。 */
export async function initTransferEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  const store = useTransferStore;
  unlisteners.push(
    await listen<TransferBeginPayload>("ottr://transfer-begin", (e) => {
      store.getState().onBegin(e.payload);
    }),
  );
  unlisteners.push(
    await listen<TransferProgressPayload>("ottr://transfer-progress", (e) => {
      store.getState().onProgress(e.payload);
    }),
  );
  unlisteners.push(
    await listen<TransferEndPayload>("ottr://transfer-end", (e) => {
      store.getState().onEnd(e.payload);
    }),
  );
}

/** 卸载监听（测试/热重载清理用）。 */
export function disposeTransferEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}
