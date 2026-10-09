// App 布局集成测试（原 QuickConnect.test.tsx 的 App 集成面，Task 14 随
// ⌘K 面板并入 palette 迁移至此）：主页骨架渲染 + Ctrl+K 呼出命令面板 +
// refresh 失败横幅。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "./ui/toastStore";
import { save } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// CSV 导出的原生保存框（2026-10-09 交互优化：导出前选落盘路径）。
const saveDialog = save;
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
// 原生菜单动作事件（2026-10-08 菜单栏启用批次）：捕获回调直驱分发测试。
let menuActionHandler: ((e: { payload: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: string }) => void) => {
    if (event === "ottr://menu-action") menuActionHandler = cb;
    return () => {};
  }),
}));
// App 挂载即注册 Tauri 事件监听（Task 7 会话事件）；jsdom 无 Tauri runtime，stub 掉
vi.mock("./session/events", () => ({ initSessionEvents: vi.fn(async () => {}) }));
// Task 10（A5）传输事件同上（漏 mock 会让真 listen() 产生 unhandled rejection）
vi.mock("./files/events", () => ({ initTransferEvents: vi.fn(async () => {}) }));
// Phase 3 Task 1（I-1 转办）：监控采样事件接线同上（jsdom 无 Tauri runtime）
vi.mock("./monitor/events", () => ({ initMonitorEvents: vi.fn(async () => {}) }));
// Phase 3 Task 4（B6）：批量结果事件接线同上（jsdom 无 Tauri runtime）
vi.mock("./batch/events", () => ({ initBatchEvents: vi.fn(async () => {}) }));
// Phase 4 Task 1（缺口①）：cron 事件接线同上（真 listen 在 jsdom 无 Tauri
// 运行时会 unhandled reject）。
vi.mock("./cron/events", () => ({ initCronEvents: vi.fn(async () => {}) }));
// Task 12 通知管线同上：只 stub initNotifyEvents，其余保留真实现。
vi.mock("./notify/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./notify/core")>();
  return { ...mod, initNotifyEvents: vi.fn(async () => {}) };
});
// Phase 3 Task 3（B5）：告警引擎接线（listen ottr://monitor + 进程轮询）与
// 渠道挂载（vault 读 + reveal）在 App 挂载链触发——jsdom 无 runtime，stub 掉。
vi.mock("./notify/rules", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./notify/rules")>();
  return { ...mod, initAlertEngine: vi.fn(async () => {}) };
});
vi.mock("./notify/channelRegistry", () => ({ remountChannels: vi.fn(async () => {}) }));

import "./i18n";
import App from "./App";
import { useVaultStore } from "./vault/store";
import { useWorkspaceStore } from "./workspace/workspaceStore";
import type { Host } from "./vault/api";

const mockedInvoke = invoke as unknown as Mock;

