// workspace 类型（UI 批次一 Task 2）：主区视图 + 右侧停靠面板的联合类型与
// 互斥语义口径。
//
// 【互斥域裁定（本任务）】
//  * mainView 单值互斥：五视图（terminal/files/processes/overview/batch）
//    同一时刻只见其一。terminal 恒为默认；files/processes 自原 setState
//    互斥体系迁入；overview/batch 自原顶栏对话框迁入（实体 T3 迁入）。
//  * dockPanel 单槽互斥：右侧 dock 同时只开一个工具面板——openDock 换值
//    即替换（不叠加）。
//  * monitor/plugins **并存语义沿现状**：二者是终端右栏自管折叠侧栏
//    （MonitorSidebar/PluginSidebar 内部 state + localStorage 记忆开合），
//    现实现中两竖条常驻、两展开面可同开、且与 dock 工具面板不互斥——
//    本任务保持该语义不动（视觉不变）。它们的值留在 DockPanel 联合里是
//    为 T4 迁移预留同一单槽 API；在迁入前 store 接受这些值但无挂载面
//    （DockPanel 对 monitor/plugins 渲染 null，见 dock/DockPanel.tsx）。
//  * 挂载域互斥（沿现状）：monitor/plugins 侧栏只在 terminal 视图挂载
//    （原 `!filesVisible && !procsVisible` 域）；overview/batch 视图下同让位。

/** 主区视图（mainView 状态机的五个取值；terminal 恒为默认）。 */
export type MainView = "terminal" | "files" | "processes" | "overview" | "batch";

/** 右侧停靠面板。monitor/plugins = 终端右栏自管侧栏（见上，并存语义沿现状）；
 * 其余五值为 dock 工具面板（T4 起实体渲染在 dock/DockPanel）。 */
export type DockPanel =
  | "monitor"
  | "plugins"
  | "forwards"
  | "jumpchains"
  | "cron"
  | "alerts"
  | "mcp";

/** dock 工具面板（dock/DockPanel 实际承载的五值；monitor/plugins 不经此壳）。 */
export type ToolDockPanel = Extract<
  DockPanel,
  "forwards" | "jumpchains" | "cron" | "alerts" | "mcp"
>;

/** 全量取值表（测试枚举 + 防漂移：联合类型扩员时此表必须同步）。 */
export const MAIN_VIEWS: readonly MainView[] = [
  "terminal",
  "files",
  "processes",
  "overview",
  "batch",
];
export const DOCK_PANELS: readonly DockPanel[] = [
  "monitor",
  "plugins",
  "forwards",
  "jumpchains",
  "cron",
  "alerts",
  "mcp",
];
export const TOOL_DOCK_PANELS: readonly ToolDockPanel[] = [
  "forwards",
  "jumpchains",
  "cron",
  "alerts",
  "mcp",
];

/** dock 工具面板标题 i18n 键（全部复用既有键——零新增文案键，双语守卫直接过）。 */
export const DOCK_PANEL_TITLE_KEY: Record<ToolDockPanel, string> = {
  forwards: "forward.title",
  jumpchains: "jump.title",
  cron: "cron.title",
  alerts: "alert.sectionTitle",
  mcp: "mcp.title",
};
