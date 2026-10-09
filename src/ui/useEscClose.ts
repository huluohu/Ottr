import { useEffect } from "react";

/**
 * 弹框 Esc 关闭（2026-10-09 统一交互，用户要求「弹出框都要支持 Esc 退出」）：
 * open 期间在 document 上监听 keydown，Escape 触发 onClose。
 *
 * 嵌套语义：子弹框（后挂载的组件）的 effect 先注册，处理时调用
 * stopImmediatePropagation——外层弹框的同事件监听不再触发，Esc 逐层退出
 * 而非一次穿透关闭整链。consumeSubLayer 返回 true 表示本组件内的子确认态
 * 已消费本次 Esc（先收子层、主框不关，同 SecuritySettings sudoConfirm 口径）。
 */
export function useEscClose(
  open: boolean,
  onClose: () => void,
  consumeSubLayer?: () => boolean,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (consumeSubLayer?.()) {
        e.stopImmediatePropagation();
        return;
      }
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, consumeSubLayer]);
}
