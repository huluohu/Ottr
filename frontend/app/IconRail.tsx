// 48px 图标轨（2026-10-16 视觉重设计 M3「疏渠」，报告 §2「獭居·浮岛」）：
// 高频入口恒驻图标化——总览/文件/定时任务/告警/通知中心 + 未读徽标直接挂图标。
// 【空间锚点（报告 §4 导航断点）】toolDialog 打开时对应图标常驻 teal 光点
// （.rail-light，data-active 驱动）——弹框制式下左侧不再「无痕迹」。
// 【底部 Otty 球 = 设置入口】原侧栏左下角快捷菜单（ZCode 式 flyout）整体收编：
// 凭据/MCP/主题/语言/设置挂 Otty 球展开层，入口从「藏」变「露」。
// 弹层机制沿 v0.5.0 教训：外点判定的「内点」必须包含按钮与两层弹层（弹层
// 渲染在按钮之外，漏判会点选项的 mousedown 先卸载面板、click 永不触发）。
// macOS 融合式标题栏：红绿灯随图标轨移到窗口最左（titlebarInset 注入让位区）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useNotifyStore } from "../notify/core";
import { useTheme, type ThemeMode } from "../theme/ThemeContext";
import { useLanguage } from "../i18n";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useUpdateStore } from "../update/updateStore";

export interface IconRailProps {
  /** macOS 融合式标题栏（2026-10-14）：顶部让出红绿灯区并铺拖拽面。 */
  titlebarInset?: boolean;
  onOpenCredentials: () => void;
  onOpenSettings: () => void;
  onOpenMcpSettings: () => void;
  /** 更新钮点击：跳设置 → 关于（发现新版本时按钮才浮现）。 */
  onOpenUpdate: () => void;
}

function OverviewIcon() {
  // Lucide「activity」脉搏线（与原侧栏总览同源）。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.8 8h2.6l1.8-4.4L9.8 12.4 11.2 8h3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.4 1.6" strokeLinecap="round" />
    </svg>
  );
}

function InboxIcon() {
  // Lucide「inbox」收纳盒：通知中心（与告警的铃铛区分——告警是规则引擎，
  // 通知中心是投递收件箱，两者在旧侧栏共用铃铛易混）。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8.5h3l1 2h3l1-2h3" />
      <path d="M4.6 3.5h6.8l2.1 5v3.3c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6V8.5l2.1-5Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="10.5" cy="5.5" r="3.2" />
      <path d="M8.2 7.8 3 13v1.4h2.6v-1.6h1.6v-1.6h1.5l1.2-1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon() {
  // Lucide「settings」齿轮（同原侧栏，24 viewBox 齿廓 + 中孔）。
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.6-.7 1.6-1.5 0-.9-.7-1.3-.7-2 0-.7.6-1.3 1.4-1.3h1.5a2.4 2.4 0 0 0 2.4-2.4C14.2 4 11.4 1.8 8 1.8Z" />
      <circle cx="5.4" cy="6.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="6.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.8 3.9 2.8 6.2s-1 4.5-2.8 6.2C6.2 12.5 5.2 10.3 5.2 8S6.2 3.5 8 1.8Z" />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M5.5 2v3M10.5 2v3" />
      <path d="M3.5 5h9v2.6a4.5 4.5 0 0 1-9 0V5Z" />
      <path d="M8 12.1V14" />
    </svg>
  );
}

/** Otty 球（图标轨设置入口）：应用图标同构小样——teal 渐变底盘上墨色
 * 呆毛獭头（奶油宽吻 + 琥珀鼻 + 宽距豆豆眼）。底盘恒为品牌 teal，任何主题
 * 下与轨底都有对比（2026-10-16 用户反馈：墨色脸在深色主题撞色）。品牌资产
 * 场景直引 brand 色板（tokens.css 消费纪律的品牌资产豁免）。 */
