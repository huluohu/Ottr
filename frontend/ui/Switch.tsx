// Switch 开关（Task 1，UI 审计 A2）：on/off 偏好的语义正确载体。
// 实现 = 原生 input[type=checkbox] + role="switch" 语义升格 + appearance:none
// 自绘 mint 轨道/滑块（视觉家族基准 = 批量勾选的 accent 实底选中态，.host-check）。
// 保留原生 input 的收益：space 键切换、label 点击联动、表单语义、读屏播报零成本；
// onChange 沿用原生事件签名（e.currentTarget.checked），既有调用点零改动。
import type { ChangeEvent } from "react";

export interface SwitchProps {
  /** 受控选中态。 */
  checked: boolean;
  /** 原生 change 事件——消费方读 e.currentTarget.checked。 */
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  /** 无可见行内文字时的可访问名（aria-label）。 */
  label?: string;
  testid?: string;
}

export function Switch({ checked, onChange, disabled, label, testid }: SwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={checked}
      className="ui-switch"
      data-testid={testid}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
