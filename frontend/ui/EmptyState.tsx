// EmptyState（2026-10-10 UI 重构一期原语层）：空态单源——标题 + 可选说明 +
// 可选动作。消费面：通知中心空态（首个示范位），其余面板空态渐进收编
// （cron-empty/alert-channels-empty 等保持 testid 不变，仅换内部实现）。
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void; testid?: string };
  /** 外层 testid 透传（既有测试断言面保持）。 */
  testid?: string;
  children?: ReactNode;
}

export function EmptyState({ title, hint, action, testid, children }: EmptyStateProps) {
  return (
    <div className="empty-state" data-testid={testid}>
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
