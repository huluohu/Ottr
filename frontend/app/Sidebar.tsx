// 应用级侧栏（2026-10-10 壳层重构）：单列宽侧栏三段式——
// ①快捷连接 ②主机区（HostTree 原样嵌入：搜索/分组树/导入/分组悬停加主机）
// ③功能导航（定时任务/告警/MCP/通知中心）+ 底部设置。导航项点击 = 既有
// openDock 直派（dock 单槽保留）；通知中心 = App 受控浮层开关；设置 = 对话框。
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { HostTree, type HostTreeProps } from "../hosts/HostTree";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import type { ToolDockPanel } from "../workspace/types";
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
  /** ⌘K 全局搜索（命令面板：主机 + 命令）。 */
  onQuickConnect: () => void;
  /** 凭据管理（对话框：凭据/密钥/known_hosts 三页签）。 */
  onOpenCredentials: () => void;
  /** 新建分组：HostTree 分组输入展开（信号递增链）。 */
  onNewGroup: () => void;
  onOpenSettings: () => void;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.6l1.4 1.6h5c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z" />
      <path d="M8 7.2v3.2M6.4 8.8h3.2" />
    </svg>
  );
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

function KeyIcon() {
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="10.5" cy="5.5" r="3.2" />
      <path d="M8.2 7.8 3 13v1.4h2.6v-1.6h1.6v-1.6h1.5l1.2-1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const NAV_DOCK: ReadonlyArray<{ panel: ToolDockPanel; labelKey: string; icon: ReactElement }> = [
  { panel: "cron", labelKey: "nav.cron", icon: <ClockIcon /> },
  { panel: "alerts", labelKey: "nav.alerts", icon: <BellIcon /> },
  { panel: "mcp", labelKey: "nav.mcp", icon: <PlugIcon /> },
  { panel: "notifications", labelKey: "nav.notifications", icon: <BellIcon /> },
];