const web: Host = {
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

beforeEach(() => {
  mockedInvoke.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  useVaultStore.setState({ hosts: [], hostGroups: [], credentials: [], loading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App 主页布局（集成）", () => {
  it("渲染骨架：主机树（refresh 后）+ 主区占位；Ctrl+K 呼出/关闭命令面板（顶栏已收敛进菜单栏）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([web]);
      if (cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    render(<App />);
    expect(screen.getByTestId("main-area")).toBeTruthy();
    // refresh 完成后主机树可见；主区 = 欢迎首页（问候 + 快捷卡）
    await waitFor(() => expect(screen.getByText("web-01")).toBeTruthy());
    expect(screen.getByTestId("home-greeting")).toBeTruthy();
    expect(screen.getByTestId("empty-add-host")).toBeTruthy();

    // 选中主机 → 主区切到已选占位
    fireEvent.click(screen.getByText("web-01"));
    expect(screen.getByTestId("main-area").textContent).toContain("Double-click a host");

    // Ctrl+K 呼出命令面板（A12：命令 + 主机双区）
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("command-palette")).toBeTruthy());
    expect(screen.getByText("Commands")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("refresh 失败：主区显示错误横幅", async () => {
    mockedInvoke.mockRejectedValue(new Error("vault locked"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("store-error").textContent).toContain("vault locked"),
    );
  });

  // 评审 M-4（fix round 1/5）终端聚焦守卫：target 在 [data-terminal] 容器内时
  // 全局监听只拦 Shift 系分屏与 ⌘K——裸 Ctrl+D（终端 EOF）必须不被
  // preventDefault（放行 PTY）。
  it("终端聚焦守卫：终端内 Ctrl+D 放行（defaultPrevented=false）、Ctrl+Shift+D 仍拦截、Ctrl+N 被守卫挡", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<App />);
    const term = document.createElement("div");
    term.setAttribute("data-terminal", "");
    document.body.appendChild(term);

    // 裸 Ctrl+D：registry 已不注册 + 守卫双保险 → 事件原样放行（到 PTY）
    expect(fireEvent.keyDown(term, { key: "d", ctrlKey: true })).toBe(true);
    // Ctrl+Shift+D（分屏右）：terminalSafe + 带 Shift → 拦截（preventDefault）
    expect(fireEvent.keyDown(term, { key: "D", ctrlKey: true, shiftKey: true })).toBe(false);
    // ⌘K / Ctrl+K（面板）：terminalSafe 例外 → 拦截
    expect(fireEvent.keyDown(term, { key: "k", ctrlKey: true })).toBe(false);
    // Ctrl+N（新建主机）：非 terminalSafe → 守卫挡下、不拦截
    expect(fireEvent.keyDown(term, { key: "n", ctrlKey: true })).toBe(true);
    // T15：Ctrl+R（history.search，非 terminalSafe）→ 终端内放行（shell 反向
    // 搜索），且历史面板不被呼出
    expect(fireEvent.keyDown(term, { key: "r", ctrlKey: true })).toBe(true);
    expect(screen.queryByTestId("history-search")).toBeNull();

    // 对照：终端外（target = body）Ctrl+N 照常拦截；Ctrl+R 呼出历史面板
    expect(fireEvent.keyDown(document.body, { key: "n", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: "r", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(screen.getByTestId("history-search")).toBeTruthy());
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", {
      query: "",
      hostId: null,
      limit: 50,
    });

    term.remove();
  });
});

// Phase 5 T1 顶栏收纳 → 2026-10-08 菜单栏启用批次的演进：顶栏整排（命令面板/
// 工具/通知/设置/主题）已收敛进原生菜单栏（用户口径：不占内容区空间）。原
// 「工具下拉/主题下拉」交互测试随之退役，等价语义由「原生菜单栏动作分发」
// describe 承担（同源 runToolAction/setMode）；入口齐全性由 menu.rs 单测钉
// （tools_submenu_mirrors_topbar_tools / theme_submenu_lists_all_seven_themes）。

// 2026-10-08 菜单栏启用批次：原生菜单动作（theme.set.* / tool.*）经
// ottr://menu-action 直派单一来源（runToolAction / setMode），与顶栏下拉同源。
describe("App 原生菜单栏动作分发（theme.set.* / tool.*）", () => {
  // App 的菜单监听有 Tauri 运行时门卫（IS_TAURI）——jsdom 下伪造标记放行。
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    menuActionHandler = null;
  });

  function listMock() {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "menu_set_theme") return Promise.resolve();
      if (
        cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" ||
        cmd === "jc_list" || cmd === "pf_list" || cmd === "cj_list" || cmd === "nc_list" ||
        cmd === "ar_list" || cmd === "mcp_grants_list"
      ) {
        return Promise.resolve([]);
      }
      if (cmd === "snippets_list") return Promise.resolve([]);
      if (cmd === "mcp_status") {
        return Promise.resolve({
          enabled: false, listening: false, socket_path: null,
          approvals_pending: 0, grants_count: 0,
        });
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  it("theme.set.<id> 切主题 + menu_set_theme 同步勾选", async () => {
    listMock();
    render(<App />);
    await act(async () => {});
    expect(menuActionHandler).toBeTruthy();
    act(() => menuActionHandler!({ payload: "theme.set.oled" }));
    // data-theme = 主题 id 本体（oled；暗底系 resolved 另算——见 ThemeContext）
    expect(document.documentElement.dataset.theme).toBe("oled");
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("menu_set_theme", { themeId: "oled" }),
    );
    localStorage.removeItem("ottr.settings.theme");
  });

  it("tool.credentials 打开凭据对话框（原顶栏工具下拉主链的菜单等价）", async () => {
    listMock();
    render(<App />);
    await waitFor(() => expect(menuActionHandler).toBeTruthy());
    act(() => menuActionHandler!({ payload: "tool.credentials" }));
    await waitFor(() => expect(screen.getByTestId("credentials-dialog")).toBeTruthy());
  });

  // 用户反馈「通知中心点击无任何响应」的回归钉：菜单动作直派链必须打开面板
  // （2026-10-09 dock 多页签：动作 = openDock 打开/激活；再派一次保持激活——
  // 面板已是页签，不存在「收起」，收起走页签 ✕/壳 ✕/Esc）。
  it("tool.notify-center 打开通知中心 dock 页签；再派一次保持激活", async () => {
    listMock();
    render(<App />);
    await waitFor(() => expect(menuActionHandler).toBeTruthy());
    act(() => menuActionHandler!({ payload: "tool.notify-center" }));
    expect(screen.getByTestId("notify-panel")).toBeTruthy();
    expect(useWorkspaceStore.getState().dockActive).toBe("notifications");
    act(() => menuActionHandler!({ payload: "tool.notify-center" }));
    expect(useWorkspaceStore.getState().dockActive).toBe("notifications");
    expect(screen.getByTestId("notify-panel")).toBeTruthy();
  });

  it("tool.<key> 与顶栏工具下拉同源（openDock 路由）", async () => {
    listMock();
    useWorkspaceStore.setState({ mainView: "terminal", dockTabs: [], dockActive: null });
    render(<App />);
    await act(async () => {});
    expect(menuActionHandler).toBeTruthy();
    act(() => menuActionHandler!({ payload: "tool.cron" }));
    await waitFor(() => expect(useWorkspaceStore.getState().dockActive).toBe("cron"));
  });
});

