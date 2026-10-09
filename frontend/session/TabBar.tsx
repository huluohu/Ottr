// TabBar（Task 7，A6）：多会话标签条。每标签一枚状态灯——
//   connected=绿 / reconnecting=黄 / waiting_host_key=橙 / 其他=灰；
// 重连中展示 第 n/max 次；关标签（✕）= disconnect（drop_session，不重连）。
// 主题纪律：颜色只引用 --color-* 语义层（见 App.css .tab-dot）。
import { useTranslation } from "react-i18next";
import { useSessionStore, type Session } from "./SessionStore";

export function TabBar() {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setActive = useSessionStore((s) => s.setActive);
  const closeTab = useSessionStore((s) => s.closeTab);
  const max = useSessionStore((s) => s.settings.maxReconnectAttempts);

  // 只渲染标签根会话（paneOf=null）：分屏 pane 属标签内部布局，不进标签条（Task 8）
  const tabs = sessions.filter((s) => s.paneOf === null);
  if (tabs.length === 0) return null;

  return (
    <div className="tabbar" role="tablist" aria-label={t("tabs.list")}>
      {tabs.map((session: Session) => (
        <div
          key={session.id}
          role="tab"
          tabIndex={0}
          aria-selected={session.id === activeId}
          data-active={session.id === activeId}
          data-status={session.status}
          data-testid={`tab-${session.hostName}`}
          className="tab"
          onClick={() => setActive(session.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActive(session.id);
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
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
