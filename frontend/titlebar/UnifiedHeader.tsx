import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ACTIONS,
  shortcutLabel,
  type ActionDef,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { FEATURE_COMMANDS } from "../shortcuts/toolsRegistry";
import type { SnapLayoutId } from "./TitleBar";

export interface WindowControls {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

export interface UnifiedHeaderProps {
  /** 平台；测试可注入。默认 win。 */
  plat?: Platform;
  /** 动作分派（收口到 App.handleAction）。 */
  onAction: (action: string) => void;
  /** 贴靠分派（win：最大化按钮 hover 弹选择器；缺省 = 不启用）。 */
  onSnap?: (layout: SnapLayoutId) => void;
  /** 快捷搜索胶囊点击（默认呼出 ⌘K / Ctrl+K 命令面板）。 */
  onOpenPalette?: () => void;
  /** 命令表；默认 registry ACTIONS（测试可注入缩表）。 */
  actions?: readonly ActionDef[];
  /** 窗口控制面；默认 Tauri getCurrentWindow()（测试注入 stub）。 */
  win?: WindowControls;
}

function defaultControls(): WindowControls {
  let w: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    w = getCurrentWindow();
  } catch {
    // 纯浏览器 dev-preview
  }
  return {
    minimize: () => w?.minimize().catch(() => {}),
    toggleMaximize: () => w?.toggleMaximize().catch(() => {}),
    close: () => w?.close().catch(() => {}),
  };
}

