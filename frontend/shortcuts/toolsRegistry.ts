// 工具命令注册表（2026-10-10 IA 重构）：dock 面板 / 主区视图 / 对话框 / 系统
// 动作的统一清单——palette「工具」组、Win/Linux 汉堡、mac 工具菜单（menu.rs
// 镜像其分组与条目）、托盘右键菜单 五端同源。
//
// id 形态与 App 分派字面量逐字对齐：tool.* 走 runToolAction（workspaceStore
// openDock / openMainView / setCredentialsOpen），notify.center 走 handleAction，
// update.check 走 toast 就地更新（update/updateToasts.ts：检查→新版内下载安装）。
//
// 与 shortcuts/registry ACTIONS 的划界：ACTIONS = 带 ActionId 类型面的键盘
// 动作（快捷键监听/终端守卫），本表 = 导航型工具命令（无键位面）；notify.center
// 两边都有（键盘面在 ACTIONS，清单面在此）——消费方按各自渲染去重。
//
// 【设置类收敛（2026-10-14 用户裁定，多次重申）】工具菜单不得出现设置概念项：
// tool.ai（v0.9.12）、tool.mcp（单一家 = 设置页 MCP 分区）、tool.sync（单一家 =
// 设置页同步分区）先后退役。此后新增功能先问安家：改配置的面进设置页分区，
// 不进本表。
export type FeatureGroup = "panels" | "hosts" | "system";

export interface FeatureCommand {
  /** 与 App 分派字面量逐字对齐（runToolAction / handleAction 消费）。 */
  id: string;
  /** i18n 词典键（zh-CN / en-US 双语齐全，i18n.test 守卫）。 */
  labelKey: string;
  group: FeatureGroup;
}

/** 展示序 = 数组序；组序由消费方定（汉堡/⌘K 按 groups，托盘/mac 菜单按安家表）。 */
export const FEATURE_COMMANDS: readonly FeatureCommand[] = [
  { id: "tool.cron", labelKey: "nav.cron", group: "panels" },
  { id: "tool.alerts", labelKey: "nav.alerts", group: "panels" },
  { id: "notify.center", labelKey: "nav.notifications", group: "panels" },
  { id: "tool.monitor", labelKey: "monitor.title", group: "panels" },
  { id: "tool.plugins", labelKey: "plugins.title", group: "panels" },
  { id: "tool.forwards", labelKey: "forward.title", group: "panels" },
  { id: "tool.jump-chains", labelKey: "jump.title", group: "panels" },
  { id: "tool.credentials", labelKey: "credentials.dialogTitle", group: "hosts" },
  { id: "tool.overview", labelKey: "overview.title", group: "hosts" },
  { id: "tool.batch", labelKey: "batch.title", group: "hosts" },
  // 导出主机 CSV（2026-10-12 跨平台审计补齐）：runToolAction 的 case 本就已
  // 存在，清单缺项曾致 Win/Linux 无触达口。
  { id: "tool.export-hosts-csv", labelKey: "tools.exportHostsCsv", group: "hosts" },
  { id: "update.check", labelKey: "update.check", group: "system" },
];

export const FEATURE_GROUPS: readonly FeatureGroup[] = ["panels", "hosts", "system"];
