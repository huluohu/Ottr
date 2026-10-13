// PluginPanel（原 PluginSidebar，2026-10-13 改造）：插件面板内容组件。
// * 旧「终端右栏折叠竖条 + 开合记忆」形态退役（同监控面板：竖条被当成
//   滚动条、压住分屏关闭钮）——现作为 ToolDialog 的 plugins 面板内容渲染
//   （工具菜单/⌘K「插件」打开），入口与其余工具面板一致；
// * 渲染面 = loadBuiltinRegistry() 的 cards（声明白名单过闸后的贡献面），
//   组件映射取 builtin/PLUGIN_CARD_COMPONENTS；未知卡片 id 跳过不 crash。
import { useTranslation } from "react-i18next";
import { loadBuiltinRegistry } from "./loader";
import { PLUGIN_CARD_COMPONENTS } from "./builtin";
import type { PluginQuickCommand } from "./types";

const REGISTRY = loadBuiltinRegistry();

/** 面板内容（ToolDialog plugins 面板渲染；弹框壳提供标题与 ✕）。 */
export function PluginPanel({ rustId }: { rustId: string | null }) {
  const { t } = useTranslation();
  return (
    <aside className="plugin-sidebar" data-testid="plugin-sidebar" aria-label={t("plugins.title")}>
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
