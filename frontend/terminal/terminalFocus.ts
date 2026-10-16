// 终端聚焦请求总线（2026-10-16 用户反馈：AI 生成命令插入后焦点没落回终端，
// 还得再点一下才能回车执行）。任何流程把键盘焦点交还终端时 bump nonce；
// SessionTerminal 监听并对「当前聚焦 pane」的 xterm 调 focus()。轻量 nonce
// 而非回调注册：终端组件按 sessionId 多实例渲染，谁聚焦谁判定在组件侧
// （activeId + activePane 派生），总线只广播「有人请求了」。
import { create } from "zustand";

interface TerminalFocusState {
  /** 请求计数（0 = 从未请求；变化即一次请求）。 */
  nonce: number;
  /** 请求把键盘焦点交回当前聚焦 pane 的终端。 */
  request: () => void;
}

export const useTerminalFocus = create<TerminalFocusState>((set) => ({
  nonce: 0,
  request: () => set((s) => ({ nonce: s.nonce + 1 })),
}));
