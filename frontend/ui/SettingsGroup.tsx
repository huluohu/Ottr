// SettingsGroup（2026-10-31 用户需求：设置页参照系统设置类应用版式重组）——
// 「组名小标题 + 卡面（行集合）」两段式：组间留白区分语义组，组内发丝线分隔
// 各个选项行；控件一律右靠，与参考版式的右缘栅格一致。
import type { ReactNode } from "react";

export interface SettingsGroupProps {
  /** 组名（如「启动」「外观」「存储」）。 */
  title: string;
  children: ReactNode;
  testid?: string;
}

export function SettingsGroup({ title, children, testid }: SettingsGroupProps) {
  return (
    <section className="settings-group" data-testid={testid}>
      <h4 className="settings-group-title">{title}</h4>
      <div className="settings-card">{children}</div>
    </section>
  );
}
