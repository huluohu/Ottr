// SegmentedControl 三选段控（Task 1）：互斥单选（如主题 light/dark/system）的
// 语义正确载体——替代旧 .theme-switch 三联按钮。DOM 契约与旧三联一致
//（role="group" + button[data-active][aria-pressed]），既有测试零改动；
// 选中段 = accent 实底 + on-accent 前景（与 Switch/Checkbox 同一视觉家族）。
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** 组的可访问名（aria-label）。 */
  ariaLabel?: string;
  testid?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  testid,
}: SegmentedControlProps<T>) {
  return (
    <div className="ui-segmented" role="group" aria-label={ariaLabel} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-active={value === o.value}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
