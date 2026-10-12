// ToolDialog（2026-10-12 用户裁定：dock 侧栏退役，工具面板统一弹框）：
// 六工具面板（forwards/jumpchains/cron/alerts/mcp/notifications）的模态壳——
// 标题 + 关闭 ✕ + Esc；overlay/.dialog 复用全局对话框动效（dialog-in/out，
// .closing 由 useDelayedUnmount 驱动）。一次一个：workspaceStore.toolDialog
// 单槽，异值打开即替换。面板内容组件零改写——dock 时代的 .dock-entity 内容
// 容器样式原样沿用（命名沿旧，语义 = 面板内容根）。monitor/plugins 是终端
// 右栏自管侧栏，不经本壳。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOCK_PANEL_TITLE_KEY, type ToolDockPanel } from "./types";
import { useWorkspaceStore } from "./workspaceStore";
import { useEscClose } from "../ui/useEscClose";
import { useDelayedUnmount } from "../ui/useDelayedUnmount";
import { ForwardPanel } from "../forward/ForwardPanel";
import { JumpChainEditor } from "../hosts/JumpChainEditor";
import { CronPanel } from "../cron/CronPanel";
import { AlertSettings } from "../notify/AlertSettings";
import { McpSettings } from "../security/McpSettings";
import { NotificationCenter } from "../notify/NotificationCenter";

export function ToolDialog() {
  const { t } = useTranslation();
  const active = useWorkspaceStore((s) => s.toolDialog);
  const close = useWorkspaceStore((s) => s.closeToolDialog);

  // Esc 关弹框（null 时不注册——关闭态不劫持全局 Esc；后挂载语义保证：
  // 叠在其上的对话框先收到 Esc）。
  useEscClose(active !== null, close);

  // 退场动画窗：关闭期保留挂载播 dialog-out（.closing 类），播完真卸载。
  const mount = useDelayedUnmount(active !== null);
  const [lastActive, setLastActive] = useState<ToolDockPanel | null>(active);
  useEffect(() => {
    if (active !== null) setLastActive(active);
  }, [active]);

  // 关闭动画播完（无面板）→ 不渲染；收尾期标题用最后活动面板避免关尾闪空。
  if (!mount.shouldRender || lastActive === null) return null;
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
          {titlePanel === "mcp" && <McpSettings open />}
          {titlePanel === "notifications" && <NotificationCenter />}
        </div>
      </div>
    </div>
  );
}
