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
import { useState } from "react";
import { useSessionStore, type Session } from "./SessionStore";
import { useAiStore } from "../ai/aiStore";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { workspaceViewOf, WORKSPACE_VIEW_META, type WorkspaceView } from "../workspace/workspaceViews";
import { copyText } from "../ui/clipboard";
import { showToast } from "../ui/toastStore";

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
  // AI 诊断「待看」徽标（2026-10-19 方案 A 会话作用域）：该会话有面板且用户
  // 未看过（seen=false）→ 页签琥珀点；markSeen（面板挂载）/close 后消失。
  const aiSessions = useAiStore((s) => s.sessions);
  // 页签右键菜单（2026-10-20 用户需求：重命名 + 复制连接）
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sessionId: string } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameTab = useSessionStore((s) => s.renameTab);

  // 只渲染标签根会话（paneOf=null）：分屏 pane 属标签内部布局，不进标签条（Task 8）
  // 排序（2026-10-20 用户需求）：本地终端固定排最前（主机标签之前）；同组内
  // 保持创建序。展示层排序——store 顺序（创建序）不动，激活/持久化不受影响。
  const tabs = sessions
    .filter((s) => s.paneOf === null)
    .sort((a, b) => Number(a.kind === "local" ? 0 : 1) - Number(b.kind === "local" ? 0 : 1));
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
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenu({
              x: Math.min(e.clientX, window.innerWidth - 170),
              y: Math.min(e.clientY, window.innerHeight - 96),
              sessionId: session.id,
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activateSession(session.id);
            }
          }}
        >
          <span className="tab-dot" data-testid={`tab-dot-${session.hostName}`} aria-hidden />
          {renamingId === session.id ? (
            <input
              className="tab-rename-input"
              data-testid={`tab-rename-${session.id}`}
              autoFocus
              value={renameDraft}
              placeholder={session.hostName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameDraft(e.currentTarget.value)}
              onBlur={() => {
                renameTab(session.id, renameDraft);
                setRenamingId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameTab(session.id, renameDraft);
                  setRenamingId(null);
                } else if (e.key === "Escape") {
                  setRenamingId(null);
                }
                e.stopPropagation();
              }}
            />
          ) : (
            <span
              className="tab-title"
              title={session.titleOverride ?? session.lastError ?? undefined}
            >
              {session.titleOverride ?? session.hostName}
            </span>
          )}
          {/* AI 诊断待看（方案 A）：后台失败不再抢当前视图，页签引导 */}
          {(() => {
            const ai = aiSessions[session.id];
            return ai?.request != null && !ai.seen ? (
              <span
                className="tab-ai-pending"
                data-testid={`tab-ai-pending-${session.hostName}`}
                aria-label={t("tabs.aiPendingBadge")}
                title={t("tabs.aiPendingBadge")}
              >
                AI
              </span>
            ) : null;
          })()}
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
      {tabMenu &&
        (() => {
          const menuSession = sessions.find((s) => s.id === tabMenu.sessionId);
          if (!menuSession) return null;
          const isLocalTab = menuSession.kind === "local";
          const connTarget = `${menuSession.username ? `${menuSession.username}@` : ""}${menuSession.address}:${menuSession.port}`;
          return (
            <>
              <div
                className="ctx-overlay"
                onMouseDown={() => setTabMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu(null);
                }}
              />
              <div
                className="ctx-menu"
                role="menu"
                style={{ left: tabMenu.x, top: tabMenu.y }}
                data-testid="tab-ctx-menu"
              >
                <button
                  role="menuitem"
                  className="ctx-menu-item"
                  data-testid="tab-ctx-rename"
                  onClick={() => {
                    setRenameDraft(menuSession.titleOverride ?? "");
                    setRenamingId(menuSession.id);
                    setTabMenu(null);
                  }}
                >
                  {t("tabs.rename")}
                </button>
                {!isLocalTab && (
                  <button
                    role="menuitem"
                    className="ctx-menu-item"
                    data-testid="tab-ctx-copy"
                    onClick={() => {
                      setTabMenu(null);
                      void copyText(connTarget).then(() =>
                        showToast(t("tabs.copyConnectionDone", { target: connTarget }), "info"),
                      );
                    }}
                  >
                    {t("tabs.copyConnection")}
                  </button>
                )}
              </div>
            </>
          );
        })()}
    </div>
  );
}
