// WorkspaceViewShell（2026-10-16 IA 重构）：库级宽幅视图的统一外壳。
// 视图恒以页签在场（tabbar-row 已带图标+名称），页面不再重复大标题——
// 只留一行工具栏式副标题：说明文字居左、主操作居右（WorkBuddy 参照：
// 页签是唯一标题，页面顶部只补上下文）。面板实体挂 body。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function WorkspaceViewShell({
  labelKey,
  description,
  children,
  testid,
}: {
  /** 标题词典键（与图标轨/页签同源；仅作无障碍命名，不再渲染大标题）。 */
  labelKey: string;
  description?: string;
  children: ReactNode;
  /** 视图专属 testid（默认 workspace-view；测试按视图定位时传入）。 */
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-view" data-testid={testid ?? "workspace-view"} aria-label={t(labelKey)}>
      <header className="wv-head">
        {description && <p className="wv-desc">{description}</p>}
      </header>
      <div className="wv-body">{children}</div>
    </section>
  );
}
