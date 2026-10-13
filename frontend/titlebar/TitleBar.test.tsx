// TitleBar 单测（Task 14）：三钮窗口控制分派、汉堡菜单展开/动作派发/外部收起、
// 拖拽区属性、键位提示平台口径（注入 plat）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Win11 贴靠选择器（2026-10-13）", () => {
  it("最大化按钮 hover 350ms 弹选择器；点击分区分派 onSnap 并收起", async () => {
    const onSnap = vi.fn();
    render(<TitleBar plat="win" onAction={vi.fn()} onSnap={onSnap} />);
    // 悬停锚点域（按钮父容器）起计时
    fireEvent.mouseEnter(screen.getByTestId("titlebar-maximize").parentElement as Element);
    const snap = await waitFor(() => screen.getByTestId("titlebar-snap"));
    expect(snap.getAttribute("aria-label")).toBeTruthy();
    // 三组布局：竖排 2 + 横排 2 + 四宫格 4 = 8 分区
    expect(snap.querySelectorAll(".titlebar-snap-zone").length).toBe(8);
    fireEvent.click(screen.getByTestId("titlebar-snap-left"));
    expect(onSnap).toHaveBeenCalledWith("left");
    expect(screen.queryByTestId("titlebar-snap")).toBeNull(); // 点击后收起
  });

  it("mac 不启用贴靠选择器（原生窗口本就有系统贴靠）", () => {
    render(<TitleBar plat="mac" onAction={vi.fn()} onSnap={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId("titlebar-maximize").parentElement as Element);
    expect(screen.queryByTestId("titlebar-snap")).toBeNull();
  });
});
