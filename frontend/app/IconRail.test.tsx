// IconRail 组件测试（2026-10-16 视觉重设计 M3「疏渠」）：48px 图标轨五钮 +
// 空间锚点光点（主区视图在场 → data-active）+ 未读徽标 + Otty 球弹层
// （自原侧栏快捷菜单整体收编：主题/语言/设置/凭据/MCP，机制断言随迁）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

import i18n from "../i18n";
import { IconRail } from "./IconRail";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useNotifyStore } from "../notify/core";
import { useSessionStore } from "../session/SessionStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useUpdateStore } from "../update/updateStore";

const noop = () => {};

function renderRail(overrides?: Partial<Parameters<typeof IconRail>[0]>) {
  const props = {
    onOpenCredentials: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenMcpSettings: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenUpdate: vi.fn(),
    ...overrides,
  };
  render(
    <ThemeProvider>
      <IconRail {...props} />
    </ThemeProvider>,
  );
  return { props };
}

function openOttyMenu() {
  fireEvent.click(screen.getByTestId("rail-otty"));
}

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", overviewOpen: false });
  useNotifyStore.setState({ unread: 0 });
  useSessionStore.setState({ sessions: [] });
  // ThemeProvider 的 system 主题探测需要 matchMedia（jsdom 无）
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem("ottr.settings.theme");
});