function OttyBall() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="otty-ball-plate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2DD4BF" />
          <stop offset="1" stop-color="#0B7C6E" />
        </linearGradient>
        <clipPath id="otty-ball-clip">
          <circle cx="16" cy="16" r="14.5" />
        </clipPath>
      </defs>
      <circle cx="16" cy="16" r="14.5" fill="url(#otty-ball-plate)" />
      <g clipPath="url(#otty-ball-clip)">
        {/* 呆毛 */}
        <path d="M15.4 5.2 C 14.4 3.4 14.9 2 16.7 1.4 C 15.7 3 15.9 4.4 16.8 5.5 Z" fill="#0F172A" />
        {/* 双耳 */}
        <circle cx="8.2" cy="8.6" r="2.6" fill="#0F172A" />
        <circle cx="23.8" cy="8.6" r="2.6" fill="#0F172A" />
        {/* 宽圆头（微倾） */}
        <g transform="rotate(-3 16 18)">
          <path d="M 8.2 27.5 L 8.2 17.2 C 8.2 10 11.5 6.8 16 6.8 C 20.5 6.8 23.8 10 23.8 17.2 L 23.8 27.5 Z" fill="#0F172A" />
          {/* 奶油宽吻 + 琥珀鼻 */}
          <rect x="10.4" y="17.4" width="11.2" height="3.8" rx="1.9" fill="#F6E7D4" />
          <rect x="13.9" y="16.6" width="4.2" height="2" rx="1" fill="#F59E0B" />
          {/* 宽距豆豆眼（歪头一高一低） */}
          <circle cx="11.4" cy="14" r="1.2" fill="#0F172A" />
          <circle cx="20.6" cy="13.4" r="1.2" fill="#0F172A" />
        </g>
        {/* 白水线 */}
        <rect x="1.5" y="24.2" width="29" height="1.6" fill="#FFFFFF" opacity="0.9" />
      </g>
    </svg>
  );
}

function LockIcon() {
  // Lucide「lock」挂锁（16 viewBox 同族线宽）——锁定 = 立即锁库（同 ⌘ 菜单
  // 「立即锁定」/vault.lock 语义），非「凭据」的钥匙语义（KeyIcon 留给凭据）。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
      <circle cx="8" cy="10.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ShuffleIcon() {
  // Lucide「shuffle」双向交换——端口转发（本地↔远端通道）语义。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4h2.6l6.8 8H14M14 4h-2.6l-2.2 2.6M2 12h2.6l2.2-2.6M11.4 4H14v0M11.4 12H14v0" />
      <path d="M12 2l2 2-2 2M12 10l2 2-2 2" />
    </svg>
  );
}

function NetworkIcon() {
  // 分支节点——跳板链（多级跳板拓扑）语义。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.8" />
      <circle cx="12.5" cy="3.5" r="1.8" />
      <circle cx="12.5" cy="12.5" r="1.8" />
      <path d="M5.3 7.2 L10.8 4.2 M5.3 8.8 L10.8 11.8" />
    </svg>
  );
}

function UpdateIcon() {
  // Lucide「arrow-down-to-line」下载落线——有新版本待取。
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7" />
      <path d="M3 13.5h10" />
    </svg>
  );
}

/** 主题快捷循环顺序（水域家族光量降序，与 THEME_IDS 同序）。 */
const THEME_CYCLE: readonly ThemeMode[] = [
  "system",
  "light",
  "verdant",
  "dark",
  "oled",
  "amethyst",
  "glass",
];

