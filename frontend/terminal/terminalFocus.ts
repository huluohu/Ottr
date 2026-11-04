// 终端聚焦请求总线（2026-10-16 用户反馈：AI 生成命令插入后焦点没落回终端，
// 还得再点一下才能回车执行）。任何流程把键盘焦点交还终端时 bump nonce；
// SessionTerminal 监听并对「当前聚焦 pane」的 xterm 调 focus()。轻量 nonce
// 而非回调注册：终端组件按 sessionId 多实例渲染，谁聚焦谁判定在组件侧
// （activeId + activePane 派生），总线只广播「有人请求了」。
//
// 定向请求（Ask Ottr Task 2）：request(sessionId) 携带目标会话 id——消费方
// （Terminal 组件，Task 3 接线）只在自身 sessionId 与之相同时聚焦，且须校验
// 该 pane 仍是当前聚焦 pane（聚焦已漂移则忽略：焦点只回原终端，绝不追新 pane）。
// 泛型 request() 保持既有语义：targetSessionId 置空，各实例按「当前聚焦 pane」
// 自判——存量调用面零回归。
import { create } from "zustand";

interface TerminalFocusState {
  /** 请求计数（0 = 从未请求；变化即一次请求）。 */
  nonce: number;
  /** 非空 = 定向请求：只允许该会话的终端响应本次 nonce；null = 泛型请求。 */
  targetSessionId: string | null;
  /** request()：泛型请求（聚焦当前聚焦 pane）；request(sessionId)：定向请求。 */
  request: (sessionId?: string) => void;
}

export const useTerminalFocus = create<TerminalFocusState>((set) => ({
  nonce: 0,
  targetSessionId: null,
  request: (sessionId) =>
    set((s) => ({ nonce: s.nonce + 1, targetSessionId: sessionId ?? null })),
}));
