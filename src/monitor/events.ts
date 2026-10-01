// `ottr://monitor` 事件 → MonitorStore 接线（Phase 3 Task 1）。App 挂载链
// 调用一次；独立模块让 store 保持纯数据机（SessionStore/events 惯例）。
// 事件名契约（Rust 侧 commands/monitor.rs）：
//   ottr://monitor  MonitorEventPayload — { id, status, metrics|null }
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMonitorStore, type MonitorEventPayload } from "./monitorStore";

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** 注册监控事件监听（幂等；StrictMode 双挂载只接一次）。 */
export async function initMonitorEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  const store = useMonitorStore;
  unlisteners.push(
    await listen<MonitorEventPayload>("ottr://monitor", (e) => {
      store.getState().onMonitorEvent(e.payload);
    }),
  );
}

/** 卸载监听（测试/热重载清理用；主进程生命周期内通常不需要）。 */
export function disposeMonitorEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}