// theme-suite T1 → 2026-10-08 菜单栏启用批次：「导出主机 CSV」入口收敛到
// 原生工具菜单（tool.export-hosts-csv → runToolAction 同一命令面）。状态条
// 反馈（落盘路径/错误/6 秒自清）语义不变。
describe("App 工具菜单导出主机 CSV（theme-suite T1，菜单栏入口）", () => {
  // 菜单监听门卫（IS_TAURI）：jsdom 伪造运行时标记放行（先例 VaultInitGate.test）。
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    menuActionHandler = null;
  });

  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  function listMock(exportImpl: () => Promise<string>) {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      if (cmd === "export_hosts_csv") return exportImpl();
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  it("菜单动作先弹原生保存框，导出到所选路径并经 Toast 告知；6 秒后自动清除", async () => {
    vi.useFakeTimers();
    try {
      listMock(() => Promise.resolve("/tmp/ottr/hosts-2026.csv"));
      vi.mocked(saveDialog).mockResolvedValue("/tmp/ottr/hosts-2026.csv");
      render(<App />);
      // listen 是立即 resolve 的 mock：一轮 act 即赋值 handler（此处 fake timers
      // 生效中，waitFor 的轮询定时器会被冻结——禁用 waitFor，防超时连锁）。
      await act(async () => {});
      expect(menuActionHandler).toBeTruthy();
      act(() => menuActionHandler!({ payload: "tool.export-hosts-csv" }));
      // 冲刷动态 import + save + invoke promise 链（fake timers 不影响微任务）
      await act(async () => {});
      expect(saveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "ottr-hosts.csv" }),
      );
      expect(mockedInvoke).toHaveBeenCalledWith("export_hosts_csv", {
        path: "/tmp/ottr/hosts-2026.csv",
      });
      const status = screen.getByTestId("toast-stack");
      expect(status.textContent).toContain("/tmp/ottr/hosts-2026.csv");

      // advance 包 act：定时器回调的 setState 需要 act 界内冲刷（React 调度
      // 计时器同样被 fake，裸 advance 后 rerender 不落地）。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(screen.queryByTestId("toast-stack")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("保存框取消：不发起导出、无 Toast（静默返回）", async () => {
    listMock(() => Promise.resolve("/tmp/ottr/hosts-2026.csv"));
    vi.mocked(saveDialog).mockResolvedValue(null);
    render(<App />);
    await act(async () => {});
    act(() => menuActionHandler!({ payload: "tool.export-hosts-csv" }));
    await act(async () => {});
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "export_hosts_csv",
      expect.anything(),
    );
    expect(screen.queryByTestId("toast-stack")).toBeNull();
  });

  it("导出失败：同一 Toast 显示错误文本", async () => {
    listMock(() => Promise.reject(new Error("vault locked")));
    vi.mocked(saveDialog).mockResolvedValue("/tmp/ottr/hosts-2026.csv");
    render(<App />);
    await act(async () => {});
    expect(menuActionHandler).toBeTruthy();
    act(() => menuActionHandler!({ payload: "tool.export-hosts-csv" }));
    await waitFor(() => expect(screen.getByTestId("toast-stack")).toBeTruthy());
    expect(screen.getByTestId("toast-stack").textContent).toContain("vault locked");
  });
});

