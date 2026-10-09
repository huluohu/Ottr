// PluginSidebar（Phase 4 Task 6，C3 foundation）：插件卡片挂载点。
// 终端右栏第二块折叠面板（监控侧栏同构：折叠竖条常驻，展开盖右侧）。
// 渲染面 = loadBuiltinRegistry() 的 cards（声明白名单过闸后的贡献面），
// 组件映射取 builtin/PLUGIN_CARD_COMPONENTS；未知卡片 id 跳过不 crash。
// 折叠态 localStorage 记忆，默认收起（同监控侧栏：不打扰首次使用）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { loadBuiltinRegistry } from "./loader";
import { PLUGIN_CARD_COMPONENTS } from "./builtin";
import type { PluginQuickCommand } from "./types";

/** 折叠态记忆键（布局面，监控侧栏同惯例）。 */
const OPEN_KEY = "ottr.plugins.sidebarOpen";

export function loadPluginSidebarOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // 持久化失败不阻塞
  }
}

const REGISTRY = loadBuiltinRegistry();

export function PluginSidebar({ rustId }: { rustId: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(loadPluginSidebarOpen);

  if (!open) {
    return (
      <button
        className="plugin-rail"
        data-testid="plugin-rail"
        aria-label={t("plugins.open")}
        title={t("plugins.open")}
        onClick={() => {
          persistSidebarOpen(true);
          setOpen(true);
        }}
      />
    );
  }

  return (
    <aside className="plugin-sidebar" data-testid="plugin-sidebar" aria-label={t("plugins.title")}>
      <div className="plugin-head">
        <span className="plugin-title">{t("plugins.title")}</span>
        <button
          className="plugin-close"
          data-testid="plugin-collapse"
          aria-label={t("plugins.close")}
          onClick={() => {
            persistSidebarOpen(false);
            setOpen(false);
          }}
        >
          ×
        </button>
      </div>
      {REGISTRY.cards.map(({ plugin, card }) => {
        const Component = PLUGIN_CARD_COMPONENTS[card.id];
        if (!Component) return null; // 未知卡片 id（理论不可达：内置面编译期对齐）
        const commands: readonly PluginQuickCommand[] = REGISTRY.quickCommands
          .filter((c) => c.plugin === plugin)
          .map((c) => c.command);
        return <Component key={card.id} rustId={rustId} commands={commands} />;
      })}
    </aside>
  );
}