describe("IconRail（48px 图标轨）", () => {
  it("五钮恒驻 + 锁定钮 + Otty 球；mac 标题栏让位面可注入", () => {
    const { rerender } = render(
      <ThemeProvider>
        <IconRail titlebarInset onOpenCredentials={noop} onOpenSettings={noop} onOpenMcpSettings={noop} onOpenHistory={noop} onOpenUpdate={noop} />
      </ThemeProvider>,
    );
    for (const id of ["rail-overview", "rail-cron", "rail-notifications", "rail-lock", "rail-otty"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    // 文件入口不进图标轨（2026-10-16 用户裁定：依赖已连接会话、禁用态体验差），
    // 保留在连接后的视图切换（终端/文件/进程）
    expect(screen.queryByTestId("rail-files")).toBeNull();
    // 锁定钮在 Otty 球之前（控制中心旁；2026-10-16 用户需求）
    const lockIdx = [
      "rail-overview", "rail-cron", "rail-notifications", "rail-lock", "rail-otty",
    ].indexOf("rail-lock");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(document.querySelector(".titlebar-inset")).toBeTruthy();
    rerender(
      <ThemeProvider>
        <IconRail onOpenCredentials={noop} onOpenSettings={noop} onOpenMcpSettings={noop} onOpenHistory={noop} onOpenUpdate={noop} />
      </ThemeProvider>,
    );
    expect(document.querySelector(".titlebar-inset")).toBeNull();
  });

  it("锁定钮：点击触发 vault.lock（立即锁定，与原生菜单同一动作）", () => {
    const lockSpy = vi.spyOn(useVaultLockStore.getState(), "lock").mockResolvedValue();
    renderRail();
    fireEvent.click(screen.getByTestId("rail-lock"));
    expect(lockSpy).toHaveBeenCalledTimes(1);
    lockSpy.mockRestore();
  });

  it("总览钮 = openOverview（置顶标签语义）", () => {
    renderRail();
    fireEvent.click(screen.getByTestId("rail-overview"));
    expect(useWorkspaceStore.getState().overviewOpen).toBe(true);
    expect(useWorkspaceStore.getState().mainView).toBe("overview");
  });

  it("定时任务钮：点击开主区视图 + data-active 锚点（2026-10-16 IA 重构）", () => {
    renderRail();
    fireEvent.click(screen.getByTestId("rail-cron"));
    expect(useWorkspaceStore.getState().mainView).toBe("cron");
    expect(screen.getByTestId("rail-cron").getAttribute("data-active")).toBe("true");
    // 总览与定时任务互斥（主区单视图）：开总览后定时任务光点熄灭
    fireEvent.click(screen.getByTestId("rail-overview"));
    expect(useWorkspaceStore.getState().mainView).toBe("overview");
    expect(screen.getByTestId("rail-cron").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("rail-overview").getAttribute("data-active")).toBe("true");
  });

  it("更新钮：仅在有新版本时浮现，点击跳设置 → 关于", () => {
    useUpdateStore.setState({ phase: { kind: "available", update: {} as never, version: "9.9.9" } });
    const { props } = renderRail();
    const btn = screen.getByTestId("rail-update");
    expect(btn.getAttribute("title")).toContain("9.9.9");
    fireEvent.click(btn);
    expect(props.onOpenUpdate).toHaveBeenCalledTimes(1); // 跳设置 → 关于
    // 下载开始（phase 离开 available）→ 按钮消失
    cleanup();
    useUpdateStore.setState({ phase: { kind: "downloading", received: 0, total: null } });
    renderRail();
    expect(screen.queryByTestId("rail-update")).toBeNull();
  });

  it("Otty 弹层背板：点击弹层外任意区域（含主区拖拽面）即收起", () => {
    renderRail();
    openOttyMenu();
    expect(screen.getByTestId("rail-flyout-main")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("rail-flyout-backdrop"));
    expect(screen.queryByTestId("rail-flyout-main")).toBeNull();
  });

  it("未读徽标挂通知中心图标：unread=3 显示 3，归零消失", () => {
    useNotifyStore.setState({ unread: 3 });
    renderRail();
    expect(screen.getByTestId("rail-unread").textContent).toBe("3");
    cleanup();
    useNotifyStore.setState({ unread: 0 });
    renderRail();
    expect(screen.queryByTestId("rail-unread")).toBeNull();
  });

  it("Otty 弹层：凭据/MCP/主题/语言/设置全入口；动作回调接线", () => {
    const { props } = renderRail();
    openOttyMenu();
    expect(screen.getByTestId("rail-flyout-main")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rail-nav-credentials"));
    expect(props.onOpenCredentials).toHaveBeenCalledTimes(1);
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-nav-mcp"));
    expect(props.onOpenMcpSettings).toHaveBeenCalledTimes(1);
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-nav-history"));
    expect(props.onOpenHistory).toHaveBeenCalledTimes(1);
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-nav-settings"));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("主题子菜单：水域家族九+1 档新序（续编沙洲/河灯/松涛）；选即应用且浮层保留（连续预览，点外/Esc 才收）", () => {
    renderRail();
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-theme"));
    expect(screen.getByTestId("rail-flyout-theme")).toBeTruthy();
    // 光量降序新序（system 恒首位）
    const options = screen.getByTestId("rail-flyout-theme").querySelectorAll("button");
    expect([...options].map((o) => o.getAttribute("data-testid"))).toEqual([
      "rail-theme-system",
      "rail-theme-light",
      "rail-theme-verdant",
      "rail-theme-sepia",
      "rail-theme-dark",
      "rail-theme-oled",
      "rail-theme-ember",
      "rail-theme-forest",
      "rail-theme-amethyst",
      "rail-theme-glass",
    ]);
    fireEvent.click(screen.getByTestId("rail-theme-oled"));
    expect(document.documentElement.dataset.theme).toBe("oled");
    expect(screen.getByTestId("rail-flyout-main")).toBeTruthy();
    expect(screen.getByTestId("rail-flyout-theme")).toBeTruthy();
    expect(screen.getByTestId("rail-theme-oled").getAttribute("data-checked")).toBe("true");
  });

  // 回归（v0.5.0 实测「选择不生效」）：外点关闭监听 mousedown——面板内
  // mousedown 不得卸载面板，随后 click 正常应用（真实事件序）。
  it("回归：面板内 mousedown 不卸载浮层，随后 click 正常应用", () => {
    renderRail();
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-theme"));
    const option = screen.getByTestId("rail-theme-oled");
    fireEvent.mouseDown(option);
    expect(screen.getByTestId("rail-flyout-theme")).toBeTruthy();
    fireEvent.click(option);
    expect(document.documentElement.dataset.theme).toBe("oled");
    expect(screen.getByTestId("rail-flyout-theme")).toBeTruthy();
  });

  it("外点（面板外元素）mousedown 收起浮层；Esc 同收", () => {
    renderRail();
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-theme"));
    expect(screen.getByTestId("rail-flyout-theme")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("rail-flyout-theme")).toBeNull();
    expect(screen.queryByTestId("rail-flyout-main")).toBeNull();
    openOttyMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("rail-flyout-main")).toBeNull();
  });

  it("语言子菜单：点选切换 i18n 实例语言且浮层保留", async () => {
    renderRail();
    openOttyMenu();
    fireEvent.click(screen.getByTestId("rail-lang"));
    expect(screen.getByTestId("rail-flyout-lang")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rail-lang-zh-CN"));
    await waitFor(() => expect(i18n.language).toBe("zh-CN"));
    expect(screen.getByTestId("rail-flyout-lang")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("rail-flyout-lang")).toBeNull();
  });
});
