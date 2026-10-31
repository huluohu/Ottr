// CommandPalette 单测（Task 14）：命令+主机双区渲染、模糊过滤+高亮、键盘导航
// （↑↓ 循环 / Enter 执行 / Esc 关闭）、动作分派。
// 键位提示注入 plat="win" 断言（jsdom UA 恒 win，提示应显示 Ctrl+K）；
// 词典固定 zh-CN（jsdom navigator.language 是 en-US，changeLanguage 拧回中文）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { CommandPalette } from "./CommandPalette";
import { ACTIONS, type ActionDef, type ActionId } from "../shortcuts/registry";
import { FEATURE_COMMANDS } from "../shortcuts/toolsRegistry";
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

  it("命令区（registry 全表 + 工具组 12 项）+ 主机区，键位提示为 Ctrl 系", () => {
    const { items } = renderPalette();
    // 2026-10-18 审计：面板不再列「命令面板」自指条目（见审计重整用例）
    expect(screen.queryByText("命令面板")).toBeNull();
    expect(screen.getByText("新建主机")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
    expect(screen.getByText("web-01")).toBeTruthy();
    expect(screen.getByText("deploy@10.0.0.1:22")).toBeTruthy();
    // palette.toggle 已排除（无 Ctrl+K 提示）；键位提示抽查现存两条
    expect(screen.queryByText("Ctrl+K")).toBeNull();
    expect(screen.getByText("Ctrl+R")).toBeTruthy();
    expect(screen.getByText("Ctrl+,")).toBeTruthy();
    // 浏览态无扁平「命令」总头（评审 P0-4：总头下无直属条目即空组头）——
    // 组节头（连接与会话等）承载结构；主机区头仍在。
    expect(screen.queryByText("命令")).toBeNull();
    expect(screen.getByText("主机")).toBeTruthy();
    // ⌘K 面板的 AI 生成命令条目（registry ai.nl2cmd；2026-10-16 文案通俗化）
    expect(screen.getByText("AI 生成命令")).toBeTruthy();
    expect(screen.getByText("Ctrl+J")).toBeTruthy();
    // 2026-10-18 入口审计：排除集（面板自指/退出/循环切换 ×2）+ 去重（通知
    // 中心两表并存）后，命令条目 = 全表面 - 排除 4 - 去重 1 + 外观 13
    //（三新主题 2026-10-18；ACTIONS 含 tabNext/tabPrev，无需单独加减）
    const excluded = ["palette.toggle", "app.quit", "theme.toggle", "lang.toggle"];
    const expected =
      ACTIONS.filter((a) => !excluded.includes(a.id)).length +
      (FEATURE_COMMANDS.length - 1) +
      14; // 外观组 = 主题 10 + 语言 4（2026-10-31 +文言）
    expect(items().length).toBe(expected + 2);
  });

  it("审计重整（2026-10-18）：无自指/无退出/无重复；主题语言列具体项（外观组）", () => {
    renderPalette({ hosts: [] });
    const labels = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".palette-item")).map(
        (b) => b.textContent ?? "",
      );
    const all = labels();
    // 自指与破坏性动作不入面板（菜单/托盘/汉堡仍可达）
    expect(all.filter((l) => l === "命令面板")).toHaveLength(0);
    expect(all.filter((l) => l.includes("退出"))).toHaveLength(0);
    // 双表去重：通知中心/导入主机各只一份
    expect(all.filter((l) => l.includes("通知中心"))).toHaveLength(1);
    expect(all.filter((l) => l.includes("导入主机"))).toHaveLength(1);
    // 循环切换条目退役
    expect(all.filter((l) => l.includes("切换主题") || l.includes("切换语言"))).toHaveLength(0);
    // 外观组：主题十选（水域家族名，含续编沙洲/松涛/河灯）+ 语言三选（autonym）
    expect(screen.getByText("外观")).toBeTruthy();
    for (const name of [
      "跟随系统", "浅滩", "溪岸", "沙洲", "深河", "深渊", "河灯", "松涛", "夜光河", "雨窗",
      "简体中文", "繁體中文", "English",
    ]) {
      expect(all.filter((l) => l === name)).toHaveLength(1);
    }
  });

  it("空主机库只剩命令区（组节头承载），不渲染主机区头", () => {
    renderPalette({ hosts: [] });
    expect(screen.getByText("连接与会话")).toBeTruthy();
    expect(screen.queryByText("主机")).toBeNull();
  });
});

