import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import "../i18n";
import { ThemeVisualPicker } from "./ThemeVisualPicker";

describe("ThemeVisualPicker", () => {
  afterEach(cleanup);

  it("渲染系统、浅色、深色三张微缩卡片并正确反映选中态", () => {
    const onChange = vi.fn();
    render(<ThemeVisualPicker value="system" onChange={onChange} />);

    const systemRadio = screen.getByTestId("theme-card-system");
    expect(systemRadio.getAttribute("aria-checked")).toBe("true");

    const darkRadio = screen.getByTestId("theme-card-dark");
    expect(darkRadio.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(darkRadio);
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("支持键盘左右箭头导航 (a11y)", () => {
    const onChange = vi.fn();
    render(<ThemeVisualPicker value="light" onChange={onChange} />);

    const lightRadio = screen.getByTestId("theme-card-light");
    expect(lightRadio.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(lightRadio, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("当被禁用时不可触发切换", () => {
    const onChange = vi.fn();
    render(<ThemeVisualPicker value="system" onChange={onChange} disabled />);

    const darkRadio = screen.getByTestId("theme-card-dark");
    fireEvent.click(darkRadio);
    expect(onChange).not.toHaveBeenCalled();
  });
});