// UI 批次一 Task 2：工具菜单工作区族条目 → workspaceStore 路由（T14 守卫的
// 实现面——条目→openDock/openMainView 映射；registry 动作 ID 零新增零删除，
// registry.test.ts 原样锁定）。对话框族（凭据/AI/同步）不在此列。
describe("App 工具菜单 → workspace 路由（UI 批次一 Task 2）", () => {
  // 菜单监听门卫（IS_TAURI）：jsdom 伪造运行时标记放行（先例 VaultInitGate.test）。
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    menuActionHandler = null;
  });

  function listMock() {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      // T3：batch 实体视图挂载即拉 snippets（迁主区后的新触发面）
      if (cmd === "snippets_list") return Promise.resolve([]);
      // T4：dock 五实体面板挂载即取数——回空清单（面板空态可渲染）
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
  });

  it("转发/定时任务 → openDock 单槽（后者替换前者）；dock 关闭按钮可用", async () => {
    listMock();
    render(<App />);
    await act(async () => {});
    expect(menuActionHandler).toBeTruthy();

    act(() => menuActionHandler!({ payload: "tool.forwards" }));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("forwards");
    expect(screen.getByTestId("forward-panel")).toBeTruthy(); // T4：实体在 dock 内

    // 多页签（2026-10-09 根治互相覆盖）：开 cron 不替换 forwards——两页签共存，
    // cron 激活、forwards 隐藏（keep-alive）
    act(() => menuActionHandler!({ payload: "tool.cron" }));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("cron");
    expect(screen.getByTestId("cron-panel")).toBeTruthy();
    expect(screen.getByTestId("dock-pane-forwards").hidden).toBe(true);

    fireEvent.click(screen.getByTestId("dock-close")); // 壳 ✕ = 关活动页
    expect(useWorkspaceStore.getState().dockActive).toBe("forwards"); // 活动权移交
    expect(screen.getByTestId("forward-panel")).toBeTruthy(); // keep-alive 仍在
    fireEvent.click(screen.getByTestId("dock-close"));
    expect(screen.queryByTestId("dock-container")).toBeNull();
  });

  it("告警/MCP/跳板链 → openDock 对应面板；总览/批量 → openMainView 主区实体视图", async () => {
    listMock();
    render(<App />);
    await act(async () => {});
    expect(menuActionHandler).toBeTruthy();

    act(() => menuActionHandler!({ payload: "tool.alerts" }));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("alerts");
    expect(screen.getByTestId("alert-settings")).toBeTruthy(); // T4：实体在 dock 内
    act(() => menuActionHandler!({ payload: "tool.mcp" }));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("mcp");
    expect(screen.getByTestId("mcp-settings")).toBeTruthy();
    act(() => menuActionHandler!({ payload: "tool.jump-chains" }));
    expect(screen.getByTestId("dock-container").getAttribute("data-panel")).toBe("jumpchains");
    expect(screen.getByTestId("jump-editor")).toBeTruthy();

    // 总览/批量 = 主区互斥视图（零会话也可开——原对话框语义；T3 起挂实体）。
    // 容器 testid 自 T3 起为实体自带的 overview-panel/batch-panel。
    act(() => menuActionHandler!({ payload: "tool.overview" }));
    expect(screen.getByTestId("overview-panel").getAttribute("data-view")).toBe("overview");
    act(() => menuActionHandler!({ payload: "tool.batch" }));
    expect(screen.getByTestId("batch-panel").getAttribute("data-view")).toBe("batch");
    fireEvent.click(screen.getByTestId("slot-back-terminal"));
    expect(screen.queryByTestId("batch-panel")).toBeNull();
    expect(screen.queryByTestId("overview-panel")).toBeNull();
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host");
  });
});
