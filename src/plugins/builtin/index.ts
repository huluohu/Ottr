// 内置插件注册出口（Phase 4 Task 6）：装载注册表 + 卡片 id → 渲染组件映射。
// 这是「内置插件 = 声明 + 组件」的合流点：manifest/贡献面是纯数据（loader 校验
// 门控），组件只在内置模块内注册——外部代码没有进入此映射的通道（ADR 0002）。
import type { ComponentType } from "react";
import { loadBuiltinRegistry } from "../loader";
import type { PluginQuickCommand } from "../types";
import { NET_SUMMARY_CARD_ID, NetSummaryCard } from "./netSummary";
import { QUICK_COMMANDS_CARD_ID, QuickCommandsCard } from "./quickCommands";

/** 卡片组件统一签名：拿到会话上下文与本插件的命令面；组件按需取用。 */
export type PluginCardComponent = ComponentType<{
  rustId: string | null;
  commands: readonly PluginQuickCommand[];
}>;

/** 卡片 id → 渲染组件（未知 id 的卡片由 PluginSidebar 跳过，不 crash）。 */
export const PLUGIN_CARD_COMPONENTS: Record<string, PluginCardComponent> = {
  [NET_SUMMARY_CARD_ID]: NetSummaryCard,
  [QUICK_COMMANDS_CARD_ID]: QuickCommandsCard,
};

export { loadBuiltinRegistry };
