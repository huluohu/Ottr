// DockPanel 组件测试（UI 批次一 Task 4；承接 T2 DockContainer 骨架测试）：
// dock 单槽渲染 / 面板替换 / 关闭 / 侧栏值不经壳（monitor/plugins 自管挂载，
// 并存语义沿现状）+ 逐面板宽度裁定（380 列表型 / 420 表单矩阵型）+ 五实体
// 面板真挂载（openDock 即见实体内容，不再是占位文案）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { DOCK_PANEL_WIDTH_PX, DockPanel } from "./DockPanel";
import { useWorkspaceStore } from "../workspace/workspaceStore";

const mockedInvoke = invoke as unknown as Mock;

// 实体面板挂载即取数（pf_list/cj_list/nc_list/ar_list/mcp_*）——回空清单，
// 面板各自渲染空态；未知命令仍拒绝（守卫不吞意外调用面）。
function seedEmptyBackend() {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "mcp_status") {
      return Promise.resolve({
        enabled: false,
        listening: false,
        socket_path: null,
        approvals_pending: 0,
        grants_count: 0,
      });
    }
    if (
      cmd === "pf_list" || cmd === "cj_list" || cmd === "nc_list" ||
      cmd === "ar_list" || cmd === "mcp_grants_list"
    ) {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", dockPanel: null });
  // 默认回空清单后端：任一测试 openDock 都会挂载实体并取数（无实现 invoke
  // 同步返回 undefined 会把 cj_list 解析成 undefined 而炸渲染面）。
  seedEmptyBackend();
});

afterEach(() => {
  cleanup();
});

describe("DockPanel：右侧 dock 停靠壳", () => {
  it("dockPanel=null 不渲染", () => {
    render(<DockPanel />);
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("openDock 渲染对应面板：标题（复用既有 i18n 键）+ 关闭按钮 + 宽度裁定", () => {
    useWorkspaceStore.getState().openDock("forwards");
    render(<DockPanel />);
    const dock = screen.getByTestId("dock-container");
    expect(dock.getAttribute("data-panel")).toBe("forwards");
    expect(screen.getByTestId("dock-title").textContent).toBe("Port forwards");
    expect(screen.getByTestId("dock-close")).toBeTruthy();
    expect(dock.getAttribute("style")).toContain("380px");
  });

  it("五实体面板真挂载（T4）：openDock 即见实体内容，不再是占位文案", () => {
    for (const [panel, probe] of [
      ["forwards", "forward-panel"],
      ["jumpchains", "jump-editor"],
      ["cron", "cron-panel"],
      ["alerts", "alert-settings"],
      ["mcp", "mcp-settings"],
    ] as const) {
      useWorkspaceStore.getState().openDock(panel);
      render(<DockPanel />);
      expect(screen.getByTestId(probe)).toBeTruthy();
      expect(screen.queryByText("follow-up task")).toBeNull(); // 占位文案消亡
      cleanup();
    }
  });

  it("宽度表：列表型 380 / 告警与 MCP 420（内容宽度裁定逐面板落位）", () => {
    expect(DOCK_PANEL_WIDTH_PX).toEqual({
      forwards: 380,
      jumpchains: 380,
      cron: 380,
      alerts: 420,
      mcp: 420,
    });
    useWorkspaceStore.getState().openDock("alerts");
    render(<DockPanel />);
    expect(screen.getByTestId("dock-container").getAttribute("style")).toContain("420px");
  });

  it("单槽互斥：openDock 换值即替换（同时只一个 dock）", () => {
    useWorkspaceStore.getState().openDock("forwards");
    useWorkspaceStore.getState().openDock("cron");
    render(<DockPanel />);
    expect(screen.getAllByTestId("dock-container")).toHaveLength(1);
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("cron");
  });

  it("closeDock 关闭；工具菜单语义下 toggleDock 同值也可关", () => {
    useWorkspaceStore.getState().openDock("alerts");
    render(<DockPanel />);
    expect(screen.getByTestId("dock-container")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dock-close"));
    expect(useWorkspaceStore.getState().dockPanel).toBeNull();
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("monitor/plugins 不经 dock 壳（自管侧栏，视觉不变）", () => {
    for (const p of ["monitor", "plugins"] as const) {
      useWorkspaceStore.getState().openDock(p);
      render(<DockPanel />);
      expect(screen.queryByTestId("dock-container")).toBeNull();
      cleanup();
    }
  });
});
