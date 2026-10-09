// 主区实体视图宽屏布局断言（UI 批次一 Task 3）：总览/批量迁入主区后的容器与
// 宽屏利用回归钉。
// * 容器面（jsdom 可断言）：实体根 = .main-view section（挂载即打开，无
//   overlay/dialog 壳——原顶栏对话框制式的消亡证明）；网格/三栏容器在场。
// * 宽屏列数（jsdom 无布局引擎，沿 tokens.test 的 CSS ?raw 规约断言制式——
//   「数字即规约」）：总览 = grid auto-fill minmax(280px,1fr)（列数随主区宽
//   自适应）；批量三栏 = 树 240px | 命令区 1fr | 结果表 1fr（结果表在场
//   data-has-results 切三栏）+ 窄屏 (max-width:1000px) 退化单列。
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import { allAppCss } from "../styles/all-css";
import "../i18n";
import { OverviewPage } from "../monitor/OverviewPage";
import { BatchPanel } from "../batch/BatchPanel";
import { useBatchStore } from "../batch/batchStore";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { BatchResult } from "../batch/api";
import type { Host } from "../vault/api";

const host: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 2222,
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

const result: BatchResult = {
  batch_id: "b1",
  host_id: 1,
  name: "web-01",
  status: "ok",
  exit_code: 0,
  stdout: "ok\n",
  stderr: "",
  truncated: false,
  duration_ms: 5,
  error: null,
};

beforeEach(() => {
  useVaultStore.setState({ hosts: [host], hostGroups: [], credentials: [], loading: false, error: null });
  useSessionStore.setState({ sessions: [], activeId: null });
  useBatchStore.setState({ batchId: null, total: 0, results: [] });
});

afterEach(cleanup);

/** 提取选择器的规则体（第一个 `{...}`），tokens.test 同款文本解析口径。 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `App.css 缺 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("总览主区视图（宽屏利用）", () => {
  it("容器 = .main-view section 充盈主区（无 overlay/dialog 壳），网格直接铺在视图内", () => {
    render(<OverviewPage onClose={() => {}} onOpen={() => {}} onOpenProcesses={() => {}} />);
    const panel = screen.getByTestId("overview-panel");
    expect(panel.tagName).toBe("SECTION");
    expect(panel.className).toContain("main-view");
    // 原对话框制式已消亡：无 overlay/dialog 祖先
    expect(panel.closest(".overlay")).toBeNull();
    expect(panel.closest(".dialog")).toBeNull();
    // 网格是视图直接子级（不受对话框定宽钳制，宽度充盈由 .main-view flex:1 承担）
    expect(panel.querySelector(":scope > .main-view-head")).toBeTruthy();
    expect(screen.getByTestId("overview-grid").parentElement).toBe(panel);
  });

  it("CSS 规约：卡片网格 auto-fill minmax(280px,1fr)——列数随主区宽度自适应", () => {
    const body = ruleBody(allAppCss(), ".overview-grid {");
    expect(body).toContain("display: grid");
    expect(body).toContain("grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))");
  });
});

describe("批量主区视图（宽屏三栏）", () => {
  it("容器 = .main-view section；三栏 grid：树 | 命令区 | 结果表（有结果 data-has-results 切真）", () => {
    render(<BatchPanel onClose={() => {}} />);
    const panel = screen.getByTestId("batch-panel");
    expect(panel.tagName).toBe("SECTION");
    expect(panel.className).toContain("main-view");
    expect(panel.closest(".overlay")).toBeNull();
    expect(panel.closest(".dialog")).toBeNull();

    const cols = panel.querySelector(".batch-cols")!;
    // 无结果 = 两栏（树 | 命令区）
    expect(cols.getAttribute("data-has-results")).toBe("false");
    expect(cols.querySelector(":scope > .batch-col-hosts")).toBeTruthy();
    expect(cols.querySelector(":scope > .batch-col-form")).toBeTruthy();
    expect(cols.querySelector(":scope > .batch-col-results")).toBeTruthy();

    // 结果表在场 = 三栏
    const results = panel.querySelector(":scope > .batch-cols > .batch-col-results > .batch-results");
    expect(results).toBeNull(); // 初始无结果
    act(() => {
      useBatchStore.setState({ batchId: "b1", total: 1, results: [result] });
    });
    expect(panel.querySelector(".batch-cols")!.getAttribute("data-has-results")).toBe("true");
    expect(screen.getByTestId("batch-results")).toBeTruthy();
  });

  it("CSS 规约：三栏 = 240px | 1fr | 1fr；窄屏 (max-width:1000px) 退化单列", () => {
    const two = ruleBody(allAppCss(), ".batch-cols {");
    expect(two).toContain("display: grid");
    expect(two).toContain("grid-template-columns: 240px minmax(0, 1fr)");

    const three = ruleBody(allAppCss(), '.batch-cols[data-has-results="true"] {');
    expect(three).toContain("grid-template-columns: 240px minmax(0, 1fr) minmax(0, 1fr)");

    // 窄屏退化单列：媒体查询内两选择器都收敛到单列
    const mq = allAppCss().indexOf("@media (max-width: 1000px)");
    expect(mq, "App.css 缺窄屏媒体查询").toBeGreaterThanOrEqual(0);
    const mqBody = allAppCss().slice(mq, allAppCss().indexOf("}", allAppCss().indexOf(".batch-cols[data-has-results", mq)));
    expect(mqBody).toContain(".batch-cols");
    expect(mqBody).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});
