// 应用级侧栏（2026-10-10 壳层重构）：单列宽侧栏三段式——
// ①快捷连接 ②主机区（HostTree 原样嵌入：搜索/分组树/导入/分组悬停加主机）
// ③功能导航（定时任务/告警/MCP/通知中心）+ 底部设置。导航项点击 = 既有
// toggleToolDialog 直派（工具面板统一弹框，同值再点 = 关）；设置 = 对话框。
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
  /** macOS 融合式标题栏（2026-10-14）：顶部让出红绿灯区并铺拖拽面
   * （tauri.conf.json titleBarStyle=Overlay；高度与背景见 12-titlebar-theme.css）。
   * Win/Linux 自绘标题栏承担窗口壳，不注入。 */
  titlebarInset?: boolean;
  /** ⌘K 全局搜索（命令面板：主机 + 命令）。 */
  onQuickConnect: () => void;
  /** 凭据管理（对话框：凭据/密钥/known_hosts 三页签）。 */
  onOpenCredentials: () => void;
  /** 新建分组：HostTree 分组输入展开（信号递增链）。 */
  onNewGroup: () => void;
  onOpenSettings: () => void;
  onOpenMcpSettings: () => void;
}

function GridIcon() {
  // 四宫格（2×2 圆角方块）：macOS 控制中心/Launchpad 同族语义。
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.2" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.2" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.2" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.2" />
    </svg>
  );
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
  // Lucide「settings」齿轮（24 viewBox，齿廓 + 中孔）；旧细辐条版视觉上
  // 像太阳/色轮（用户误读为主题概念，2026-10-12 反馈）。
  return (
    <svg className="sidebar-nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
// mcp 行特殊：面板已并入设置页（2026-10-14 单一家裁定），点击走 onOpenSettings
// 并以 URL 无关的 store 信号打开 MCP 分区——此处 panel 值仅作 key/active 标记。
const NAV_DOCK: ReadonlyArray<{
  panel: ToolDockPanel | "mcp";
  labelKey: string;
  icon: ReactElement;
}> = [
  { panel: "cron", labelKey: "nav.cron", icon: <ClockIcon /> },
  { panel: "alerts", labelKey: "nav.alerts", icon: <BellIcon /> },
  { panel: "mcp", labelKey: "nav.mcp", icon: <PlugIcon /> },
  { panel: "notifications", labelKey: "nav.notifications", icon: <BellIcon /> },
];

export function Sidebar({
  style,
  titlebarInset,
  onQuickConnect,
  onOpenCredentials,
  onNewGroup,
  onOpenSettings,
  onOpenMcpSettings,
  onAdd,
  ...tree
}: SidebarProps) {
  const { t } = useTranslation();
  const toggleToolDialog = useWorkspaceStore((s) => s.toggleToolDialog);
  const toolDialog = useWorkspaceStore((s) => s.toolDialog);
  const unread = useNotifyStore((s) => s.unread);
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  // 左下角快捷菜单（ZCode 式，2026-10-12 用户裁定）：底部单按钮，点击向上
  // 弹出全部入口（工具/凭据/主题/语言/设置）；主题/语言在弹层内就地切换
  // 子列表（底部锚定不变）；选即关/点外关/Esc 关。外点判定的「内点」必须
  // 包含按钮与弹层——弹层渲染在按钮之外，漏判会点选项的 mousedown 先卸载
  // 面板、click 永不触发（v0.5.0 教训）。
  const [menu, setMenu] = useState<null | "main">(null);
  const [sub, setSub] = useState<null | "theme" | "lang">(null);
  const [flyoutPos, setFlyoutPos] = useState({ bottom: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // 浮层面板 ref：外点关闭的「内点」判定必须包含面板——面板渲染在 nav 之外
  // （fixed 锚定），漏判会导致点选项的 mousedown 先把面板卸载、click 永远
  // 不触发（v0.5.0 实测「选了没反应」的根因）。
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const subFlyoutRef = useRef<HTMLDivElement | null>(null);

  const openQuickMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 底部锚定向上弹出：bottom = 视口高 - 按钮顶 - 间距（弹层高度无关，
    // 永远贴按钮上方）。
    setFlyoutPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left });
    setSub(null);
    setMenu((cur) => (cur === "main" ? null : "main"));
  };

  useEffect(() => {
    if (menu === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return; // 按钮点击不关（交给 onClick 翻转）
      if (flyoutRef.current?.contains(target)) return; // 主面板内点击不关（交给行 onClick）
      if (subFlyoutRef.current?.contains(target)) return; // 子面板内点击不关
      setMenu(null);
      setSub(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setSub(null);
      }
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
      {/* 融合式标题栏拖拽面（mac 专属注入）：覆盖侧栏顶部红绿灯让位区。
          data-tauri-drag-region 只在命中本元素时起拖——无子元素不挡交互。 */}
      {titlebarInset && (
        <div className="titlebar-inset" data-tauri-drag-region aria-hidden="true" />
      )}
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
      {/* 左下角快捷菜单（ZCode 式）：底部单按钮，点击向上弹出全部入口。 */}
      <div className="sidebar-foot">
        <button
          type="button"
          ref={btnRef}
          data-testid="sidebar-quickmenu"
          data-expanded={menu !== null}
          aria-expanded={menu !== null}
          onClick={openQuickMenu}
        >
          <GridIcon />
          <span>{t("nav.quickMenu")}</span>
        </button>
      </div>
      {menu === "main" && (
        <div
          ref={flyoutRef}
          className="sidebar-flyout"
          data-testid="sidebar-flyout-main"
          style={{ bottom: flyoutPos.bottom, left: flyoutPos.left }}
        >
          {NAV_DOCK.map((item) => (
            <button
              key={item.panel}
              type="button"
              data-testid={`sidebar-nav-${item.panel}`}
              data-active={toolDialog === item.panel}
              onClick={() => {
                if (item.panel === "mcp") {
                  onOpenMcpSettings();
                } else {
                  toggleToolDialog(item.panel);
                }
                setMenu(null);
                setSub(null);
              }}
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
            onClick={() => {
              setMenu(null);
              setSub(null);
              onOpenCredentials();
            }}
          >
            <KeyIcon />
            <span>{t("nav.credentials")}</span>
          </button>
          <div className="sidebar-flyout-sep" />
          <button
            type="button"
            data-testid="sidebar-theme"
            data-expanded={sub === "theme"}
            onClick={() => setSub((cur) => (cur === "theme" ? null : "theme"))}
          >
            <PaletteIcon />
            <span>{t("nav.theme")}</span>
            <svg
              className={`sidebar-chevron${sub === "theme" ? " open" : ""}`}
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
          <button
            type="button"
            data-testid="sidebar-lang"
            data-expanded={sub === "lang"}
            onClick={() => setSub((cur) => (cur === "lang" ? null : "lang"))}
          >
            <GlobeIcon />
            <span>{t("nav.language")}</span>
            <svg
              className={`sidebar-chevron${sub === "lang" ? " open" : ""}`}
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
          <button
            type="button"
            data-testid="sidebar-nav-settings"
            onClick={() => {
              setMenu(null);
              setSub(null);
              onOpenSettings();
            }}
          >
            <GearIcon />
            <span>{t("nav.settings")}</span>
          </button>
        </div>
      )}
      {/* 子面板（主题/语言选项）：锚定主弹层右侧并排弹出——主菜单保持可见
          （2026-10-12 用户反馈：子列表不应替换主菜单）。选即全关。 */}
      {menu === "main" && sub !== null && (
        <div
          ref={subFlyoutRef}
          className="sidebar-flyout"
          data-testid={`sidebar-flyout-${sub}`}
          style={{ bottom: flyoutPos.bottom, left: flyoutPos.left + 208 }}
        >
          {sub === "theme" &&
            THEME_CYCLE.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-theme-${id}`}
                data-checked={themeMode === id}
                onClick={() => setMode(id) /* 选中留场（2026-10-14 用户裁定：连续预览/切换），点外/Esc 才收 */}
              >
                <span>{t(`settings.themes.${id}`)}</span>
                {themeMode === id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 8.5 6.5 12 13 4.5" />
                  </svg>
                )}
              </button>
            ))}
          {sub === "lang" &&
            (["zh-CN", "en-US"] as const).map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`sidebar-lang-${id}`}
                data-checked={lang === id}
                onClick={() => setLang(id) /* 选中留场，同主题子面板 */}
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
    </aside>
  );
}
