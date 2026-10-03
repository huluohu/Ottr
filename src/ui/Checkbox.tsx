// Checkbox 勾选框（Task 1，UI 审计 A2）：多选集合成员/行内 flag 的语义载体。
// 实现 = 原生 input[type=checkbox] + appearance:none 自绘 mint 填充勾选态
//（视觉家族基准 = 批量勾选 .host-check：14px 方框、1.5px 描边、选中 accent 实底）。
// 保留原生 input 的收益：space 键切换、label 点击联动、隐式 checkbox 角色零成本；
// onChange 沿用原生事件签名（e.currentTarget.checked），既有调用点零改动。
import type { ChangeEvent } from "react";

export interface CheckboxProps {
  /** 受控选中态。 */
  checked: boolean;
  /** 原生 change 事件——消费方读 e.currentTarget.checked。 */
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  /** 无可见行内文字时的可访问名（aria-label）。 */
  label?: string;
  testid?: string;
}

export function Checkbox({ checked, onChange, disabled, label, testid }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className="ui-checkbox"
      data-testid={testid}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
