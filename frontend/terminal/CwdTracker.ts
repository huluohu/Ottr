// 会话级 OSC7 cwd 活值跟踪（Phase 2 B1，⌘J NL→命令的上下文面）：
// CommandWatch（Task 15）在每个提示符时点解析 OSC 7，但 cwd 只随命令完成事件
// **路过**（onCommandFinished 载荷），没有活值存储。这里补一个模块级
// Map<sessionId, cwd>——非响应式资源，与 sinks/retryTimers 同一放置惯例：
//   * noteCwd：Terminal.tsx 的 onCommandFinished 回调顺带记账（ev.cwd = 该命令
//     的运行目录，OSC7 未上报时为 null——null 不覆盖旧值，保住最后一次上报）；
//   * lastCwd：⌘J 打开时按聚焦 pane 查询，作为生成上下文的目录锚点
//     （「在这里解压」这类相对意图没有它就只能猜）；
//   * forget：终端组件卸载（会话关/pane 收）时清键，防 Map 单调增长。
// 纯内存、不过期：断线重连后 shell 集成重新上报即自愈。
const cwdBySession = new Map<string, string>();

/** 记账（onCommandFinished 顺带调用；cwd=null 不覆盖）。 */
export function noteCwd(sessionId: string, cwd: string | null): void {
  if (cwd !== null) cwdBySession.set(sessionId, cwd);
}

/** 查询（无记录/已 forget → null）。 */
export function lastCwd(sessionId: string): string | null {
  return cwdBySession.get(sessionId) ?? null;
}

/** 会话消失时清键（Terminal 卸载清理面）。 */
export function forgetCwd(sessionId: string): void {
  cwdBySession.delete(sessionId);
}
