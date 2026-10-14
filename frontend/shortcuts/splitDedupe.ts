// 菜单动作去重（2026-10-14 分屏首报，2026-10-16 推广全族）：菜单事件链路
// 偶发双发——非幂等动作（开关二态/同值翻转）双发即「开→关一闪」（帮助菜单
// 「命令面板」用户实测）。同 id 250ms 内的重复事件丢弃：原生菜单点击后必然
// 收起，真实交互不可能 250ms 内重复同一菜单动作。纯函数 + 闭包状态，可独立
// 单测；幂等动作（打开类）不经过本去重。
const NON_IDEMPOTENT = new Set([
  "session.splitRight",
  "session.splitDown",
  "palette.toggle",
  "history.search",
  "ai.nl2cmd",
  "notify.center",
]);

/** 工具菜单里的**翻转族**（openToolDialog 同值再点 = 关）——双发即闪。
 * 逐个点名不用前缀：tool.* 里混着非翻转成员（export-hosts-csv 连发两次是
 * 「同一 Toast 复用」的合法节奏，前缀一刀切会误杀——App.test 实测抓过）。 */
const TOGGLE_TOOLS = new Set([
  "tool.cron",
  "tool.alerts",
  "tool.monitor",
  "tool.plugins",
  "tool.notify-center",
  "tool.forwards",
  "tool.jump-chains",
]);

/** 非幂等判定：显式清单 + 翻转族工具弹框。 */
function nonIdempotent(action: string): boolean {
  return NON_IDEMPOTENT.has(action) || TOGGLE_TOOLS.has(action);
}

export function createSplitDedupe(
  windowMs = 250,
): (action: string, now: number) => boolean {
  let last = "";
  let at = 0;
  /** 返回 true = 放行执行；false = 窗口内重复，丢弃。 */
  return (action: string, now: number): boolean => {
    if (!nonIdempotent(action)) return true;
    if (action === last && now - at < windowMs) return false;
    last = action;
    at = now;
    return true;
  };
}
