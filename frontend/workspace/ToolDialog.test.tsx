// ToolDialog 组件测试（2026-10-12 dock 退役改弹框，接替 DockPanel.test）：
// 单槽开/换/关 / Esc 关弹框 / ✕ 关闭 / 六实体面板真挂载 / 关闭态不渲染。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { ToolDialog } from "./ToolDialog";
import { useWorkspaceStore } from "./workspaceStore";

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
  useWorkspaceStore.setState({ mainView: "terminal", toolDialog: null });
  // 默认回空清单后端：任一测试 openToolDialog 都会挂载实体并取数（无实现
  // invoke 同步返回 undefined 会把 cj_list 解析成 undefined 而炸渲染面）。
  seedEmptyBackend();
});

afterEach(() => {
  cleanup();
});

describe("ToolDialog：工具面板统一弹框壳", () => {
  it("无打开面板不渲染", () => {
    render(<ToolDialog />);
    expect(screen.queryByTestId("tool-dialog")).toBeNull();
  });

  it("openToolDialog 渲染对应面板：模态 overlay + 标题 + 关闭按钮", () => {
    useWorkspaceStore.getState().openToolDialog("forwards");
    render(<ToolDialog />);
    const dlg = screen.getByTestId("tool-dialog");
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("tool-dialog-title").textContent).toBe("Port forwards");
    expect(screen.getByTestId("tool-dialog-close")).toBeTruthy();
  });

  it("六实体面板真挂载：openToolDialog 即见实体内容", () => {
    for (const [panel, probe] of [
      ["forwards", "forward-panel"],
      ["jumpchains", "jump-editor"],
      ["cron", "cron-panel"],
      ["alerts", "alert-settings"],
      ["notifications", "notify-panel"],
      ["notifications", "notify-panel"],
    ] as const) {
      useWorkspaceStore.getState().openToolDialog(panel);
      render(<ToolDialog />);
      expect(screen.getByTestId(probe)).toBeTruthy();
      cleanup();
    }
  });

  it("单槽替换：开 cron 后 forwards 不再挂载（一次一个，无 keep-alive 残留）", () => {
    useWorkspaceStore.getState().openToolDialog("forwards");
    render(<ToolDialog />);
    act(() => useWorkspaceStore.getState().openToolDialog("cron"));
    expect(screen.getByTestId("tool-dialog").getAttribute("data-panel")).toBe("cron");
    expect(screen.getByTestId("cron-panel")).toBeTruthy();
    expect(screen.queryByTestId("forward-panel")).toBeNull();
  });

  it("Esc 关弹框（打开时注册；关闭态不劫持全局 Esc）", () => {
    render(<ToolDialog />);
    // 关闭态：Esc 不产生任何副作用（无容器可关，也不报错）
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("tool-dialog")).toBeNull();
    cleanup();

    useWorkspaceStore.getState().openToolDialog("cron");
    render(<ToolDialog />);
    expect(screen.getByTestId("tool-dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useWorkspaceStore.getState().toolDialog).toBeNull();
    expect(screen.queryByTestId("tool-dialog")).toBeNull();
  });

  it("✕ 是唯一壳级关闭入口（点 ✕ → toolDialog 置空）", () => {
    useWorkspaceStore.getState().openToolDialog("forwards");
    render(<ToolDialog />);
    fireEvent.click(screen.getByTestId("tool-dialog-close"));
    expect(useWorkspaceStore.getState().toolDialog).toBeNull();
    expect(screen.queryByTestId("tool-dialog")).toBeNull();
  });
});
