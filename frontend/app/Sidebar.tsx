// 应用级侧栏（2026-10-10 壳层重构；2026-10-16 视觉重设计 M3 瘦身）：
// 快捷连接（⌘K 搜索行）+ 主机区（HostTree 原样嵌入：分组树/导入/分组悬停
// 加主机）。原功能导航与底部快捷菜单已迁 app/IconRail（48px 图标轨 + Otty 球
// 设置入口，入口从「藏」变「露」）；主机面板宽度仍由 App 侧 resizer 持有。
// 折叠胶囊（⌘\，2026-10-16 M3）：整列折叠成 64px 悬浮胶囊——只显示搜索圆钮 +
// 分组圆点（组色）+ 未读徽标；折叠态不渲染 HostTree（树交互全收起）。
import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { HostTree, type HostTreeProps } from "../hosts/HostTree";
import { useVaultStore } from "../vault/store";
import { useNotifyStore } from "../notify/core";
import { useWorkspaceStore } from "../workspace/workspaceStore";

export interface SidebarProps extends HostTreeProps {
  /** 壳层宽度（App 侧拖拽 resizer 持有；折叠胶囊态 = 64）。 */
  style?: CSSProperties;
  /** 折叠胶囊（⌘\）：只显示搜索圆钮 + 分组圆点 + 未读徽标。 */
  collapsed?: boolean;
  /** 折叠态「展开」按钮回调（2026-10-20 用户反馈：胶囊态此前无任何可点的
   *  展开入口，只能记快捷键/翻菜单）。 */
  onExpand?: () => void;
  /** macOS 融合式标题栏（2026-10-14）：顶部让出红绿灯区并铺拖拽面。
   * Win/Linux 自绘标题栏承担窗口壳，不注入。 */
  titlebarInset?: boolean;
  /** ⌘K 全局搜索（命令面板：主机 + 命令）。 */
  onQuickConnect: () => void;
  /** 新建分组：HostTree 分组输入展开（信号递增链）。 */
  onNewGroup: () => void;
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

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4Z" />
      <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  );
}

export function Sidebar({
  style,
  collapsed = false,
  onExpand,
  titlebarInset,
  onQuickConnect,
  onNewGroup,
  onAdd,
  ...tree
}: SidebarProps) {
  const { t } = useTranslation();
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  // 折叠胶囊数据面（hooks 恒定，分支只裁渲染）：组列表（组色圆点）+ 未读。
  const hostGroups = useVaultStore((s) => s.hostGroups);
  const hosts = useVaultStore((s) => s.hosts);
  const unread = useNotifyStore((s) => s.unread);
  const hasUngrouped = hosts.some((h) => h.group_id == null);

  if (collapsed) {
    return (
      <aside
        className="sidebar sidebar-v2 sidebar-capsule"
        style={style}
        data-testid="app-sidebar"
        data-collapsed="true"
      >
        {titlebarInset && (
          <div className="titlebar-inset" data-tauri-drag-region aria-hidden="true" />
        )}
        <button
          type="button"
          className="capsule-search"
          data-testid="sidebar-search"
          title={t("sidebar.search")}
          aria-label={t("sidebar.search")}
          onClick={onQuickConnect}
        >
          <SearchIcon />
        </button>
        {/* 组圆点列（组色；未分组桶有主机时补一枚墨点）。悬浮 title 报组名。 */}
        <div className="capsule-hosts" data-testid="sidebar-capsule-hosts">
          {hostGroups.map((g) => (
            <span
              key={g.id}
              className="capsule-dot"
              title={g.name}
              style={g.color ? { background: g.color } : undefined}
            />
          ))}
          {hasUngrouped && <span className="capsule-dot capsule-dot-plain" title={t("hostTree.ungrouped")} />}
        </div>
        <div className="capsule-spacer" aria-hidden />
        {onExpand && (
          <button
            type="button"
            className="capsule-expand"
            data-testid="sidebar-expand"
            title={t("sidebar.expand")}
            aria-label={t("sidebar.expand")}
            onClick={onExpand}
          >
            »
          </button>
        )}
        {unread > 0 && (
          <button
            type="button"
            className="capsule-unread"
            data-testid="sidebar-unread"
            title={t("nav.notifications")}
            aria-label={t("nav.notifications")}
            onClick={() => openMainView("notifications")}
          >
            <BellIcon />
            <span className="capsule-unread-badge">{unread > 99 ? "99+" : unread}</span>
          </button>
        )}
      </aside>
    );
  }

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
    </aside>
  );
}
