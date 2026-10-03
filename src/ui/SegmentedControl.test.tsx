// SegmentedControl 组件测试（Task 1）：三选段控——互斥单选语义的正确载体
//（替代 SecuritySettings 的 .theme-switch 三联按钮）。DOM 契约与旧三联一致：
// role="group" + button[data-active][aria-pressed]，既有主题切换测试零改动。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";

afterEach(cleanup);

const OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

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
});
