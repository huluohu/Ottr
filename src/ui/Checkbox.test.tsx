// Checkbox 组件测试（Task 1，UI 审计 A2）：勾选框 = 原生 input[type=checkbox]
//（appearance:none 自绘 mint 填充勾选态，视觉家族=批量勾选 .host-check 基准）。
// 断言钉住：隐式 checkbox 角色、受控回显、点击回调载荷、禁用态、aria-label。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "./Checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("渲染为原生 checkbox（隐式 checkbox 角色），testid/checked 回显", () => {
    render(<Checkbox testid="demo-check" checked={true} onChange={() => {}} label="演示" />);
    const el = screen.getByTestId("demo-check") as HTMLInputElement;
    expect(el.type).toBe("checkbox");
    expect(el.getAttribute("role")).toBeNull(); // 不覆盖原生语义
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(el.checked).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("演示");
  });

  it("点击回调携带翻转后的 checked 载荷（生产调用点同步读取）", () => {
    let captured: boolean | null = null;
    const onChange = vi.fn((e: React.ChangeEvent<HTMLInputElement>) => {
      captured = e.currentTarget.checked;
    });
    render(<Checkbox testid="demo-check" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("demo-check"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(captured).toBe(true);
  });

  it("disabled 属性透传（浏览器侧禁点；jsdom 的 dispatchEvent 不模拟该拦截）", () => {
    render(<Checkbox testid="demo-check" checked={false} onChange={() => {}} disabled={true} />);
    const el = screen.getByTestId("demo-check") as HTMLInputElement;
    expect(el.disabled).toBe(true);
  });

  it("挂 ui-checkbox class（自绘样式的唯一挂载点）", () => {
    render(<Checkbox testid="demo-check" checked={false} onChange={() => {}} />);
    expect(screen.getByTestId("demo-check").className).toContain("ui-checkbox");
  });
});