describe("命令子组与类型图标（批次三 T2，审计 ⌘K 19/20）", () => {
  it("空查询渲染三组节标题，条目按组聚拢（连接 → 面板 → 系统）", () => {
    renderPalette({ hosts: [] });
    expect(screen.getByText("连接与会话")).toBeTruthy();
    expect(screen.getByText("面板与 AI")).toBeTruthy();
    expect(screen.getByText("系统")).toBeTruthy();
    // 组内首条 = 连接组第一项（新建主机是连接类第一动作）
    const items = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".palette-item"));
    expect(items()[0].textContent).toContain("新建主机");
    // 内容驱动定位（registry 数组序 ≠ 分组内序）：导入主机应与新建主机同组
    // （用户裁定：它也是创建的一种形式，与新建并列）
    const groupOf = (text: string) =>
      items().findIndex((b) => b.textContent?.includes(text));
    const newHostIdx = groupOf("新建主机");
    const importIdx = groupOf("导入主机");
    expect(importIdx).toBeGreaterThan(-1);
    // 系统组（设置）必须在连接组全部条目之后
    expect(groupOf("设置")).toBeGreaterThan(groupOf("AI 生成命令"));
    expect(newHostIdx).toBeGreaterThan(-1);
  });

  it("过滤态退扁平相关度排序：子组标题隐藏，命令/主机区头保持", () => {
    renderPalette({ hosts: [] });
    fireEvent.input(screen.getByTestId("palette-input"), { target: { value: "切" } });
    expect(screen.queryByText("连接与会话")).toBeNull();
    expect(screen.queryByText("面板与 AI")).toBeNull();
    expect(screen.queryByText("系统")).toBeNull();
    expect(screen.getByText("命令")).toBeTruthy();
  });

  it("每条目带类型图标（命令/主机两型 SVG，data-icon 区分）", () => {
    renderPalette();
    const icons = document.querySelectorAll<SVGElement>(".palette-icon");
    // 命令（全表面 - 排除 4 - 去重 1 + 外观 13）+ 2 主机
    const excluded = ["palette.toggle", "app.quit", "theme.toggle", "lang.toggle"];
    expect(icons.length).toBe(
      ACTIONS.filter((a) => !excluded.includes(a.id)).length +
        (FEATURE_COMMANDS.length - 1) +
        14 + // 外观组 = 主题 10 + 语言 4
        2,
    );
    const cmdIcon = icons[0];
    expect(cmdIcon.getAttribute("data-icon")).toBe("command");
    const hostIcon = Array.from(icons).find((el) => el.getAttribute("data-icon") === "host");
    expect(hostIcon).toBeTruthy();
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
    // 循环到末尾（条目数 = 全表面 - 排除 4 - 去重 1 + 外观 13）
    const excluded = ["palette.toggle", "app.quit", "theme.toggle", "lang.toggle"];
    expect(activeIndex()).toBe(
      ACTIONS.filter((a) => !excluded.includes(a.id)).length +
        (FEATURE_COMMANDS.length - 1) +
        14 - // 外观组 = 主题 10 + 语言 4
        1,
    );
  });

  it("Enter 执行第 0 项命令（hosts.new——分组后连接组居首）", () => {
    const { props } = renderPalette({ hosts: [] });
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });
    expect(props.onAction).toHaveBeenCalledWith("hosts.new");
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

  it("Esc 焦点不在输入框也能关（全局栈）：焦点在列表项上按 Esc", () => {
    const { props } = renderPalette();
    // 模拟焦点漂移：焦点在列表项按钮上（不经输入框）
    const firstItem = document.querySelector<HTMLButtonElement>(".palette-item");
    firstItem?.focus();
    expect(document.activeElement).toBe(firstItem);
    fireEvent.keyDown(firstItem!, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
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
    // 缩表注入：用未被排除集过滤的动作（app.quit 2026-10-18 起不入面板）
    const mini: readonly ActionDef[] = [{ id: "hosts.new" as ActionId, labelKey: "palette.newHost" }];
    renderPalette({ hosts: [], actions: mini });
    expect(screen.getByText("新建主机")).toBeTruthy();
    expect(screen.queryByText("设置")).toBeNull();
  });
});
