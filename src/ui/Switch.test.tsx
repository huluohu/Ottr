// Switch 组件测试（Task 1，UI 审计 A2）：开关 = role="switch" 升格语义的原生
// input[type=checkbox]（appearance:none 自绘 mint 轨道）。断言钉住：语义角色、
// 受控回显、点击回调载荷（e.currentTarget.checked）、禁用态、aria-label。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Switch } from "./Switch";

afterEach(cleanup);

describe("Switch", () => {
  it("渲染为 role=switch 的原生 checkbox，testid/checked 回显", () => {
    render(<Switch testid="demo-switch" checked={true} onChange={() => {}} label="演示" />);
    const el = screen.getByTestId("demo-switch") as HTMLInputElement;
    expect(el.type).toBe("checkbox"); // 原生 input：space 键切换/表单联动免费获得
    expect(el.getAttribute("role")).toBe("switch");
    expect(el.checked).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("演示");
    expect(el.getAttribute("aria-checked")).toBe("true");
  });

  it("点击回调携带翻转后的 checked 载荷（受控消费方同步读 e.currentTarget.checked）", () => {
    let captured: boolean | null = null;
    const onChange = vi.fn((e: React.ChangeEvent<HTMLInputElement>) => {
      captured = e.currentTarget.checked; // 与生产调用点同款：事件派发内同步读取
    });
    render(<Switch testid="demo-switch" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("demo-switch"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(captured).toBe(true);
  });

  it("disabled 属性透传（浏览器侧禁点；jsdom 的 dispatchEvent 不模拟该拦截）", () => {
    render(<Switch testid="demo-switch" checked={false} onChange={() => {}} disabled={true} />);
    const el = screen.getByTestId("demo-switch") as HTMLInputElement;
    expect(el.disabled).toBe(true);
  });

  it("挂 ui-switch class（自绘样式的唯一挂载点）", () => {
    render(<Switch testid="demo-switch" checked={false} onChange={() => {}} />);
    expect(screen.getByTestId("demo-switch").className).toContain("ui-switch");
  });
});