export function Sidebar({
  style,
  onQuickConnect,
  onOpenCredentials,
  onNewGroup,
  onOpenSettings,
  onAdd,
  ...tree
}: SidebarProps) {
  const { t } = useTranslation();
  const toggleDock = useWorkspaceStore((s) => s.toggleDock);
  const dockActive = useWorkspaceStore((s) => s.dockActive);
  const unread = useNotifyStore((s) => s.unread);
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  // 子菜单（ZCode 式 flyout）：行点击在行侧弹出**浮动**选项面板——不改变
  // 侧栏自身布局（内嵌展开会把下方导航项顶下去，2026-10-10 用户裁定不对）；
  // **选即关**（原生菜单语义），点外/Esc 同样收起；两菜单互斥。
  const [menu, setMenu] = useState<null | "theme" | "lang">(null);
  const [flyoutPos, setFlyoutPos] = useState({ top: 0, left: 0 });
  const navRef = useRef<HTMLDivElement | null>(null);
  // 浮层面板 ref：外点关闭的「内点」判定必须包含面板——面板渲染在 nav 之外
  // （fixed 锚定），漏判会导致点选项的 mousedown 先把面板卸载、click 永远
  // 不触发（v0.5.0 实测「选了没反应」的根因）。
  const flyoutRef = useRef<HTMLDivElement | null>(null);

  const toggleMenu = (id: "theme" | "lang") => (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 锚定行右侧；底部空间不足时整体上移（主题 7 项约 270px 高）。
    const top = Math.min(rect.top, Math.max(8, window.innerHeight - 290));
    setFlyoutPos({ top, left: rect.right + 8 });
    setMenu((cur) => (cur === id ? null : id));
  };

  useEffect(() => {
    if (menu === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (navRef.current?.contains(target)) return; // 行内点击不关
      if (flyoutRef.current?.contains(target)) return; // 面板内点击不关（否则 click 被卸载吞掉）
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <aside className="sidebar sidebar-v2" style={style} data-testid="app-sidebar">
      {/* 搜索 = 标准输入框形（放大镜 + ⌘K 右嵌）；点击呼出 ⌘K 面板。 */}
      <div className="sidebar-quick">
        <button
          type="button"
          className="sidebar-search"
          data-testid="sidebar-search"
          onClick={onQuickConnect}
        >
          <SearchIcon />
          <span className="sidebar-search-text">{t("sidebar.search")}</span>
          <kbd className="sidebar-kbd">⌘K</kbd>
        </button>
      </div>
      {/* 主机区头部：区段标签 + 安静图标钮（新建入口，2026-10-10 深夜布局
          裁定——描边盒三连改区段头图标；分组点击展开树内 inline 输入）。 */}
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">{t("hostTree.sectionTitle")}</span>
        <button
          type="button"
          className="sidebar-section-btn"
          data-testid="sidebar-add-host"
          title={t("hostTree.addHost")}
          aria-label={t("hostTree.addHost")}
          onClick={() => onAdd?.(null)}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className="sidebar-section-btn"
          data-testid="sidebar-add-group"
          title={t("hostTree.addGroup")}
          aria-label={t("hostTree.addGroup")}
          onClick={onNewGroup}
        >
          <FolderPlusIcon />
        </button>
      </div>
      <div className="sidebar-hosts">
        <HostTree {...tree} onAdd={onAdd} />
      </div>
      <nav className="sidebar-nav" ref={navRef} aria-label={t("nav.aria")}>
        {/* 界面主题：行点击弹出浮动选项面板（勾选当前项） */}
        <button
          type="button"
          data-testid="sidebar-theme"
          data-expanded={menu === "theme"}
          aria-expanded={menu === "theme"}
          onClick={toggleMenu("theme")}
        >
          <PaletteIcon />
          <span>{t("nav.theme")}</span>
          <svg
            className={`sidebar-chevron${menu === "theme" ? " open" : ""}`}
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
        {/* 界面语言：中英切换（勾选当前项） */}
        <button
          type="button"
          data-testid="sidebar-lang"
          data-expanded={menu === "lang"}
          aria-expanded={menu === "lang"}
          onClick={toggleMenu("lang")}
        >
          <GlobeIcon />
          <span>{t("nav.language")}</span>
          <svg
            className={`sidebar-chevron${menu === "lang" ? " open" : ""}`}
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
        {NAV_DOCK.map((item) => (
          <button
            key={item.panel}
            type="button"
            data-testid={`sidebar-nav-${item.panel}`}
            data-active={dockActive === item.panel}
            onClick={() => toggleDock(item.panel)}
          >
            {item.icon}
            <span>{t(item.labelKey)}</span>
            {item.panel === "notifications" && unread > 0 && (
              <span className="sidebar-nav-badge" data-testid="sidebar-unread">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          data-testid="sidebar-nav-credentials"
          onClick={onOpenCredentials}
        >
          <KeyIcon />
          <span>{t("nav.credentials")}</span>
        </button>
      </nav>
      {/* 子菜单浮层（fixed 锚定行侧；选即关/点外关/Esc 关） */}
      {menu !== null && (
        <div
          ref={flyoutRef}
          className="sidebar-flyout"
          data-testid={`sidebar-flyout-${menu}`}
          style={{ top: flyoutPos.top, left: flyoutPos.left }}
        >
          {menu === "theme" &&
            THEME_CYCLE.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-theme-${id}`}
                data-checked={themeMode === id}
                onClick={() => {
                  setMode(id);
                  setMenu(null);
                }}
              >
                <span>{t(`settings.themes.${id}`)}</span>
                {themeMode === id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </button>
            ))}
          {menu === "lang" &&
            (["zh-CN", "en-US"] as const).map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-lang-${id}`}
                data-checked={lang === id}
                onClick={() => {
                  setLang(id);
                  setMenu(null);
                }}
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
      <div className="sidebar-foot">
        <button type="button" data-testid="sidebar-nav-settings" onClick={onOpenSettings}>
          <GearIcon />
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </aside>
  );
}
