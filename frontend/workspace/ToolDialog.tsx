// ToolDialog（2026-10-12 用户裁定：dock 侧栏退役，工具面板统一弹框）：
// 六工具面板（forwards/jumpchains/cron/alerts/mcp/notifications）的模态壳——
// 标题 + 关闭 ✕ + Esc；overlay/.dialog 复用全局对话框动效（dialog-in/out，
// .closing 由 useDelayedUnmount 驱动）。一次一个：workspaceStore.toolDialog
// 单槽，异值打开即替换。面板内容组件零改写——dock 时代的 .dock-entity 内容
// 容器样式原样沿用（命名沿旧，语义 = 面板内容根）。monitor/plugins 原为
// 终端右栏自管侧栏，2026-10-13 起并入本壳（折叠竖条退役，见 types.ts）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOCK_PANEL_TITLE_KEY, type ToolDockPanel } from "./types";
import { useWorkspaceStore } from "./workspaceStore";
import { useModalStore } from "../ui/modalStore";
import { useEscClose } from "../ui/useEscClose";
import { useDelayedUnmount } from "../ui/useDelayedUnmount";
import { ForwardPanel } from "../forward/ForwardPanel";
import { JumpChainEditor } from "../hosts/JumpChainEditor";
import { CronPanel } from "../cron/CronPanel";
import { AlertSettings } from "../notify/AlertSettings";
import { NotificationCenter } from "../notify/NotificationCenter";
import { MonitorPanel } from "../monitor/MonitorSidebar";
import { PluginPanel } from "../plugins/PluginSidebar";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";

/** 活动标签根会话（派生口径与 MainArea 一致：活动 pane → 根会话）。 */
function useActiveRootSession() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const hosts = useVaultStore((s) => s.hosts);
  const activeSession =
    sessions.find((s) => s.id === activeId) ?? sessions.find((s) => s.paneOf === activeId) ?? null;
  const root =
    activeSession != null
      ? (sessions.find((s) => s.id === (activeSession.paneOf ?? activeSession.id)) ?? null)
      : null;
  return {
    rustId: root?.rustId ?? null,
    hostId: root?.hostId ?? null,
    monitorEnabled: hosts.find((h) => h.id === root?.hostId)?.monitor_enabled ?? false,
  };
}

function MonitorPanelBody() {
  const { rustId, monitorEnabled } = useActiveRootSession();
  return <MonitorPanel rustId={rustId} enabled={monitorEnabled} />;
}

function PluginPanelBody() {
  const { rustId } = useActiveRootSession();
  return <PluginPanel rustId={rustId} />;
}

export function ToolDialog() {
  const { t } = useTranslation();
  const active = useWorkspaceStore((s) => s.toolDialog);
  const close = useWorkspaceStore((s) => s.closeToolDialog);
  // 全局弹窗唯一槽（2026-10-14）：持有槽位才渲染；被其他弹窗顶掉即销毁
  // （正常关闭时全局槽已空，`activeModal === null` 放行退场动画播完）。
  const slotOwned = useModalStore((s) => s.active === "toolDialog");
  const slotIdle = useModalStore((s) => s.active === null);

  // Esc 关弹框（null 时不注册——关闭态不劫持全局 Esc；单实例槽下不存在叠框，
  // Esc 只会命中本框）。
  useEscClose(active !== null && slotOwned, close);

  // 退场动画窗：关闭期保留挂载播 dialog-out（.closing 类），播完真卸载。
  const mount = useDelayedUnmount(active !== null);
  const [lastActive, setLastActive] = useState<ToolDockPanel | null>(active);
  useEffect(() => {
    if (active !== null) setLastActive(active);
  }, [active]);

  // 关闭动画播完（无面板）→ 不渲染；收尾期标题用最后活动面板避免关尾闪空。
  if (!mount.shouldRender || lastActive === null || !(slotOwned || slotIdle)) return null;
  const titlePanel = active ?? lastActive;

  return (
    <div
      className={`overlay${mount.closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t(DOCK_PANEL_TITLE_KEY[titlePanel])}
      data-testid="tool-dialog"
      data-panel={titlePanel}
    >
      <div className="dialog tool-dialog">
        <div className="tool-dialog-head">
          <h2 data-testid="tool-dialog-title">{t(DOCK_PANEL_TITLE_KEY[titlePanel])}</h2>
          <button
            type="button"
            className="dialog-close"
            data-testid="tool-dialog-close"
            aria-label={t("common.close")}
            onClick={close}
          >
            ✕
          </button>
        </div>
        <div className="tool-dialog-body">
          {titlePanel === "forwards" && <ForwardPanel open />}
          {titlePanel === "jumpchains" && <JumpChainEditor open />}
          {titlePanel === "cron" && <CronPanel open />}
          {titlePanel === "alerts" && <AlertSettings open />}

          {titlePanel === "notifications" && <NotificationCenter />}
          {titlePanel === "monitor" && <MonitorPanelBody />}
          {titlePanel === "plugins" && <PluginPanelBody />}
        </div>
      </div>
    </div>
  );
}
