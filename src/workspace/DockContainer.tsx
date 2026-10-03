// DockContainer（UI 批次一 Task 2）：右侧 dock 槽位骨架——工具面板统一停靠壳。
// 本任务只建壳（标题 + 关闭 + 空内容占位）；T4 把 ForwardPanel / JumpChainEditor
// / CronPanel / AlertSettings / McpSettings 五个对话框实体迁入 dock-body（届时
// 顶部工具菜单条目 openDock 即见实体面板）。
//
// 【互斥语义】dock 单槽由 workspaceStore 保证（openDock 换值即替换）——本组件
// 只读 dockPanel 渲染，不持本地开关状态。monitor/plugins 是终端右栏自管折叠
// 侧栏（并存语义沿现状，见 types.ts 头注），不经本壳：store 接受其值但此处
// 渲染 null，视觉零变化。
import { useTranslation } from "react-i18next";
import { DOCK_PANEL_TITLE_KEY, TOOL_DOCK_PANELS, type ToolDockPanel } from "./types";
import { useWorkspaceStore } from "./workspaceStore";

export function DockContainer() {
  const { t } = useTranslation();
  const panel = useWorkspaceStore((s) => s.dockPanel);
  const closeDock = useWorkspaceStore((s) => s.closeDock);

  // 关闭态 / 侧栏值（monitor/plugins 自管挂载，不经 dock 壳）→ 不渲染
  if (panel === null || !TOOL_DOCK_PANELS.includes(panel as ToolDockPanel)) return null;

  const titleKey = DOCK_PANEL_TITLE_KEY[panel as ToolDockPanel];
  return (
    <aside
      className="dock-panel"
      data-testid="dock-container"
      data-panel={panel}
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
