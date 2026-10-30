// 设置页「添加类」表单的弹框壳（2026-10-30 用户诉求：「设置页，所有添加类型的
// 操作，都改成弹出框，而不是展开」）。
//
// 为什么要这一层：设置页里的 Provider 配置 / 通知渠道 / 告警规则 / 自定义规则
// 原本是**就地展开**的长表单——一分区的内容被顶得很长、滚动条被推走、看完
// 还得再滚回去。改成弹框后：分区只留列表 + 一个「添加」钮，点开才叠出一层
// 小窗（与「立即同步」弹框同款：叠在设置页之上、设置页不被顶掉）。
//
// 落盘位置 = document.body：设置壳入场/退场动画带 transform，fixed 子元素
// 留在壳内会被当成相对该壳定位（与 SyncDialog / PassphraseDialog 同一坑）。
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscClose } from "./useEscClose";
import { DialogClose } from "./DialogClose";

export interface FormDialogProps {
  open: boolean;
  /** 弹框标题（表单自己的小标题也放里面）。 */
  title: string;
  onClose: () => void;
  /** 测试锚点（各表单沿用既有 testid 约定）。 */
  testid: string;
  children: ReactNode;
}

export function FormDialog({ open, title, onClose, testid, children }: FormDialogProps) {
  // Esc = ✕（栈式：只收栈顶——本框叠在设置页之上时先关本框）
  useEscClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <div
      className="overlay overlay-stacked"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testid}
    >
      <div className="dialog form-dialog">
        <div className="dialog-head">
          <h2>{title}</h2>
          <DialogClose onClose={onClose} testid={`${testid}-close`} />
        </div>
        <div className="form-dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
