// DockPanel（UI 批次一 Task 4；2026-10-10 交互收敛）：右侧 dock 实体壳——
// 无自体导航（页签条已移除）：当前面板标题 + 关闭钮 + keep-alive 面板区。
// **切换唯一入口 = 侧栏工具行**（toggleDock：点行开/激活、再点收起、激活
// 高亮）——双切换器（页签条+侧栏）交互混乱，用户裁定只留侧栏一轨。
// monitor/plugins 是终端右栏自管折叠侧栏，不经本壳。
//
// 【页签语义（用户裁定「根治互相覆盖」）】openDock 打开/激活、closeTab 关单
// 页签（活动权移交右邻）、closeDock 清空全部。面板 keep-alive：打开过的页签
// 恒渲染（open 恒 true），非活动页由 .dock-pane[hidden] 隐藏——切换不丢展开
// 状态/表单草稿；数据面（ForwardPanel 轮询、CronPanel 打开期取数）随页签
// 存续持续刷新。
//
// 【Esc】dock 活动页非空时注册 useEscClose → 关活动页（后挂载语义保证：
// 叠在其上的对话框先收到 Esc）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DOCK_PANEL_TITLE_KEY, type ToolDockPanel } from "../workspace/types";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useEscClose } from "../ui/useEscClose";
import { useDelayedUnmount } from "../ui/useDelayedUnmount";
import { ForwardPanel } from "../forward/ForwardPanel";
import { JumpChainEditor } from "../hosts/JumpChainEditor";
import { CronPanel } from "../cron/CronPanel";
import { AlertSettings } from "../notify/AlertSettings";
import { McpSettings } from "../security/McpSettings";
import { NotificationCenter } from "../notify/NotificationCenter";

export function DockPanel() {
  const { t } = useTranslation();
  const tabs = useWorkspaceStore((s) => s.dockTabs);
  const active = useWorkspaceStore((s) => s.dockActive);
  const closeTab = useWorkspaceStore((s) => s.closeTab);

  // Esc 关活动页（active=null 时不注册——dock 关闭态不劫持全局 Esc）。
  useEscClose(active !== null, () => {
    if (active !== null) closeTab(active);
  });

  // 展开动画窗（评审 P1-10）：关闭期保留挂载播 dock-out（宽度收拢 + 淡出，
  // --dur-slow 240ms → 卸载延时 280ms），标题用最后活动页避免关尾闪空。
  const mount = useDelayedUnmount(active !== null, 280);
  const [lastActive, setLastActive] = useState<ToolDockPanel | null>(active);
  useEffect(() => {
    if (active !== null) setLastActive(active);
  }, [active]);

  // 关闭动画播完（无活动页签）→ 不渲染
  if (!mount.shouldRender || lastActive === null) return null;
  const titlePanel = active ?? lastActive;

  return (
    <aside
      className={`dock-panel${mount.closing ? " closing" : ""}`}
      data-testid="dock-container"
      data-panel={titlePanel}
      aria-label={t(DOCK_PANEL_TITLE_KEY[titlePanel])}
    >
      <div className="dock-head">
        <span className="dock-title" data-testid="dock-title">
          {t(DOCK_PANEL_TITLE_KEY[titlePanel])}
        </span>
        {/* 关闭唯一入口 = 壳 ✕（关当前面板，keep-alive 状态保留；切换 = 侧栏工具行） */}
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
          不丢展开状态/表单草稿；open 恒 true（页签开着 = 面板开着）。收尾期
          （active=null）仍渲染最后内容，随壳一起淡出。 */}
      <div className="dock-body">
        {tabs.map((p) => (
          <div
            key={p}
            className="dock-pane"
            hidden={p !== (active ?? lastActive)}
            data-testid={`dock-pane-${p}`}
          >
            {p === "forwards" && <ForwardPanel open />}
            {p === "jumpchains" && <JumpChainEditor open />}
            {p === "cron" && <CronPanel open />}
            {p === "alerts" && <AlertSettings open />}
            {p === "mcp" && <McpSettings open />}
            {p === "notifications" && <NotificationCenter />}
          </div>
        ))}
      </div>
    </aside>
  );
}
