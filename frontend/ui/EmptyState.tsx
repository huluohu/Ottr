// EmptyState（2026-10-10 UI 重构一期原语层）：空态单源——标题 + 可选说明 +
// 可选动作。2026-10-16 视觉重设计 M3 增补：默认渲染 Otty 小剪影位（报告 §4
// 「空态配 Otty 剪影，48px 统一 sprite」），icon prop 可换图或传 null 关掉；
// 消费方 testid 不变。
import type { ReactNode } from "react";
import { OttySilhouette } from "./otty/OttySilhouette";

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; testid?: string };
  /** 外层 testid 透传（既有测试断言面保持）。 */
  testid?: string;
  /** 图标位：缺省 = OttySilhouette；传 null = 无图标（回旧制）。 */
  icon?: ReactNode | null;
  children?: ReactNode;
}

export function EmptyState({ title, hint, action, testid, icon, children }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid={testid}>
      {icon !== null && <OttySilhouette />}
      <p className="empty-state-title">{title}</p>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {action && (
        <button type="button" data-testid={action.testid} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}