export function IconRail({ titlebarInset, onOpenUpdate, onOpenCredentials, onOpenSettings, onOpenMcpSettings }: IconRailProps) {
  const { t } = useTranslation();
  const mainView = useWorkspaceStore((s) => s.mainView);
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  const overviewOpen = useWorkspaceStore((s) => s.overviewOpen);
  const openOverview = useWorkspaceStore((s) => s.openOverview);
  const unread = useNotifyStore((s) => s.unread);
  // 更新可用（2026-10-17 用户需求：发现新版本在图标轨体现）——phase 驱动，
  // 按钮仅在有新版本待取时浮现；点击跳设置 → 关于（唯一权威进度面）。
  const updateAvailableVersion = useUpdateStore((s) =>
    s.phase.kind === "available" ? s.phase.version : null,
  );
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  // Otty 球弹层（原侧栏快捷菜单机制整体迁入）：底部锚定、子面板右并排。
  const [menu, setMenu] = useState<null | "main">(null);
  const [sub, setSub] = useState<null | "theme" | "lang">(null);
  const [flyoutPos, setFlyoutPos] = useState({ bottom: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const subFlyoutRef = useRef<HTMLDivElement | null>(null);

  const openOttyMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 弹层贴 Otty 球右侧弹出（不盖图标轨——空间锚点光点保持可见）；
    // 底边与球对齐。子面板再右并排（+208，沿侧栏旧制）。
    setFlyoutPos({ bottom: window.innerHeight - rect.bottom, left: rect.right + 8 });
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
    <nav className="icon-rail" aria-label={t("nav.aria")} data-testid="icon-rail">
      {titlebarInset && (
        <div className="titlebar-inset" data-tauri-drag-region aria-hidden="true" />
      )}
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-overview"
        data-active={overviewOpen && mainView === "overview"}
        title={t("overview.title")}
        aria-label={t("overview.title")}
        onClick={openOverview}
      >
        <span className="rail-light" aria-hidden />
        <OverviewIcon />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-cron"
        data-active={mainView === "cron"}
        title={t("nav.cron")}
        aria-label={t("nav.cron")}
        onClick={() => openMainView("cron")}
      >
        <span className="rail-light" aria-hidden />
        <ClockIcon />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-notifications"
        data-active={mainView === "notifications"}
        title={t("nav.notifications")}
        aria-label={t("nav.notifications")}
        onClick={() => openMainView("notifications")}
      >
        <span className="rail-light" aria-hidden />
        <InboxIcon />
        {unread > 0 && (
          <span className="rail-badge" data-testid="rail-unread">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-forwards"
        data-active={mainView === "forwards"}
        title={t("forward.title")}
        aria-label={t("forward.title")}
        onClick={() => openMainView("forwards")}
      >
        <span className="rail-light" aria-hidden />
        <ShuffleIcon />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-jumpchains"
        data-active={mainView === "jumpchains"}
        title={t("jump.title")}
        aria-label={t("jump.title")}
        onClick={() => openMainView("jumpchains")}
      >
        <span className="rail-light" aria-hidden />
        <NetworkIcon />
      </button>
      <div className="rail-spacer" aria-hidden />
      {/* 更新钮（2026-10-17 用户需求）：发现新版本时浮现，点击跳设置 →
          关于（完整进度面）；amber 圆点为奖赏色信号。闲置时轨道保持干净。 */}
      {updateAvailableVersion !== null && (
        <button
          type="button"
          className="rail-btn rail-update"
          data-testid="rail-update"
          title={t("nav.updateAvailable", { version: updateAvailableVersion })}
          aria-label={t("nav.updateAvailable", { version: updateAvailableVersion })}
          onClick={onOpenUpdate}
        >
          <UpdateIcon />
          <span className="rail-update-dot" aria-hidden />
        </button>
      )}
      <div className="rail-spacer" aria-hidden />
      {/* 锁定（2026-10-16 用户需求：控制中心旁的锁定入口）——立即锁库，
          与原生菜单「立即锁定」同一动作（vault.lock）。 */}
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-lock"
        title={t("security.lockNow")}
        aria-label={t("security.lockNow")}
        onClick={() => void useVaultLockStore.getState().lock()}
      >
        <LockIcon />
      </button>
      {/* Otty 球：设置入口（原侧栏快捷菜单收编），水獭脸圆钮。 */}
      <button
        type="button"
        className="rail-btn rail-otty"
        ref={btnRef}
        data-testid="rail-otty"
        data-expanded={menu !== null}
        aria-expanded={menu !== null}
        title={t("nav.quickMenu")}
        aria-label={t("nav.quickMenu")}
        onClick={openOttyMenu}
      >
        <OttyBall />
      </button>
      {menu === "main" && (
        <div
          className="rail-flyout-backdrop"
          data-testid="rail-flyout-backdrop"
          onMouseDown={() => {
            setMenu(null);
            setSub(null);
          }}
        />
      )}
      {menu === "main" && (
        <div
          ref={flyoutRef}
          className="sidebar-flyout rail-flyout"
          data-testid="rail-flyout-main"
          style={{ bottom: flyoutPos.bottom, left: flyoutPos.left }}
        >
          <button
            type="button"
            data-testid="rail-nav-credentials"
            onClick={() => {
              setMenu(null);
              setSub(null);
              onOpenCredentials();
            }}
          >
            <KeyIcon />
            <span>{t("nav.credentials")}</span>
          </button>
          <button
            type="button"
            data-testid="rail-nav-mcp"
            onClick={() => {
              setMenu(null);
              setSub(null);
              onOpenMcpSettings();
            }}
          >
            <PlugIcon />
            <span>{t("nav.mcp")}</span>
          </button>
          <div className="sidebar-flyout-sep" />
          <button
            type="button"
            data-testid="rail-theme"
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
            data-testid="rail-lang"
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
            data-testid="rail-nav-settings"
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
      {/* 子面板（主题/语言）：主弹层右侧并排弹出，主菜单保持可见（2026-10-12
          用户反馈：子列表不应替换主菜单）。选即留场（连续预览），点外/Esc 全收。 */}
      {menu === "main" && sub !== null && (
        <div
          ref={subFlyoutRef}
          className="sidebar-flyout rail-flyout"
          data-testid={`rail-flyout-${sub}`}
          style={{ bottom: flyoutPos.bottom, left: flyoutPos.left + 208 }}
        >
          {sub === "theme" &&
            THEME_CYCLE.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`rail-theme-${id}`}
                data-checked={themeMode === id}
                onClick={() => setMode(id) /* 选中留场（2026-10-14 用户裁定），点外/Esc 才收 */}
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
                data-testid={`rail-lang-${id}`}
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
    </nav>
  );
}