export function UnifiedHeader({
  plat = "win",
  onAction,
  onSnap,
  onOpenPalette,
  actions = ACTIONS,
  win,
}: UnifiedHeaderProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Win11 贴靠（最大化按钮 hover 350ms 弹选择器）
  const [snapOpen, setSnapOpen] = useState(false);
  const snapAnchorRef = useRef<HTMLDivElement>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapEnabled = plat === "win" && typeof onSnap === "function";

  const startSnapHover = () => {
    if (!snapEnabled) return;
    clearTimeout(snapTimer.current);
    snapTimer.current = setTimeout(() => setSnapOpen(true), 350);
  };
  const cancelSnapHover = () => clearTimeout(snapTimer.current);

  // 点外/Esc 收起贴靠
  useEffect(() => {
    if (!snapOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!snapAnchorRef.current?.contains(e.target as Node)) setSnapOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSnapOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [snapOpen]);

  useEffect(() => () => clearTimeout(snapTimer.current), []);

  // 点击标题栏外部收起汉堡菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const controls = win ?? defaultControls();
  const shortcutHint = (id: ActionId) => shortcutLabel(id, plat);

  function runAction(action: string) {
    setMenuOpen(false);
    onAction(action);
  }

  const isMac = plat === "mac";

  return (
    <header className="unified-header" ref={rootRef} data-testid="unified-header" data-plat={plat}>
      {/* 左侧区域：macOS 为红绿灯 76px 留白区；Win/Linux 为汉堡菜单 + Ottr 标识 */}
      {isMac ? (
        <div
          className="unified-header-traffic-safe"
          data-tauri-drag-region
          data-testid="unified-header-mac-traffic-safe"
          aria-hidden="true"
        />
      ) : (
        <div className="unified-header-left">
          <button
            type="button"
            className="titlebar-btn titlebar-menu-btn"
            data-testid="titlebar-menu-btn"
            aria-label={t("titlebar.menu")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ≡
          </button>
          <span className="unified-header-title">Ottr</span>
        </div>
      )}

      {/* 左侧可拖拽过渡区 */}
      <div className="unified-header-drag" data-tauri-drag-region aria-hidden="true" />

      {/* 中央：⌘K / Ctrl+K 搜索胶囊框 */}
      <button
        type="button"
        className="unified-header-search"
        data-testid="unified-header-search"
        aria-label={t("palette.placeholder")}
        onClick={onOpenPalette}
      >
        <svg
          className="search-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="search-text">{t("palette.placeholder")}</span>
        <span className="search-kbd">{isMac ? "⌘K" : "Ctrl+K"}</span>
      </button>

      {/* 右侧可拖拽过渡区 */}
      <div className="unified-header-drag" data-tauri-drag-region aria-hidden="true" />

      {/* 右侧区域：macOS 为微标/右留白；Win/Linux 为标准控制按钮 */}
      {isMac ? (
        <div className="unified-header-mac-right" data-tauri-drag-region>
          <span className="unified-header-badge" aria-hidden="true">
            Ottr
          </span>
        </div>
      ) : (
        <div className="unified-header-controls">
          <button
            type="button"
            className="titlebar-btn"
            data-testid="titlebar-minimize"
            aria-label={t("titlebar.minimize")}
            onClick={() => controls.minimize()}
          >
            &#x2500;
          </button>
          <div
            className="titlebar-snap-anchor"
            ref={snapAnchorRef}
            onMouseEnter={startSnapHover}
            onMouseLeave={cancelSnapHover}
          >
            <button
              type="button"
              className="titlebar-btn"
              data-testid="titlebar-maximize"
              aria-label={t("titlebar.maximize")}
              aria-expanded={snapOpen}
              onClick={() => controls.toggleMaximize()}
            >
              &#x2750;
            </button>
            {snapEnabled && snapOpen && (
              <div
                className="titlebar-snap"
                data-testid="titlebar-snap"
                role="menu"
                aria-label={t("titlebar.snap")}
              >
                {(
                  [
                    {
                      group: "halves-v",
                      zones: [
                        ["left", "titlebar.snapLeft"],
                        ["right", "titlebar.snapRight"],
                      ],
                    },
                    {
                      group: "halves-h",
                      zones: [
                        ["top", "titlebar.snapTop"],
                        ["bottom", "titlebar.snapBottom"],
                      ],
                    },
                    {
                      group: "quad",
                      zones: [
                        ["tl", "titlebar.snapTl"],
                        ["tr", "titlebar.snapTr"],
                        ["bl", "titlebar.snapBl"],
                        ["br", "titlebar.snapBr"],
                      ],
                    },
                  ] as const
                ).map(({ group, zones }) => (
                  <div key={group} className={`titlebar-snap-group titlebar-snap-${group}`}>
                    {zones.map(([layout, labelKey]) => (
                      <button
                        key={layout}
                        type="button"
                        role="menuitem"
                        className="titlebar-snap-zone"
                        data-testid={`titlebar-snap-${layout}`}
                        aria-label={t(labelKey)}
                        title={t(labelKey)}
                        onClick={() => {
                          setSnapOpen(false);
                          onSnap?.(layout);
                        }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="titlebar-btn titlebar-close"
            data-testid="titlebar-close"
            aria-label={t("titlebar.close")}
            title={t("titlebar.closeHint")}
            onClick={() => controls.close()}
          >
            &#x2715;
          </button>
        </div>
      )}

      {/* 汉堡菜单下拉 */}
      {menuOpen && !isMac && (
        <div className="titlebar-menu" role="menu" data-testid="titlebar-menu">
          {actions
            .filter((def) => def.id !== "app.quit")
            .map((def) => (
              <button
                key={def.id}
                type="button"
                role="menuitem"
                className="titlebar-menu-item"
                onClick={() => runAction(def.id)}
              >
                <span>{t(def.labelKey)}</span>
                {shortcutHint(def.id) && <kbd>{shortcutHint(def.id)}</kbd>}
              </button>
            ))}
          {FEATURE_COMMANDS.length > 0 && (
            <div className="titlebar-menu-sep" role="separator" />
          )}
          {FEATURE_COMMANDS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              className="titlebar-menu-item"
              onClick={() => runAction(f.id)}
            >
              <span>{t(f.labelKey)}</span>
            </button>
          ))}
          <div className="titlebar-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="titlebar-menu-item titlebar-menu-quit"
            data-testid="titlebar-menu-quit"
            onClick={() => runAction("app.quit")}
          >
            <span>{t("palette.quit")}</span>
            {shortcutHint("app.quit") && <kbd>{shortcutHint("app.quit")}</kbd>}
          </button>
        </div>
      )}
    </header>
  );
}
