// WorkspaceViewShell（2026-10-16 IA 重构）：库级宽幅视图的统一页头外壳——
// 图标徽章 + 大标题 + 描述 + 右侧主操作，面板实体挂 body。WorkBuddy 参照：
// 页头定调、内容区满幅。视图元数据（label/icon）单源 workspaceViews.tsx。
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function WorkspaceViewShell({
  labelKey,
  icon: Icon,
  description,
  action,
  children,
  testid,
}: {
  /** 标题词典键（与图标轨同源）。 */
  labelKey: string;
  icon: ComponentType<{ width?: number; height?: number; "aria-hidden"?: true }>;
  description?: string;
  /** 右上主操作（如 新建任务）。 */
  action?: { label: string; onClick: () => void; testid?: string };
  children: ReactNode;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-view" data-testid={testid ?? "workspace-view"}>
      <header className="wv-head">
        <span className="wv-chip" aria-hidden>
          <Icon width={22} height={22} />
        </span>
        <div className="wv-head-text">
          <h2 className="wv-title">{t(labelKey)}</h2>
          {description && <p className="wv-desc">{description}</p>}
        </div>
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
