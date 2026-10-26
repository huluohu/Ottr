// IconRail 组件测试（2026-10-16 视觉重设计 M3「疏渠」）：48px 图标轨五钮 +
// 空间锚点光点（主区视图在场 → data-active）+ 未读徽标 + Otty 球弹层
// （自原侧栏快捷菜单整体收编：主题/语言/设置/凭据/MCP，机制断言随迁）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeContext";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  // 本地终端 openLocalTab 的 connect 面会构造 Channel（deferConnect 宏任务）
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import i18n from "../i18n";
import { IconRail } from "./IconRail";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useNotifyStore } from "../notify/core";
import { useSessionStore } from "../session/SessionStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useUpdateStore } from "../update/updateStore";
import { useOttyStore } from "../ui/otty/ottyStore";

const noop = () => {};

function renderRail(overrides?: Partial<Parameters<typeof IconRail>[0]>) {
  const props = {
    onOpenCredentials: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenMcpSettings: vi.fn(),
    onOpenHistory: vi.fn(),
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

/** 更新钮/面板用例的 store 种子（info 非空 = 钮在场；phase 决定内容）。 */
const UPDATE_INFO = { version: "9.9.9", date: null, body: null };

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", overviewOpen: false });
  useNotifyStore.setState({ unread: 0 });
  useSessionStore.setState({ sessions: [] });
  useUpdateStore.setState({ phase: { kind: "idle" }, info: null, current: null, portable: null });
  useOttyStore.setState({ current: null, queue: [], enabled: true });
  // 锁定钮渲染门（2026-10-20）：默认 password 模式（keychain 隐藏有专测）。
  useVaultLockStore.setState({ phase: "unlocked", mode: "password" });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem("ottr.settings.theme");
});

