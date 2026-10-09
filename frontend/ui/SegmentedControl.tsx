// SegmentedControl 三选段控（Task 1）：互斥单选（如主题 light/dark/system）的
// 语义正确载体——替代旧 .theme-switch 三联按钮。DOM 契约与旧三联一致
//（role="group" + button[data-active][aria-pressed]），既有测试零改动；
// 选中段 = accent 实底 + on-accent 前景（与 Switch/Checkbox 同一视觉家族）。
//
// BL-535（ui1 §8 #4，批次三可选未做入账）：roving tabindex 键盘可达性——
// 单 tabStop（选中段 tabIndex=0，其余 -1）+ 方向键段间移焦（循环）+ Home/End
// 首尾；tabStop 随焦点漫游。移焦不等于选中：Enter/Space 激活仍是按钮原生语义
//（WAI-ARIA APG toggle-button 组口径，不与 aria-pressed 语义冲突）。
import { useRef, useState, type KeyboardEvent } from "react";

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
  const rootRef = useRef<HTMLDivElement>(null);
  /** 键盘漫游的 tabStop 焦点段（null = 未漫游，跟随选中段）。state：变更需
   * 触发重渲以刷新 tabIndex。 */
  const [roving, setRoving] = useState<string | null>(null);

  function moveFocus(delta: number | "first" | "last"): void {
    const btns = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    if (btns.length === 0) return;
    // 键盘语义只对「焦点已在组内」生效（真浏览器里焦点在外时组也收不到
    // keydown；jsdom 显式 dispatch，这里防抢键）。
    if (!btns.some((b) => b === document.activeElement)) return;
    const focusedIdx = btns.findIndex((b) => b === document.activeElement);
    const base = focusedIdx >= 0 ? focusedIdx : btns.findIndex((b) => b.dataset.active === "true");
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? btns.length - 1
          : (base + delta + btns.length) % btns.length;
    const target = btns[next];
    if (!target) return;
    setRoving(target.dataset.value ?? null);
    target.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        e.preventDefault();
        moveFocus("first");
        break;
      case "End":
        e.preventDefault();
        moveFocus("last");
        break;
      default:
        break;
    }
  }

  const tabStop = roving ?? value;
  return (
    <div
      className="ui-segmented"
      role="group"
      aria-label={ariaLabel}
      data-testid={testid}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-active={value === o.value}
          aria-pressed={value === o.value}
          data-value={o.value}
          // roving tabindex：tabStop 在选中段；键盘漫游后跟随焦点段
          tabIndex={tabStop === o.value ? 0 : -1}
          onClick={() => {
            setRoving(null);
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
