// 分屏动作去重（2026-10-14）：视图菜单分屏点击偶发双发（菜单事件链路），
// 分屏为非幂等动作——同方向 250ms 内的重复事件丢弃。纯函数 + 闭包状态，
// 可独立单测；其余菜单动作皆幂等，不经过本去重。
export type SplitAction = "session.splitRight" | "session.splitDown";

export function createSplitDedupe(
  windowMs = 250,
): (action: string, now: number) => boolean {
  let last = "";
  let at = 0;
  /** 返回 true = 放行执行；false = 窗口内重复，丢弃。 */
  return (action: string, now: number): boolean => {
    if (action !== "session.splitRight" && action !== "session.splitDown") return true;
    if (action === last && now - at < windowMs) return false;
    last = action;
    at = now;
    return true;
  };
}
