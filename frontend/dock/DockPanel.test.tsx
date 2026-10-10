// DockPanel 组件测试（UI 批次一 Task 4；2026-10-09 dock 多页签改造重写）：
// 页签共存（切换不卸载不互相关闭）/ 激活切换 / Esc 关活动页 / 页签级与壳级
// 关闭 / keep-alive 隐藏 / 逐面板宽度裁定 / 六实体面板真挂载。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { DockPanel } from "./DockPanel";
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
  useWorkspaceStore.setState({ mainView: "terminal", dockTabs: [], dockActive: null });
  // 默认回空清单后端：任一测试 openDock 都会挂载实体并取数（无实现 invoke
  // 同步返回 undefined 会把 cj_list 解析成 undefined 而炸渲染面）。
  seedEmptyBackend();
});

afterEach(() => {
  cleanup();
});

describe("DockPanel：右侧 dock 多页签壳", () => {
  it("无活动页签不渲染", () => {
    render(<DockPanel />);
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("openDock 渲染对应面板：标题 + 关闭按钮（无自体页签条——切换唯一入口=侧栏）", () => {
    useWorkspaceStore.getState().openDock("forwards");
    render(<DockPanel />);
    const dock = screen.getByTestId("dock-container");
    expect(dock.getAttribute("data-panel")).toBe("forwards");
    expect(screen.getByTestId("dock-title").textContent).toBe("Port forwards");
    expect(screen.getByTestId("dock-close")).toBeTruthy();
    expect(screen.queryByTestId("dock-tabs")).toBeNull();
  });

  it("六实体面板真挂载：openDock 即见实体内容", () => {
    for (const [panel, probe] of [
      ["forwards", "forward-panel"],
      ["jumpchains", "jump-editor"],
      ["cron", "cron-panel"],
      ["alerts", "alert-settings"],
      ["mcp", "mcp-settings"],
      ["notifications", "notify-panel"],
    ] as const) {
      useWorkspaceStore.getState().openDock(panel);
      render(<DockPanel />);
      expect(screen.getByTestId(probe)).toBeTruthy();
      cleanup();
    }
  });

  it("多页签共存：两个面板同时挂载，非活动页隐藏、活动页可见（根治互相覆盖）", () => {
    useWorkspaceStore.getState().openDock("forwards");
    useWorkspaceStore.getState().openDock("cron");
    render(<DockPanel />);
    expect(screen.getAllByTestId("dock-container")).toHaveLength(1);
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("cron");
    // keep-alive：两面板都在 DOM，非活动页 hidden
    expect(screen.getByTestId("dock-pane-forwards").hidden).toBe(true);
    expect(screen.getByTestId("dock-pane-cron").hidden).toBe(false);
  });

  it("store 切换激活（不卸载不重挂），keep-alive 隐藏即时生效", () => {
    useWorkspaceStore.getState().openDock("forwards");
    useWorkspaceStore.getState().openDock("alerts");
    render(<DockPanel />);
    act(() => useWorkspaceStore.getState().openDock("forwards"));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("forwards");
    expect(screen.getByTestId("dock-pane-forwards").hidden).toBe(false);
    expect(screen.getByTestId("dock-pane-alerts").hidden).toBe(true);
  });

  it("Esc 关活动页签（dock 活动时注册，关闭态不劫持全局 Esc）", () => {
    render(<DockPanel />);
    // 关闭态：Esc 不产生任何副作用（无容器可关，也不报错）
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("dock-container")).toBeNull();
    cleanup();

    useWorkspaceStore.getState().openDock("cron");
    render(<DockPanel />);
    expect(screen.getByTestId("dock-container")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useWorkspaceStore.getState().dockTabs).toEqual([]);
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("壳级 ✕ 是唯一关闭入口（关活动页签，页签无内嵌 ✕）", () => {
    useWorkspaceStore.getState().openDock("forwards");
    useWorkspaceStore.getState().openDock("cron");
    useWorkspaceStore.getState().openDock("alerts");
    render(<DockPanel />);
    fireEvent.click(screen.getByTestId("dock-close")); // 壳 ✕ 关活动页（alerts）
    expect(useWorkspaceStore.getState().dockTabs).toEqual(["forwards", "cron"]);
    expect(useWorkspaceStore.getState().dockActive).toBe("cron");
    fireEvent.click(screen.getByTestId("dock-close"));
    expect(useWorkspaceStore.getState().dockTabs).toEqual(["forwards"]);
    expect(useWorkspaceStore.getState().dockActive).toBe("forwards");
  });
});
