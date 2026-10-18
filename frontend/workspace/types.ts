// workspace 类型：主区视图联合类型与互斥语义口径。
//
// 【互斥域（2026-10-18 现行口径，历史沿革见 git）】
//  * mainView 单值互斥：terminal/files/processes/monitor/plugins（会话级
//    子视图）+ overview/batch/cron/notifications/forwards/jumpchains（库级
//    宽幅视图）共 11 值，同一时刻只见其一。terminal 恒为默认。
//  * 库级视图在场时以页签形态镜像（workspaceViews WORKSPACE_VIEW_META），
//    会话级视图以标签条右侧切换器呈现（跟随会话页签，2026-10-18 裁定）。
//  * 终端常驻不变量：非 terminal 视图时终端 DOM 保留但隐藏（visibility
//    制式），任何切换不卸载（MainArea 渲染侧执行）。

/** 主区视图。terminal 恒为默认；overview/batch/cron/notifications/forwards/
 * jumpchains 为库级宽幅视图（图标轨一级入口）；monitor/plugins 为会话级
 * 子页签（2026-10-16 IA 重构：弹框退役，详见 docs/ia-restructure-1.1.md）。 */
export type MainView =
  | "terminal"
  | "files"
  | "processes"
  | "overview"
  | "batch"
  | "cron"
  | "notifications"
  | "forwards"
  | "jumpchains"
  | "monitor"
  | "plugins";

/** 全量取值表（测试枚举 + 防漂移：联合类型扩员时此表必须同步）。 */
export const MAIN_VIEWS: readonly MainView[] = [
  "terminal",
  "files",
  "processes",
  "overview",
  "batch",
  "cron",
  "notifications",
  "forwards",
  "jumpchains",
  "monitor",
  "plugins",
];


