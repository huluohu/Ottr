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

export interface TitleBarProps {
  /** 平台（键位提示口径）；测试注入。 */
  plat?: Platform;
  /** 动作分派（收口到 App.handleAction）。 */
  onAction: (action: string) => void;
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

export function TitleBar({ plat = "win", onAction, actions = ACTIONS, win }: TitleBarProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
      <button
        className="titlebar-btn"
        data-testid="titlebar-maximize"
        aria-label={t("titlebar.maximize")}
        onClick={() => controls.toggleMaximize()}
      >
        &#x2750;
      </button>
      <button
        className="titlebar-btn titlebar-close"
        data-testid="titlebar-close"
        aria-label={t("titlebar.close")}
        onClick={() => controls.close()}
      >
        &#x2715;
      </button>

      {menuOpen && (
        <div className="titlebar-menu" role="menu" data-testid="titlebar-menu">
          {actions.map((def) => (
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
