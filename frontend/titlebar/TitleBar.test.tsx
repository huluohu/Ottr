// TitleBar 单测（Task 14）：三钮窗口控制分派、汉堡菜单展开/动作派发/外部收起、
// 拖拽区属性、键位提示平台口径（注入 plat）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import i18n from "../i18n";
import { ACTIONS, type ActionDef, type ActionId } from "../shortcuts/registry";
import { FEATURE_COMMANDS } from "../shortcuts/toolsRegistry";
import { TitleBar } from "./TitleBar";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});

function makeWin() {
  return { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };
}

function renderBar(overrides: Partial<Parameters<typeof TitleBar>[0]> = {}) {
  const props: Parameters<typeof TitleBar>[0] = {
    plat: "win",
    onAction: vi.fn(),
    win: makeWin(),
    ...overrides,
  };
  return { props, ...render(<TitleBar {...props} />) };
}

afterEach(cleanup);

describe("TitleBar（win/linux 自绘标题栏）", () => {
  it("三钮 + 拖拽区 + 汉堡；aria 标签齐全", () => {
    renderBar();
    expect(screen.getByTestId("titlebar-minimize")).toBeTruthy();
    expect(screen.getByTestId("titlebar-maximize")).toBeTruthy();
    expect(screen.getByTestId("titlebar-close")).toBeTruthy();
    const drag = document.querySelector(".titlebar-drag");
    expect(drag?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(screen.getByTestId("titlebar-menu-btn").getAttribute("aria-expanded")).toBe("false");
  });

  it("窗口控制：最小化/最大化/关闭各走各的 API", () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByTestId("titlebar-minimize"));
    expect(props.win!.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("titlebar-maximize"));
    expect(props.win!.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("titlebar-close"));
    expect(props.win!.close).toHaveBeenCalledTimes(1);
  });

  it("汉堡展开完整菜单（registry 全表 + 键位提示）；动作派发后收起", () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByTestId("titlebar-menu-btn"));
    const menu = screen.getByTestId("titlebar-menu");
    expect(menu.querySelectorAll(".titlebar-menu-item").length).toBe(ACTIONS.length + FEATURE_COMMANDS.length);
    expect(screen.getByText("Ctrl+K")).toBeTruthy();
    expect(screen.getByText("Ctrl+,")).toBeTruthy();

    fireEvent.click(screen.getByText("设置"));
    expect(props.onAction).toHaveBeenCalledWith("settings.open");
    // 派发后菜单收起
    expect(screen.queryByTestId("titlebar-menu")).toBeNull();
  });

  it("汉格再次点击收起；Esc 收起；外部 mousedown 收起", () => {
    renderBar();
    const btn = screen.getByTestId("titlebar-menu-btn");
    fireEvent.click(btn);
    expect(screen.getByTestId("titlebar-menu")).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.queryByTestId("titlebar-menu")).toBeNull();

    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("titlebar-menu")).toBeNull();

    fireEvent.click(btn);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("titlebar-menu")).toBeNull();
  });

  it("actions 注入缩表 + mac 键位口径（⌘,）", () => {
    const mini: readonly ActionDef[] = [{ id: "settings.open" as ActionId, labelKey: "settings.title" }];
    renderBar({ plat: "mac", actions: mini });
    fireEvent.click(screen.getByTestId("titlebar-menu-btn"));
    expect(screen.getByText("⌘,")).toBeTruthy();
  });
});
