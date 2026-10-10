// IconButton（2026-10-10 UI 重构一期原语层）：图标按钮单源——统一 ✕ 关闭钮、
// aria 必填（读屏读「关闭」而非字形）、danger 态可选。替代散布 6 套的
// dock-close/recording-player-close/toast-close/… 独立样式（外观由各表面
// className 微调，交互/无障碍语义由本组件保证）。
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 读屏文案（必填——图标按钮对读屏不可见即不可用）。 */
  label: string;
  children: ReactNode;
  danger?: boolean;
}

export function IconButton({ label, children, danger, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn${danger ? " icon-btn-danger" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      {...rest}
    >
      {children}
    </button>
  );
}
