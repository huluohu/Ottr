// 应用级侧栏（2026-10-10 壳层重构）：单列宽侧栏三段式——
// ①快捷连接 ②主机区（HostTree 原样嵌入：搜索/分组树/导入/分组悬停加主机）
// ③功能导航（定时任务/告警/MCP/通知中心）+ 底部设置。导航项点击 = 既有
// openDock 直派（dock 单槽保留）；通知中心 = App 受控浮层开关；设置 = 对话框。
import { useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { HostTree, type HostTreeProps } from "../hosts/HostTree";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import type { DockPanel } from "../workspace/types";
import { useNotifyStore } from "../notify/core";
import { useTheme, type ThemeMode } from "../theme/ThemeContext";
import { useLanguage } from "../i18n";

/** 主题快捷循环顺序（与设置页七主题一致）。 */
const THEME_CYCLE: readonly ThemeMode[] = [
  "system",
  "light",
  "dark",
  "oled",
  "amethyst",
  "verdant",
  "glass",
];

export interface SidebarProps extends HostTreeProps {
  /** 壳层宽度（App 侧拖拽 resizer 持有）。 */
  style?: CSSProperties;
  /** ⌘K 快速连接（命令面板）。 */
  onQuickConnect: () => void;
  onOpenSettings: () => void;
  onToggleNotifications: () => void;
  notificationsOpen: boolean;
}

function ClockIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.4 1.6" strokeLinecap="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4Z" />
      <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M5.5 2v3M10.5 2v3" />
      <path d="M3.5 5h9v2.6a4.5 4.5 0 0 1-9 0V5Z" />
      <path d="M8 12.1V14" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.6-.7 1.6-1.5 0-.9-.7-1.3-.7-2 0-.7.6-1.3 1.4-1.3h1.5a2.4 2.4 0 0 0 2.4-2.4C14.2 4 11.4 1.8 8 1.8Z" />
      <circle cx="5.4" cy="6.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="6.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.8 3.9 2.8 6.2s-1 4.5-2.8 6.2C6.2 12.5 5.2 10.3 5.2 8S6.2 3.5 8 1.8Z" />
    </svg>
  );
}

const NAV_DOCK: ReadonlyArray<{ panel: DockPanel; labelKey: string; icon: ReactElement }> = [
  { panel: "cron", labelKey: "nav.cron", icon: <ClockIcon /> },
  { panel: "alerts", labelKey: "nav.alerts", icon: <BellIcon /> },
  { panel: "mcp", labelKey: "nav.mcp", icon: <PlugIcon /> },
];

export function Sidebar({
  style,
  onQuickConnect,
  onOpenSettings,
  onToggleNotifications,
  notificationsOpen,
  ...tree
}: SidebarProps) {
  const { t } = useTranslation();
  const openDock = useWorkspaceStore((s) => s.openDock);
  const dockPanel = useWorkspaceStore((s) => s.dockPanel);
  const unread = useNotifyStore((s) => s.unread);
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  // 子菜单展开态（ZCode 式：导航行点击展开内嵌选项列表，勾选当前项；
  // 再点行首收起，互斥只开一个）。
  const [expanded, setExpanded] = useState<"none" | "theme" | "lang">("none");
  const toggleExpanded = (id: "theme" | "lang") =>
    setExpanded((cur) => (cur === id ? "none" : id));

  return (
    <aside className="sidebar sidebar-v2" style={style} data-testid="app-sidebar">
      <div className="sidebar-quick">
        <button
          type="button"
          className="btn-accent"
          data-testid="sidebar-quick-connect"
          onClick={onQuickConnect}
        >
          <span>{t("sidebar.quickConnect")}</span>
          <kbd className="sidebar-kbd">⌘K</kbd>
        </button>
      </div>
      <div className="sidebar-hosts">
        <HostTree {...tree} />
      </div>
      <nav className="sidebar-nav" aria-label={t("nav.aria")}>
        {/* 界面主题：行点击展开内嵌子选项（勾选当前项） */}
        <button
          type="button"
          data-testid="sidebar-theme"
          data-expanded={expanded === "theme"}
          aria-expanded={expanded === "theme"}
          onClick={() => toggleExpanded("theme")}
        >
          <PaletteIcon />
          <span>{t("nav.theme")}</span>
          <svg
            className={`sidebar-chevron${expanded === "theme" ? " open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        {expanded === "theme" && (
          <div className="sidebar-submenu" data-testid="sidebar-submenu-theme">
            {THEME_CYCLE.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-theme-${id}`}
                data-checked={themeMode === id}
                onClick={() => setMode(id)}
              >
                <span>{t(`settings.themes.${id}`)}</span>
                {themeMode === id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        {/* 界面语言：中英切换（勾选当前项） */}
        <button
          type="button"
          data-testid="sidebar-lang"
          data-expanded={expanded === "lang"}
          aria-expanded={expanded === "lang"}
          onClick={() => toggleExpanded("lang")}
        >
          <GlobeIcon />
          <span>{t("nav.language")}</span>
          <svg
            className={`sidebar-chevron${expanded === "lang" ? " open" : ""}`}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        {expanded === "lang" && (
          <div className="sidebar-submenu" data-testid="sidebar-submenu-lang">
            {(["zh-CN", "en-US"] as const).map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-lang-${id}`}
                data-checked={lang === id}
                onClick={() => setLang(id)}
              >
                <span>{id === "zh-CN" ? "中文" : "English"}</span>
                {lang === id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        {NAV_DOCK.map((item) => (
          <button
            key={item.panel}
            type="button"
            data-testid={`sidebar-nav-${item.panel}`}
            data-active={dockPanel === item.panel}
            onClick={() => openDock(item.panel)}
          >
            {item.icon}
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
        <button
          type="button"
          data-testid="sidebar-nav-notifications"
          data-open={notificationsOpen}
          onClick={onToggleNotifications}
        >
          <BellIcon />
          <span>{t("nav.notifications")}</span>
          {unread > 0 && (
            <span className="sidebar-nav-badge" data-testid="sidebar-unread">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </nav>
      <div className="sidebar-foot">
        <button type="button" data-testid="sidebar-nav-settings" onClick={onOpenSettings}>
          <GearIcon />
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