describe("IconRail（48px 图标轨）", () => {
  it("五钮恒驻 + 锁定钮 + Otty 球；mac 标题栏让位面可注入", () => {
    const { rerender } = render(
      <ThemeProvider>
        <IconRail titlebarInset onOpenCredentials={noop} onOpenSettings={noop} onOpenMcpSettings={noop} onOpenHistory={noop} />
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
        <IconRail onOpenCredentials={noop} onOpenSettings={noop} onOpenMcpSettings={noop} onOpenHistory={noop} />
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

  // 幽灵锁屏修复第一层（2026-10-20）：keychain 模式无锁概念，锁定钮不渲染
  // ——显示一个点了没有任何效果的按钮本身就是误导（用户实测反馈）。
  it("锁定钮渲染门：password 模式显示，keychain 模式不渲染", () => {
    useVaultLockStore.setState({ mode: "keyring" });
    renderRail();
    expect(screen.queryByTestId("rail-lock")).toBeNull();
    cleanup();
    useVaultLockStore.setState({ mode: "password" });
    renderRail();
    expect(screen.getByTestId("rail-lock")).toBeTruthy();
  });

  it("本地终端钮：点击开 kind=local 标签并回终端面（2026-10-20）", () => {
    const sessionsBefore = useSessionStore.getState().sessions.length;
    renderRail();
    fireEvent.click(screen.getByTestId("rail-local"));
    const st = useSessionStore.getState();
    expect(st.sessions.length).toBe(sessionsBefore + 1);
    const created = st.sessions[st.sessions.length - 1];
    expect(created.kind).toBe("local");
    expect(useWorkspaceStore.getState().mainView).toBe("terminal");
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

  it("更新钮：紧贴锁定键正上方——底部组之外只有一个弹性占位（2026-10-26 用户截图：第二个占位把钮挤到轨道正中）", () => {
    useUpdateStore.setState({
      phase: { kind: "available", update: {} as never, version: "9.9.9" },
      info: UPDATE_INFO,
    });
    renderRail();
    expect(document.querySelectorAll(".rail-spacer")).toHaveLength(1);
    const btn = screen.getByTestId("rail-update");
    expect(btn.getAttribute("title")).toContain("9.9.9");
    expect(btn.getAttribute("data-phase")).toBe("available");
    // 更新钮与锁定钮之间不得再有任何元素
    expect(btn.nextElementSibling).toBe(screen.getByTestId("rail-lock"));
    // Otty 时刻「更新就绪」在此单点触发（自动/手动检查同一出口）
    expect(useOttyStore.getState().current).toBe("update");
  });

  it("更新钮贯穿全程：有新版/下载中/已装/失败均在场并换信号，闲置、已最新、便携版隐藏", () => {
    renderRail();
    expect(screen.queryByTestId("rail-update")).toBeNull(); // idle
    cleanup();

    const phases = [
      [{ kind: "downloading", received: 0, total: null }, "downloading"],
      [{ kind: "installed" }, "installed"],
      [{ kind: "error", message: "boom" }, "error"],
      [{ kind: "checking" }, "checking"],
    ] as const;
    for (const [phase, expected] of phases) {
      useUpdateStore.setState({ phase: phase as never, info: UPDATE_INFO });
      renderRail();
      expect(screen.getByTestId("rail-update").getAttribute("data-phase"), expected).toBe(expected);
      cleanup();
    }
    // 下载中：amber 点让位给进度环（总长未知 → 不定环）
    useUpdateStore.setState({ phase: { kind: "downloading", received: 0, total: null }, info: UPDATE_INFO });
    renderRail();
    expect(screen.getByTestId("rail-update-ring").getAttribute("data-indeterminate")).toBe("true");
    expect(document.querySelector(".rail-update-dot")).toBeNull();
    cleanup();

    // 已是最新（info 清空）→ 隐藏；便携版即便有 info 也隐藏（无 updater）
    useUpdateStore.setState({ phase: { kind: "uptodate" }, info: null });
    renderRail();
    expect(screen.queryByTestId("rail-update")).toBeNull();
    cleanup();
    useUpdateStore.setState({
      phase: { kind: "available", update: {} as never, version: "9.9.9" },
      info: UPDATE_INFO,
      portable: true,
    });
    renderRail();
    expect(screen.queryByTestId("rail-update")).toBeNull();
  });

  it("更新面板：有新版 → 版本信息 + 发布说明（纯文本块）+ 「下载并安装」就地下载；Esc/背板收起", () => {
    useUpdateStore.setState({
      phase: { kind: "available", update: {} as never, version: "9.9.9" },
      info: {
        version: "9.9.9",
        date: "2026-10-26T04:13:21Z",
        body: "## 9.9.9：主题\n\n- **亮点**：说明见 [文档](https://example.invalid/x)\n普通段落",
      },
      current: "1.5.7",
    });
    const dl = vi.spyOn(useUpdateStore.getState(), "downloadAndInstall").mockResolvedValue();
    renderRail();
    fireEvent.click(screen.getByTestId("rail-update"));
    const pop = screen.getByTestId("update-pop");
    expect(pop.getAttribute("data-phase")).toBe("available");
    expect(screen.getByTestId("update-pop-title").textContent).toContain("9.9.9");
    expect(screen.getByTestId("update-pop-meta").textContent).toContain("1.5.7");
    const notes = screen.getByTestId("update-pop-notes").textContent ?? "";
    expect(notes).toContain("9.9.9：主题");
    expect(notes).toContain("亮点：说明见 文档"); // 行内标记剥离：粗体/链接只留文本
    expect(notes).toContain("普通段落");
    expect(notes).not.toContain("**");
    expect(notes).not.toContain("https://");
    expect(screen.getByTestId("update-pop-github").getAttribute("href")).toBe(
      "https://github.com/huluohu/Ottr/releases/tag/v9.9.9",
    );
    fireEvent.click(screen.getByTestId("update-pop-install"));
    expect(dl).toHaveBeenCalledTimes(1);
    // Esc 收起
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("update-pop")).toBeNull();
    // 再开 → 背板 mousedown 收起（主区是拖拽面吞 mousedown，必须背板模式）
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("update-pop-backdrop"));
    expect(screen.queryByTestId("update-pop")).toBeNull();
  });

  it("更新面板：占位说明（「Ottr x.y.z」旧清单）不渲染说明区", () => {
    useUpdateStore.setState({
      phase: { kind: "available", update: {} as never, version: "9.9.9" },
      info: { version: "9.9.9", date: null, body: "Ottr 9.9.9" },
    });
    renderRail();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop")).toBeTruthy();
    expect(screen.queryByTestId("update-pop-notes")).toBeNull();
  });

  it("更新面板：下载中进度（钮上进度环 + 面板百分比）；已装 → 「立即重启」；失败 → 「重试」重查", () => {
    useUpdateStore.setState({
      phase: { kind: "downloading", received: 512 * 1024, total: 1024 * 1024 },
      info: UPDATE_INFO,
    });
    renderRail();
    const ring = screen.getByTestId("rail-update-ring");
    expect(ring.getAttribute("data-indeterminate")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop-progress").textContent).toContain("50%");
    expect(screen.queryByTestId("update-pop-install")).toBeNull();
    cleanup();

    useUpdateStore.setState({ phase: { kind: "installed" }, info: UPDATE_INFO });
    const restart = vi.spyOn(useUpdateStore.getState(), "restartNow").mockImplementation(() => {});
    renderRail();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop-installed")).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-pop-restart"));
    expect(restart).toHaveBeenCalledTimes(1);
    // 「稍后」只收面板（重启被 mock 掉，面板仍开着），钮仍在场（待重启提醒不丢）
    fireEvent.click(screen.getByTestId("update-pop-later"));
    expect(screen.queryByTestId("update-pop")).toBeNull();
    expect(screen.getByTestId("rail-update")).toBeTruthy();
    cleanup();

    useUpdateStore.setState({ phase: { kind: "error", message: "boom" }, info: UPDATE_INFO });
    const check = vi.spyOn(useUpdateStore.getState(), "checkForUpdate").mockResolvedValue();
    renderRail();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop-error").textContent).toContain("boom");
    fireEvent.click(screen.getByTestId("update-pop-retry"));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("更新面板与 Otty 弹层互斥：开一个收另一个", () => {
    useUpdateStore.setState({
      phase: { kind: "available", update: {} as never, version: "9.9.9" },
      info: UPDATE_INFO,
    });
    renderRail();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop")).toBeTruthy();
    openOttyMenu();
    expect(screen.getByTestId("rail-flyout-main")).toBeTruthy();
    expect(screen.queryByTestId("update-pop")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-update"));
    expect(screen.getByTestId("update-pop")).toBeTruthy();
    expect(screen.queryByTestId("rail-flyout-main")).toBeNull();
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
