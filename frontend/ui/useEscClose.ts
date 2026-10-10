import { useEffect, useRef } from "react";

/**
 * 弹框 Esc 关闭（2026-10-09 统一交互，用户要求「弹出框都要支持 Esc 退出」）。
 *
 * 2026-10-10 重构为**栈式嵌套**：open 的弹框按开启顺序入栈，Escape 只关栈顶
 * （最后开启的）——修复旧实现的两个缺陷：
 *   1. 旧实现按注册顺序触发（document 监听先注册先执行），先开的弹框先收到
 *      Esc，「叠在上面的先关」语义实际不成立（⌘K 叠在设置上按 Esc 会关掉底下
 *      的设置，一键穿两层）；
 *   2. 部分组件（录制回放器）被迫用 window capture 硬拦冒泡来自救。
 *
 * consumeSubLayer：本组件内的子确认态（如 SecuritySettings 的 sudo 确认）
 * 先收子层、主框不关——返回 true 表示本次 Esc 已被消费。
 *
 * 注意：处理器经 ref 间接引用（效果只依赖 open），父层每次渲染传入的新闭包
 * 不会导致栈条目重排——否则低层弹框重渲染后会错误地顶到栈顶。
 */

interface EscEntry {
  fire: () => boolean; // true = 已消费（子层），不再关主框
}

const escStack: EscEntry[] = [];
let listenerBound = false;

function ensureListener(): void {
  if (listenerBound) return;
  listenerBound = true;
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const top = escStack[escStack.length - 1];
    if (!top) return;
    e.stopImmediatePropagation();
    top.fire();
  });
}

export function useEscClose(
  open: boolean,
  onClose: () => void,
  consumeSubLayer?: () => boolean,
): void {
  const handlers = useRef({ onClose, consumeSubLayer });
  handlers.current = { onClose, consumeSubLayer };

  useEffect(() => {
    if (!open) return;
    const entry: EscEntry = {
      fire: () => {
        if (handlers.current.consumeSubLayer?.()) return true;
        handlers.current.onClose();
        return false;
      },
    };
    escStack.push(entry);
    ensureListener();
    return () => {
      const i = escStack.indexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [open]);
}
