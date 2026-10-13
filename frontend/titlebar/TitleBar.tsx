// TitleBar（A12，Task 14）：Win/Linux 自绘标题栏。Rust setup 按
// cfg(not(target_os = "macos")) 设 decorations:false 关原生装饰后，本组件补齐
// 窗口壳：汉堡 ≡（展开完整菜单 = registry ACTIONS，spec §13「汉堡展开完整菜单」）
// + 可拖拽区（data-tauri-drag-region）+ 最小化/最大化/关闭。
//
// 平台矩阵（spec §13）：
//   * macOS 不渲染本组件（原生红绿灯 + 系统菜单栏，App.tsx 集成处按平台判定）；
//   * KDE 全局菜单（dbusmenu）适配 Phase 1 跳过（spec §13 标注「可选」）——
//     Linux 与 Windows 同构：汉堡即完整菜单，不依赖全局菜单面；
//   * 关闭按钮走 window.close() → Rust CloseRequested 拦截（关窗到托盘），
//     与红 X 语义一致；真退出在菜单「退出 Ottr」（quit_app 命令）。
//
// 键盘加速的 win/linux 面由 App 的 registry 全局监听承担（Ctrl+N/Ctrl+,/Ctrl+D…），
// 本组件不重复绑定。
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

/** 贴靠分区（与 Rust commands/view.rs SnapLayout 逐字对齐）。 */
export type SnapLayoutId =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "tl"
  | "tr"
  | "bl"
  | "br";

interface TitleBarProps {
  /** 平台（键位提示口径）；测试注入。 */
  plat?: Platform;
  /** 动作分派（收口到 App.handleAction）。 */
  onAction: (action: string) => void;
  /** 贴靠分派（win：最大化按钮 hover 弹选择器；缺省 = 不启用）。 */
  onSnap?: (layout: SnapLayoutId) => void;
  /** 命令表；默认 registry ACTIONS（测试可注入缩表）。 */
  actions?: readonly ActionDef[];
  /** 窗口控制面；默认 Tauri getCurrentWindow()（测试注入 stub）。 */
  win?: WindowControls;
}

interface WindowControls {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
}

export function TitleBar({
  plat = "win",
  onAction,
  onSnap,
  actions = ACTIONS,
  win,
}: TitleBarProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Win11 贴靠（2026-10-13 用户目标）：最大化按钮 hover 350ms 弹布局选择器
  // （win 限定；每个分区 = window_snap 到 work_area 对应矩形）。悬停延迟与
  // Win11 一致的「停留才弹」，避免路过的指针误触。
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

  // 点外/Esc 收（与汉堡菜单同交互纪律）
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

  // 点击标题栏外部收起汉堡菜单（Esc 亦收）。
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

  return (
    <div className="titlebar" ref={rootRef} data-testid="titlebar">
      <button
        className="titlebar-btn titlebar-menu-btn"
        data-testid="titlebar-menu-btn"
        aria-label={t("titlebar.menu")}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        ≡
      </button>
      <span className="titlebar-title">Ottr</span>
      <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <button
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
          className="titlebar-btn"
          data-testid="titlebar-maximize"
          aria-label={t("titlebar.maximize")}
          aria-expanded={snapOpen}
          onClick={() => controls.toggleMaximize()}
        >
          &#x2750;
        </button>
        {snapEnabled && snapOpen && (
          <div className="titlebar-snap" data-testid="titlebar-snap" role="menu" aria-label={t("titlebar.snap")}>
            {(
              [
                { group: "halves-v", zones: [["left", "titlebar.snapLeft"], ["right", "titlebar.snapRight"]] },
                { group: "halves-h", zones: [["top", "titlebar.snapTop"], ["bottom", "titlebar.snapBottom"]] },
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
        className="titlebar-btn titlebar-close"
        data-testid="titlebar-close"
        aria-label={t("titlebar.close")}
        title={t("titlebar.closeHint")}
        onClick={() => controls.close()}
      >
        &#x2715;
      </button>

      {menuOpen && (
        <div className="titlebar-menu" role="menu" data-testid="titlebar-menu">
          {/* 退出项置底（2026-10-13 用户设计确认）：桌面菜单惯例 = 退出永远
              在最底部、上方压分隔线（Windows File→Exit 同构）；此前与设置/
              主题平铺混排不显眼（用户问「要不要加退出」的根因）。动作仍是
              app.quit 同一命令，不加确认弹窗。 */}
          {actions.filter((def) => def.id !== "app.quit").map((def) => (
            <button
              key={def.id}
              role="menuitem"
              className="titlebar-menu-item"
              onClick={() => runAction(def.id)}
            >
              <span>{t(def.labelKey)}</span>
              {shortcutHint(def.id) && <kbd>{shortcutHint(def.id)}</kbd>}
            </button>
          ))}
          {/* 工具组（2026-10-10 IA 重构）：dock 面板/视图/对话框/系统命令与
              mac 工具菜单同源（toolsRegistry FEATURE_COMMANDS）。 */}
          {FEATURE_COMMANDS.length > 0 && (
            <div className="titlebar-menu-sep" role="separator" />
          )}
          {FEATURE_COMMANDS.map((f) => (
            <button
              key={f.id}
              role="menuitem"
              className="titlebar-menu-item"
              onClick={() => runAction(f.id)}
            >
              <span>{t(f.labelKey)}</span>
            </button>
          ))}
          {/* 退出置底 + 分隔线（桌面菜单惯例位置）。 */}
          <div className="titlebar-menu-sep" role="separator" />
          <button
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
    </div>
  );
}

/** Tauri 窗口控制（懒取；非 Tauri 环境调用即 reject，由调用面保证不渲染）。 */
function defaultControls(): WindowControls {
  return {
    minimize: () => void getCurrentWindow().minimize(),
    toggleMaximize: () => void getCurrentWindow().toggleMaximize(),
    close: () => void getCurrentWindow().close(),
  };
}
