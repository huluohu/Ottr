// DockPanel（UI 批次一 Task 4；2026-10-09 dock 多页签改造）：右侧 dock 实体
// 壳——顶部页签条（已开面板共存，切换不卸载不互相关闭）+ keep-alive 面板区
// + 关闭钮。monitor/plugins 是终端右栏自管折叠侧栏，不经本壳（dockActive 为
// 其值时 store 不接受，见 workspaceStore）。
//
// 【页签语义（用户裁定「根治互相覆盖」）】openDock 打开/激活、closeTab 关单
// 页签（活动权移交右邻）、closeDock 清空全部。面板 keep-alive：打开过的页签
// 恒渲染（open 恒 true），非活动页由 .dock-pane[hidden] 隐藏——切换不丢展开
// 状态/表单草稿；数据面（ForwardPanel 轮询、CronPanel 打开期取数）随页签
// 存续持续刷新。
//
// 【Esc】dock 活动页非空时注册 useEscClose → 关活动页（后挂载语义保证：
// 叠在其上的对话框先收到 Esc）。
import { useTranslation } from "react-i18next";
import {
  DOCK_PANEL_TITLE_KEY,
  type ToolDockPanel,
} from "../workspace/types";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useEscClose } from "../ui/useEscClose";
import { ForwardPanel } from "../forward/ForwardPanel";
import { JumpChainEditor } from "../hosts/JumpChainEditor";
import { CronPanel } from "../cron/CronPanel";
import { AlertSettings } from "../notify/AlertSettings";
import { McpSettings } from "../security/McpSettings";
import { NotificationCenter } from "../notify/NotificationCenter";

/** 逐面板停靠宽度（px）。380 = 列表型下限；420 = 表单/矩阵型不折行。 */
export const DOCK_PANEL_WIDTH_PX: Record<ToolDockPanel, number> = {
  forwards: 380,
  jumpchains: 380,
  cron: 380,
  alerts: 420,
  mcp: 420,
  notifications: 380,
};

export function DockPanel() {
  const { t } = useTranslation();
  const tabs = useWorkspaceStore((s) => s.dockTabs);
  const active = useWorkspaceStore((s) => s.dockActive);
  const openDock = useWorkspaceStore((s) => s.openDock);
  const closeTab = useWorkspaceStore((s) => s.closeTab);

  // Esc 关活动页（active=null 时不注册——dock 关闭态不劫持全局 Esc）。
  useEscClose(active !== null, () => {
    if (active !== null) closeTab(active);
  });

  // 关闭态（无活动页签）→ 不渲染
  if (active === null) return null;

  const width = DOCK_PANEL_WIDTH_PX[active];
  return (
    <aside
      className="dock-panel"
      data-testid="dock-container"
      data-panel={active}
      style={{ width }}
      aria-label={t(DOCK_PANEL_TITLE_KEY[active])}
    >
      <div className="dock-head">
        <div className="dock-tabs" role="tablist" data-testid="dock-tabs">
          {tabs.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={p === active}
              data-active={p === active}
              data-testid={`dock-tab-${p}`}
              title={t(DOCK_PANEL_TITLE_KEY[p])}
              onClick={() => openDock(p)}
            >
              <span className="dock-tab-label">{t(DOCK_PANEL_TITLE_KEY[p])}</span>
              {tabs.length > 1 && (
                <span
                  className="dock-tab-close"
                  data-testid={`dock-tab-close-${p}`}
                  role="button"
                  aria-label={t("common.close")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(p);
                  }}
                >
                  ✕
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          className="dock-close"
          data-testid="dock-close"
          aria-label={t("common.close")}
          onClick={() => active !== null && closeTab(active)}
        >
          ✕
        </button>
      </div>
      {/* keep-alive 面板区：打开过的页签恒渲染，非活动页 CSS 隐藏——切换
          不丢展开状态/表单草稿；open 恒 true（页签开着 = 面板开着）。 */}
      <div className="dock-body">
        {tabs.map((p) => (
          <div
            key={p}
            className="dock-pane"
            hidden={p !== active}
            data-testid={`dock-pane-${p}`}
          >
            {p === "forwards" && <ForwardPanel open />}
            {p === "jumpchains" && <JumpChainEditor open />}
            {p === "cron" && <CronPanel open />}
            {p === "alerts" && <AlertSettings open onClose={() => closeTab(p)} />}
            {p === "mcp" && <McpSettings open onClose={() => closeTab(p)} />}
            {p === "notifications" && <NotificationCenter />}
          </div>
        ))}
      </div>
    </aside>
  );
}
