// TabBar（Task 7，A6）：多会话标签条。每标签一枚状态灯——
//   connected=绿 / reconnecting=黄 / waiting_host_key=橙 / 其他=灰；
// 重连中展示 第 n/max 次；关标签（✕）= disconnect（drop_session，不重连）。
// 主题纪律：颜色只引用 --color-* 语义层（见 App.css .tab-dot）。
//
// 总览置顶标签（2026-10-16 用户需求）：总览打开后固定渲染在第一位（置顶，
// 无状态灯/PROD 等会话徽标）。库级宽幅视图页签（2026-10-16 IA 重构）：定时
// 任务/通知中心/端口转发/跳板链镜像 mainView，「正被查看」⟺ 激活；会话标签
// 仅在会话级视图（终端/文件/进程/监控/插件/批量）下激活。点会话标签离开
// 任一库级视图回终端——标签语义：点哪个标签看哪个内容。
import { useTranslation } from "react-i18next";
import { useSessionStore, type Session } from "./SessionStore";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { workspaceViewOf, WORKSPACE_VIEW_META, type WorkspaceView } from "../workspace/workspaceViews";

export interface TabBarProps {
  /** 融合式标题栏拖拽面延伸（mac 注入，MainArea 透传）：标签容器 flex:1
   * 占满行内空档——不带 data-tauri-drag-region 属性则空档双击缩放/起拖
   * 都落空（事件目标是本元素、属性检查不过，2026-10-16 用户反馈）。
   * 只放容器本身：标签（子元素）点击语义不受影响。 */
  dragRegion?: Record<string, unknown>;
}

export function TabBar({ dragRegion }: TabBarProps) {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const closeTab = useSessionStore((s) => s.closeTab);
  const max = useSessionStore((s) => s.settings.maxReconnectAttempts);
  const overviewOpen = useWorkspaceStore((s) => s.overviewOpen);
  const mainView = useWorkspaceStore((s) => s.mainView);
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  const closeMainView = useWorkspaceStore((s) => s.closeMainView);
  const closeOverview = useWorkspaceStore((s) => s.closeOverview);

  // 只渲染标签根会话（paneOf=null）：分屏 pane 属标签内部布局，不进标签条（Task 8）
  const tabs = sessions.filter((s) => s.paneOf === null);
  // 工作区页签（2026-10-16 IA 重构）：镜像当前库级视图；总览标签「开着但正看
  // 终端」时以非激活态保留（置顶语义不变）。
  const workspaceView: WorkspaceView | null =
    workspaceViewOf(mainView) ?? (overviewOpen ? "overview" : null);
  if (tabs.length === 0 && workspaceView === null) return null;

  /** 激活会话标签：从任一库级视图（总览/定时任务/通知中心/端口转发/跳板链）
   * 点会话标签 = 离开该视图回终端——库级页签都要让位（2026-10-17 基线评审：
   * 此前只让位总览，其余四视图下点会话标签被卡住）；会话级子视图
   * （文件/进程/监控/插件）保持既有语义不拽走。 */
  const activateSession = (id: string) => {
    setActive(id);
    if (workspaceViewOf(useWorkspaceStore.getState().mainView) !== null) openMainView("terminal");
  };


  return (
    <div className="tabbar" role="tablist" aria-label={t("tabs.list")} {...dragRegion}>
      {workspaceView !== null && (
        <div
          role="tab"
          tabIndex={0}
          aria-selected={mainView === workspaceView}
          data-active={mainView === workspaceView}
          data-testid={`tab-workspace-${workspaceView}`}
          className="tab"
          onClick={() => openMainView(workspaceView)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openMainView(workspaceView);
            }
          }}
        >
          <span className="tab-overview-icon" aria-hidden>{(() => { const I = WORKSPACE_VIEW_META[workspaceView].icon; return <I />; })()}</span>
          <span className="tab-title">{t(WORKSPACE_VIEW_META[workspaceView].labelKey)}</span>
          <button
            className="tab-close"
            aria-label={t("tabs.closeAria", { name: t(WORKSPACE_VIEW_META[workspaceView].labelKey) })}
            onClick={(e) => {
              e.stopPropagation();
              if (workspaceView === "overview") closeOverview();
              else closeMainView();
            }}
          >
            ✕
          </button>
        </div>
      )}
      {tabs.map((session: Session) => (
        <div
          key={session.id}
          role="tab"
          tabIndex={0}
          aria-selected={session.id === activeId && workspaceViewOf(mainView) === null}
          data-active={session.id === activeId && workspaceViewOf(mainView) === null}
          data-status={session.status}
          data-testid={`tab-${session.hostName}`}
          className="tab"
          onClick={() => activateSession(session.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activateSession(session.id);
            }
          }}
        >
          <span className="tab-dot" data-testid={`tab-dot-${session.hostName}`} aria-hidden />
          <span className="tab-title" title={session.lastError ?? undefined}>
            {session.hostName}
          </span>
          {/* 生产环境主机（Phase 2 Task 11，B11）：PROD 徽标（红 pill，防呆一眼辨） */}
          {session.isProduction && (
            <span
              className="tab-prod"
              data-testid={`tab-prod-${session.hostName}`}
              aria-label={t("terminal.prodBadgeAria")}
              title={t("terminal.prodBadgeAria")}
            >
              {t("tabs.prodBadge")}
            </span>
          )}
          {session.status === "reconnecting" && (
            <span className="tab-retry" data-testid={`tab-retry-${session.hostName}`}>
              {session.attempt}/{max}
            </span>
          )}
          <button
            className="tab-close"
            aria-label={t("tabs.closeAria", { name: session.hostName })}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(session.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
