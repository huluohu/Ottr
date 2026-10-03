// DockPanel（UI 批次一 Task 4）：右侧 dock 实体壳——T2 骨架 DockContainer 的
// 承接者（标题 + 关闭 + 滚动内容 + 逐面板宽度）。
//
// 【互斥语义】dock 单槽由 workspaceStore 保证（openDock 换值即替换）——本组件
// 只读 dockPanel 渲染，不持本地开关状态。monitor/plugins 是终端右栏自管折叠
// 侧栏（并存语义沿现状，见 workspace/types.ts 头注），不经本壳：store 接受其
// 值但此处渲染 null，视觉零变化。
//
// 【宽度裁定（本任务）】380-420px 区间逐面板设定：转发/跳板链/定时任务列
// 表型内容 380px 够用；告警（渠道卡 + 规则表单）与 MCP（授权矩阵一行四
// 控件）在 420px 下不折行。宽度是纯呈现，内联 style 直设（CSS 默认宽仅兜底）。
import { useTranslation } from "react-i18next";
import {
  DOCK_PANEL_TITLE_KEY,
  TOOL_DOCK_PANELS,
  type ToolDockPanel,
} from "../workspace/types";
import { useWorkspaceStore } from "../workspace/workspaceStore";

/** 逐面板停靠宽度（px）。380 = 列表型下限；420 = 表单/矩阵型不折行。 */
export const DOCK_PANEL_WIDTH_PX: Record<ToolDockPanel, number> = {
  forwards: 380,
  jumpchains: 380,
  cron: 380,
  alerts: 420,
  mcp: 420,
};

export function DockPanel() {
  const { t } = useTranslation();
  const panel = useWorkspaceStore((s) => s.dockPanel);
  const closeDock = useWorkspaceStore((s) => s.closeDock);

  // 关闭态 / 侧栏值（monitor/plugins 自管挂载，不经 dock 壳）→ 不渲染
  if (panel === null || !TOOL_DOCK_PANELS.includes(panel as ToolDockPanel)) return null;

  const panelId = panel as ToolDockPanel;
  const titleKey = DOCK_PANEL_TITLE_KEY[panelId];
  return (
    <aside
      className="dock-panel"
      data-testid="dock-container"
      data-panel={panelId}
      style={{ width: DOCK_PANEL_WIDTH_PX[panelId] }}
      aria-label={t(titleKey)}
    >
      <div className="dock-head">
        <span className="dock-title" data-testid="dock-title">
          {t(titleKey)}
        </span>
        <button
          className="dock-close"
          data-testid="dock-close"
          aria-label={t("common.close")}
          onClick={closeDock}
        >
          ×
        </button>
      </div>
      <div className="dock-body">{t("workspace.dockHint")}</div>
    </aside>
  );
}
