// SegmentedControl 组件测试（Task 1）：三选段控——互斥单选语义的正确载体
//（替代 SecuritySettings 的 .theme-switch 三联按钮）。DOM 契约与旧三联一致：
// role="group" + button[data-active][aria-pressed]，既有主题切换测试零改动。
// BL-535（ui1 §8 #4）：roving tabindex——单 tabStop + 方向键段间移焦 + Home/End。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";

afterEach(cleanup);

const OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

function buttonsOf(testid = "theme-seg"): HTMLButtonElement[] {
  const group = screen.getByTestId(testid);
  return Array.from(group.querySelectorAll("button")) as HTMLButtonElement[];
}

describe("SegmentedControl", () => {
  it("渲染 role=group + 全部选项按钮，选中项 data-active/aria-pressed", () => {
    render(
      <SegmentedControl
        testid="theme-seg"
        ariaLabel="主题"
        value="dark"
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    const group = screen.getByTestId("theme-seg");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("主题");
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    expect(buttons[1].dataset.active).toBe("true");
    expect(buttons[1].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0].dataset.active).toBe("false");
  });

  it("点击未选中项回调其 value；选中项自身点击不回调新值语义破坏", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl testid="theme-seg" value="light" options={OPTIONS} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText("跟随系统"));
    expect(onChange).toHaveBeenCalledWith("system");
    onChange.mockClear();
    fireEvent.click(screen.getByText("浅色"));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("挂 ui-segmented class", () => {
    render(
      <SegmentedControl testid="theme-seg" value="light" options={OPTIONS} onChange={() => {}} />,
    );
    expect(screen.getByTestId("theme-seg").className).toContain("ui-segmented");
  });

  // --- BL-535：roving tabindex（单 tabStop + 方向键移焦 + Home/End）-----------

  it("单 tabStop：仅选中段 tabIndex=0，其余 -1", () => {
    render(
      <SegmentedControl testid="theme-seg" value="dark" options={OPTIONS} onChange={() => {}} />,
    );
    const btns = buttonsOf();
    expect(btns.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("ArrowRight/ArrowLeft 段间移焦（循环），焦点移动不改选中（Enter/Space 激活仍是按钮原生语义）", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl testid="theme-seg" value="dark" options={OPTIONS} onChange={onChange} />,
    );
    const btns = buttonsOf();
    btns[1].focus();
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(btns[2]);
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(btns[0]); // 循环回首
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(btns[2]);
    // 移焦不选中：value 回调不得被键盘移动触发
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Home/End 首尾移焦；移焦后 roving tabStop 跟随焦点", () => {
    render(
      <SegmentedControl testid="theme-seg" value="dark" options={OPTIONS} onChange={() => {}} />,
    );
    const btns = buttonsOf();
    btns[1].focus();
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "End" });
    expect(document.activeElement).toBe(btns[2]);
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "Home" });
    expect(document.activeElement).toBe(btns[0]);
    // roving tabStop 跟随焦点：焦点段 0，其余 -1
    expect(btns.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it("垂直方向键同样移焦（上下与左右同义）；焦点不在组内时不抢键", () => {
    render(
      <SegmentedControl testid="theme-seg" value="light" options={OPTIONS} onChange={() => {}} />,
    );
    const btns = buttonsOf();
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(btns[1]); // 无焦点起点 → 不动作
    btns[0].focus();
    fireEvent.keyDown(screen.getByTestId("theme-seg"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(btns[1]);
  });
});
