// PluginPanel（原 PluginSidebar）：插件视图内容组件。
// * 形态沿革：终端右栏折叠竖条 → ToolDialog 内容 → 2026-10-17 满幅主区视图
//   （会话子页签，与监控视图同批重排；侧栏定宽制式退役）。页签是唯一标题；
//   机制说明一句走页头（WorkspaceViewShell description），本组件只排卡片网格。
// * 渲染面 = loadBuiltinRegistry() 的 cards（声明白名单过闸后的贡献面），
//   组件映射取 builtin/PLUGIN_CARD_COMPONENTS；未知卡片 id 跳过不 crash。
import { useTranslation } from "react-i18next";
import { loadBuiltinRegistry } from "./loader";
import { PLUGIN_CARD_COMPONENTS } from "./builtin";
import type { PluginQuickCommand } from "./types";

const REGISTRY = loadBuiltinRegistry();

/** 视图内容（MainArea 经 WorkspaceViewShell 挂载；页签供给标题）。 */
export function PluginPanel({ rustId }: { rustId: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="plugins-view" data-testid="plugin-panel" role="region" aria-label={t("plugins.title")}>
      <div className="plugins-grid" data-testid="plugins-grid">
        {REGISTRY.cards.map(({ plugin, card }) => {
          const Component = PLUGIN_CARD_COMPONENTS[card.id];
          if (!Component) return null; // 未知卡片 id（理论不可达：内置面编译期对齐）
          const commands: readonly PluginQuickCommand[] = REGISTRY.quickCommands
            .filter((c) => c.plugin === plugin)
            .map((c) => c.command);
          return <Component key={card.id} rustId={rustId} commands={commands} />;
        })}
      </div>
    </div>
  );
}
