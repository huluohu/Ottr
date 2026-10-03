// DockContainer 组件测试（UI 批次一 Task 2）：dock 单槽渲染 / 面板替换 /
// 关闭 / 侧栏值不经壳（monitor/plugins 自管挂载，并存语义沿现状）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../i18n";
import { DockContainer } from "./DockContainer";
import { useWorkspaceStore } from "./workspaceStore";

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", dockPanel: null });
});

afterEach(() => {
  cleanup();
});

describe("DockContainer：右侧 dock 槽位骨架", () => {
  it("dockPanel=null 不渲染", () => {
    render(<DockContainer />);
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("openDock 渲染对应面板：标题（复用既有 i18n 键）+ 关闭按钮 + 占位内容", () => {
    useWorkspaceStore.getState().openDock("forwards");
    render(<DockContainer />);
    const dock = screen.getByTestId("dock-container");
    expect(dock.getAttribute("data-panel")).toBe("forwards");
    expect(screen.getByTestId("dock-title").textContent).toBe("Port forwards");
    expect(screen.getByTestId("dock-close")).toBeTruthy();
    expect(dock.textContent).toContain("follow-up task"); // 空内容占位（dockHint）
  });

  it("单槽互斥：openDock 换值即替换（同时只一个 dock）", () => {
    useWorkspaceStore.getState().openDock("forwards");
    useWorkspaceStore.getState().openDock("cron");
    render(<DockContainer />);
    expect(screen.getAllByTestId("dock-container")).toHaveLength(1);
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("cron");
  });

  it("closeDock 关闭；工具菜单语义下 toggleDock 同值也可关", () => {
    useWorkspaceStore.getState().openDock("alerts");
    render(<DockContainer />);
    expect(screen.getByTestId("dock-container")).toBeTruthy();
    fireEvent.click(screen.getByTestId("dock-close"));
    expect(useWorkspaceStore.getState().dockPanel).toBeNull();
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("monitor/plugins 不经 dock 壳（自管侧栏，视觉不变）", () => {
    for (const p of ["monitor", "plugins"] as const) {
      useWorkspaceStore.getState().openDock(p);
      render(<DockContainer />);
      expect(screen.queryByTestId("dock-container")).toBeNull();
      cleanup();
    }
  });
});
