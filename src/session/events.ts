// Tauri 事件 → SessionStore 接线（Task 7）。App 挂载时调用一次；
// 独立模块让 store 保持纯状态机（测试无需 mock @tauri-apps/api/event）。
// 事件名契约（Rust 侧 lib.rs）：
//   ottr://host-key-ask   HostKeyAskPayload — TOFU 确认框问询
//   ottr://session-closed SessionClosedPayload — 连接丢失/主动关闭通知
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useSessionStore,
  type HostKeyAskPayload,
  type SessionClosedPayload,
} from "./SessionStore";

let wired = false;
const unlisteners: UnlistenFn[] = [];

/** 注册会话相关事件监听（幂等；StrictMode 双挂载只接一次）。 */
export async function initSessionEvents(): Promise<void> {
  if (wired) return;
  wired = true;
  const store = useSessionStore;
  store.getState().loadSettings();
  unlisteners.push(
    await listen<HostKeyAskPayload>("ottr://host-key-ask", (e) => {
      store.getState().onHostKeyAsk(e.payload);
    }),
  );
  unlisteners.push(
    await listen<SessionClosedPayload>("ottr://session-closed", (e) => {
      store.getState().onSessionClosed(e.payload);
    }),
  );
}

/** 卸载监听（测试/热重载清理用；主进程生命周期内通常不需要）。 */
export function disposeSessionEvents(): void {
  for (const off of unlisteners) off();
  unlisteners.length = 0;
  wired = false;
}
