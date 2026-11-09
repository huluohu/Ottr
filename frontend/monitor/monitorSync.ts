// 主机监控开关 → 活会话采样的即时同步（2026-11-08 功能审计 C2）。
//
// 背景：monitor_enabled 只落库，采样此前仅在 attach 成功路径按开关启动
// （SessionStore 的 monitor_start 唯一调用点）——已连接主机上点「开启监控」
// 要等重连才真正起采样（总览卡片还误显「未连接」）；主机表单里把开关关掉
// 则采样照跑到会话消亡。
//
// 收口：monitor_enabled 的三个写入点（总览开/关、主机表单保存）在 updateHost
// 成功后统一经这里对在册根会话对称调 monitor_start / monitor_stop。
// Rust monitor_start 幂等（已在采样 → 直接 Ok）；无活会话 = no-op（下次
// attach 按开关重走）。起停失败静默（同 attach 路径口径）：start 失败时
// 卡片保持无指标，下次重连自愈；stop 失败由 Rust session_down 收尾兜底。
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../session/SessionStore";
import { rootRustIdByHost } from "./OverviewPage";

export function syncMonitorSampling(hostId: number, enabled: boolean): void {
  const rustId = rootRustIdByHost(useSessionStore.getState().sessions).get(hostId);
  if (!rustId) return;
  void invoke(enabled ? "monitor_start" : "monitor_stop", { id: rustId }).catch(() => {
    // 起停失败不阻断开关落库（理由见模块注释）。
  });
}
