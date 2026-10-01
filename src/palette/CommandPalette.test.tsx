// CommandPalette 单测（Task 14）：命令+主机双区渲染、模糊过滤+高亮、键盘导航
// （↑↓ 循环 / Enter 执行 / Esc 关闭）、动作分派。
// 键位提示注入 plat="win" 断言（jsdom UA 恒 win，提示应显示 Ctrl+K）；
// 词典固定 zh-CN（jsdom navigator.language 是 en-US，changeLanguage 拧回中文）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { CommandPalette } from "./CommandPalette";
import { ACTIONS, type ActionDef, type ActionId } from "../shortcuts/registry";
import type { Host } from "../vault/api";

const web: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: ["prod"],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};
const db: Host = { ...web, id: 2, name: "db-master", address: "10.0.0.2", username: null, tags: [] };

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props: Parameters<typeof CommandPalette>[0] = {
    open: true,
    onClose: vi.fn(),
    hosts: [web, db],
    onConnect: vi.fn(),
    onAction: vi.fn(),
    plat: "win",
    ...overrides,
  };
  const rendered = render(<CommandPalette {...props} />);
  const items = () =>
    Array.from(rendered.container.querySelectorAll<HTMLButtonElement>(".palette-item"));
  const activeIndex = () => items().findIndex((b) => b.dataset.active === "true");
  return { props, items, activeIndex, ...rendered };
}

afterEach(cleanup);

describe("渲染（空查询）", () => {
  it("open=false 不渲染", () => {
    renderPalette({ open: false });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("命令区（registry 全表；B1 起 11 项）+ 主机区，键位提示为 Ctrl 系", () => {
    const { items } = renderPalette();
    expect(screen.getByText("命令面板")).toBeTruthy();
    expect(screen.getByText("新建主机")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
    expect(screen.getByText("web-01")).toBeTruthy();
    expect(screen.getByText("deploy@10.0.0.1:22")).toBeTruthy();
    expect(screen.getByText("Ctrl+K")).toBeTruthy();
    expect(screen.getByText("Ctrl+,")).toBeTruthy();
    expect(screen.getByText("命令")).toBeTruthy();
    expect(screen.getByText("主机")).toBeTruthy();
    // Phase 2 B1（Task 6）：⌘K 面板的「NL 命令」条目（registry ai.nl2cmd）
    expect(screen.getByText("NL 命令")).toBeTruthy();
    expect(screen.getByText("Ctrl+J")).toBeTruthy();
    expect(items().length).toBe(ACTIONS.length + 2);
  });

  it("空主机库只剩命令区，不渲染主机区头", () => {
    renderPalette({ hosts: [] });
    expect(screen.getByText("命令")).toBeTruthy();
    expect(screen.queryByText("主机")).toBeNull();
  });
});

describe("模糊过滤 + 高亮", () => {
  it("查询命中命令标签与主机名，未命中的区整体消失", () => {
    const { items } = renderPalette();
    const input = screen.getByTestId("palette-input");
    fireEvent.input(input, { target: { value: "设置" } });
    expect(screen.getByText("设置")).toBeTruthy();
    expect(items().length).toBe(1);
    expect(screen.queryByText("主机")).toBeNull(); // 主机区无命中 → 区头隐藏

    fireEvent.input(input, { target: { value: "web01" } });
    // 主机名高亮切分（mark 子元素）→ 按 textContent 找按钮
    const hit = items().find((b) => b.textContent === "web-01deploy@10.0.0.1:22");
    expect(hit).toBeTruthy();
    expect(items().length).toBe(1);
    expect(screen.queryByText("命令")).toBeNull(); // 命令区无命中 → 区头隐藏
    expect(screen.getByText("主机")).toBeTruthy();
    expect(hit!.querySelectorAll("mark").length).toBeGreaterThan(0);
  });

  it("主机按次字段（地址）命中，不高亮主字段", () => {
    const { items } = renderPalette();
    fireEvent.input(screen.getByTestId("palette-input"), { target: { value: "10.0.0.2" } });
    const hit = items().find((b) => b.textContent?.includes("db-master"));
    expect(hit).toBeTruthy();
    expect(hit!.querySelectorAll("mark").length).toBe(0); // 地址命中不高亮名称
  });

  it("全不命中显示空态", () => {
    renderPalette();
    fireEvent.input(screen.getByTestId("palette-input"), { target: { value: "zzzz" } });
    expect(screen.getByText("无匹配结果")).toBeTruthy();
  });
});

describe("键盘导航", () => {
  it("ArrowDown/ArrowUp 在扁平列表移动且循环", () => {
    const { activeIndex } = renderPalette({ hosts: [] });
    const input = screen.getByTestId("palette-input");
    expect(activeIndex()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeIndex()).toBe(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeIndex()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeIndex()).toBe(ACTIONS.length - 1); // 循环到末尾
  });

  it("Enter 执行第 0 项命令（palette.toggle）", () => {
    const { props } = renderPalette({ hosts: [] });
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });
    expect(props.onAction).toHaveBeenCalledWith("palette.toggle");
  });

  it("过滤后 Enter 连接命中的主机", () => {
    const { props } = renderPalette();
    const input = screen.getByTestId("palette-input");
    fireEvent.input(input, { target: { value: "db" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onConnect).toHaveBeenCalledWith(db);
  });

  it("过滤收缩后 activeIndex 夹回有效区（先下移再过滤到单命令）", () => {
    const { props } = renderPalette({ hosts: [] });
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // activeIndex=2
    fireEvent.input(input, { target: { value: "设" } }); // 收缩到 1 项（设置）
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onAction).toHaveBeenCalledWith("settings.open");
  });

  it("Escape / 点击遮罩关闭", () => {
    const { props } = renderPalette();
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByTestId("command-palette"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("点击主机条目连接；点击命令条目派发动作", () => {
    const { props, items } = renderPalette();
    fireEvent.click(items().find((b) => b.textContent?.includes("web-01"))!);
    expect(props.onConnect).toHaveBeenCalledWith(web);
    fireEvent.click(screen.getByText("设置"));
    expect(props.onAction).toHaveBeenCalledWith("settings.open");
  });
});

describe("动作注入（缩表）", () => {
  it("actions prop 覆盖默认表（汉堡菜单/测试面）", () => {
    const mini: readonly ActionDef[] = [{ id: "app.quit" as ActionId, labelKey: "palette.quit" }];
    renderPalette({ hosts: [], actions: mini });
    expect(screen.getByText("退出 Ottr")).toBeTruthy();
    expect(screen.queryByText("命令面板")).toBeNull();
  });
});
