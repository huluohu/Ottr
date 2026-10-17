// WorkspaceViewShell（2026-10-16 IA 重构）：库级宽幅视图的统一外壳。
// 视图恒以页签在场（tabbar-row 已带图标+名称），页面不再重复大标题——
// 只留一行工具栏式副标题：说明文字居左、主操作居右（WorkBuddy 参照：
// 页签是唯一标题，页面顶部只补上下文）。面板实体挂 body。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function WorkspaceViewShell({
  labelKey,
  description,
  action,
  children,
  testid,
}: {
  /** 标题词典键（与图标轨/页签同源；仅作无障碍命名，不再渲染大标题）。 */
  labelKey: string;
  description?: string;
  /** 右上主操作（如 新建任务）。 */
  action?: { label: string; onClick: () => void; testid?: string };
  children: ReactNode;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-view" data-testid={testid ?? "workspace-view"} aria-label={t(labelKey)}>
      <header className="wv-head">
        {description && <p className="wv-desc">{description}</p>}
        {action && (
          <button type="button" className="btn-accent wv-action" data-testid={action.testid} onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </header>
      <div className="wv-body">{children}</div>
    </section>
  );
}
