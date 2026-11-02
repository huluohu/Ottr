import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import "../i18n";
import { UnifiedHeader } from "./UnifiedHeader";

describe("UnifiedHeader", () => {
  afterEach(cleanup);

  it("macOS 平台下渲染 76px 留白拖拽安全区，不渲染 Win/Linux 原生控制按钮", () => {
    const onOpenPalette = vi.fn();
    render(<UnifiedHeader plat="mac" onAction={vi.fn()} onOpenPalette={onOpenPalette} />);

    expect(screen.getByTestId("unified-header-mac-traffic-safe")).toBeTruthy();
    expect(screen.queryByTestId("titlebar-close")).toBeNull();

    const searchCapsule = screen.getByTestId("unified-header-search");
    fireEvent.click(searchCapsule);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("Windows 平台下渲染汉堡菜单与标准最小化/最大化/关闭按钮", () => {
    const mockWin = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
    render(<UnifiedHeader plat="win" onAction={vi.fn()} win={mockWin} />);

    expect(screen.queryByTestId("unified-header-mac-traffic-safe")).toBeNull();
    expect(screen.getByTestId("titlebar-menu-btn")).toBeTruthy();
    expect(screen.getByTestId("titlebar-close")).toBeTruthy();

    fireEvent.click(screen.getByTestId("titlebar-close"));
    expect(mockWin.close).toHaveBeenCalledTimes(1);
  });

  it("Linux 平台下渲染汉堡菜单与标准控制按钮", () => {
    const mockWin = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
    render(<UnifiedHeader plat="linux" onAction={vi.fn()} win={mockWin} />);

    expect(screen.queryByTestId("unified-header-mac-traffic-safe")).toBeNull();
    expect(screen.getByTestId("titlebar-menu-btn")).toBeTruthy();
    expect(screen.getByTestId("titlebar-minimize")).toBeTruthy();
  });
});
