// MainArea 路由组件测试（UI 批次一 Task 2；T3 实体迁入）：mainView 五视图切换
// 互斥 / 终端隐藏常驻不变量（切走不卸载、切回恢复）/ filesOnly 覆盖 / 零会话占
// 位面。重_children（xterm/文件/进程/侧栏）mock 成标记节点——本套件只验路由与
// 挂载面；overview/batch 挂真实体（轻组件，T3 迁入的挂载域本体）。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T3：batch 视图挂载即拉 snippets_list——jsdom 无 Tauri runtime，stub 掉
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../terminal/Terminal", () => ({
  TerminalArea: () => <div data-testid="terminal-area" />,
}));
vi.mock("../session/TabBar", () => ({ TabBar: () => <div data-testid="tabbar" /> }));
vi.mock("../files/FilePanel", () => ({ FilePanel: () => <div data-testid="file-panel" /> }));
vi.mock("../monitor/ProcessBrowser", () => ({
  ProcessBrowser: () => <div data-testid="process-browser" />,
}));
vi.mock("../ai/DiagnosePanel", () => ({ DiagnosePanel: () => <div data-testid="diagnose-panel" /> }));
vi.mock("../monitor/MonitorSidebar", () => ({
  MonitorSidebar: () => <div data-testid="monitor-sidebar" />,
}));
vi.mock("../plugins/PluginSidebar", () => ({
  PluginSidebar: () => <div data-testid="plugin-sidebar" />,
}));
vi.mock("../history/RecordToggle", () => ({
  RecordToggle: () => <div data-testid="record-toggle" />,
}));

import "../i18n";
import type { Session } from "../session/SessionStore";
import { useSessionStore } from "../session/SessionStore";
import type { Host } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { MainArea } from "./MainArea";
import { useWorkspaceStore } from "./workspaceStore";

/** Host 测试夹具（空态快捷卡用；只填渲染/断言消费的字段面）。 */
function fakeHost(over: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return {
    group_id: null,
    tags: [],
    address: "127.0.0.1",
    port: 2222,
    username: "spike",
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
    ...over,
  };
}

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    hostId: 1,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-1",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    ...over,
  };
}

function seedSessions(list: Session[]) {
  useSessionStore.setState({ sessions: list, activeId: list[0]?.id ?? null });
}

beforeEach(() => {
  useWorkspaceStore.setState({ mainView: "terminal", dockPanel: null });
  useSessionStore.setState({ sessions: [], activeId: null });
  useVaultStore.setState({ hosts: [], hostGroups: [], credentials: [], loading: false, error: null });
});

afterEach(() => {
  cleanup();
});

describe("MainArea：terminal 视图（默认）", () => {
  it("终端可见 + 三侧栏挂载 + 视图切换三按钮", () => {
    seedSessions([fakeSession()]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    expect(screen.getByTestId("terminal-area")).toBeTruthy();
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("false");
    expect(screen.getByTestId("diagnose-panel")).toBeTruthy();
    expect(screen.getByTestId("monitor-sidebar")).toBeTruthy();
    expect(screen.getByTestId("plugin-sidebar")).toBeTruthy();
    expect(screen.getByTestId("view-terminal").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("view-files")).toBeTruthy();
    expect(screen.getByTestId("view-processes")).toBeTruthy();
  });

  it("零会话：占位面（选中主机 / 错误横幅）", () => {
    render(
      <MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />,
    );
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host");
    cleanup();
    render(
      <MainArea
        storeError="vault boom"
        selected={null}
        onOpenAiSettings={() => {}}
      />,
    );
    expect(screen.getByTestId("store-error").textContent).toContain("vault boom");
  });
});

describe("MainArea：终端常驻不变量（visibility 制式）", () => {
  it("切 files：终端 DOM 保留但隐藏，FilePanel 挂载，侧栏让位", () => {
    seedSessions([fakeSession()]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("view-files"));
    // 不变量核心断言：终端组件仍在 document（未卸载），仅 data-hidden
    expect(screen.getByTestId("terminal-area")).toBeTruthy();
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("true");
    expect(screen.getByTestId("file-panel")).toBeTruthy();
    expect(screen.queryByTestId("diagnose-panel")).toBeNull();
    expect(screen.queryByTestId("monitor-sidebar")).toBeNull();
    expect(screen.queryByTestId("plugin-sidebar")).toBeNull();
    // store 单值互斥：files 在场即无进程视图
    expect(screen.queryByTestId("process-browser")).toBeNull();
  });

  it("切 processes：互斥替换 FilePanel；终端仍保留", () => {
    seedSessions([fakeSession()]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    fireEvent.click(screen.getByTestId("view-files"));
    fireEvent.click(screen.getByTestId("view-processes"));
    expect(screen.getByTestId("process-browser")).toBeTruthy();
    expect(screen.queryByTestId("file-panel")).toBeNull();
    expect(screen.getByTestId("terminal-area")).toBeTruthy();
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("true");
  });

  it("切 overview/batch 实体视图（T3 迁入）：终端仍保留；返回按钮恢复终端视图", () => {
    seedSessions([fakeSession()]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    act(() => {
      useWorkspaceStore.getState().openMainView("overview");
    });
    // 容器 testid 自 T3 起为实体自带的 overview-panel/batch-panel（原 main-view-slot 消亡）
    expect(screen.getByTestId("overview-panel").getAttribute("data-view")).toBe("overview");
    expect(screen.getByTestId("terminal-area")).toBeTruthy(); // 未卸载
    fireEvent.click(screen.getByTestId("slot-back-terminal"));
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("false");

    act(() => {
      useWorkspaceStore.getState().openMainView("batch");
    });
    expect(screen.getByTestId("batch-panel").getAttribute("data-view")).toBe("batch");
    expect(screen.getByTestId("terminal-area")).toBeTruthy();
  });

  it("切走再切回：同一终端实例（缓冲承载 DOM 不重建）", () => {
    seedSessions([fakeSession()]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    const before = screen.getByTestId("terminal-area");
    fireEvent.click(screen.getByTestId("view-files"));
    fireEvent.click(screen.getByTestId("view-terminal"));
    expect(screen.getByTestId("terminal-area")).toBe(before);
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("false");
  });
});

describe("MainArea：filesOnly 覆盖（FTP/FTPS 无 PTY 终端）", () => {
  it("mainView=terminal 也强制文件视图；终端/进程按钮隐藏", () => {
    seedSessions([fakeSession({ protocol: "ftp" })]);
    render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    expect(screen.getByTestId("file-panel")).toBeTruthy();
    expect(screen.getByTestId("term-holder").getAttribute("data-hidden")).toBe("true");
    expect(screen.queryByTestId("view-terminal")).toBeNull();
    expect(screen.queryByTestId("view-processes")).toBeNull();
    expect(screen.getByTestId("view-files").getAttribute("data-active")).toBe("true");
  });
});

// ui-batch2 Task 1（审计 48/49：文件/进程视图「列表空+终端透出」）：
// 根因有二——①隐藏 holder（absolute inset:0，positioned 带）内的活动 pane 被
// `.term-pane[data-active]` 的 visibility:visible 戳穿，不透明 xterm 画布盖在
// in-flow 面板之上（仅 opacity<1/sticky 等自建 stacking context 的元素透出）；
// ②面板视图下 term-main-row 仍 flex:1，与面板 50/50 均分主区（面板压半高）。
// 修复契约 = 行级 data-yield 标记（files/procs 视图折叠让位；overview/batch
// 的实体视图渲染在行内，不折叠）。jsdom 无布局/绘制引擎，几何级断言不可达，
// CSS 侧由 term-veil-css.test.ts 守卫 + 真窗截图取证（/tmp/ui2-t1/）。
describe("MainArea：面板视图行让位契约（ui2 T1，审计 48/49）", () => {
  it("files/procs 视图：term-main-row data-yield=true（折叠让面板满幅）", () => {
    seedSessions([fakeSession()]);
    const { container } = render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    const row = () => container.querySelector<HTMLElement>(".term-main-row")!;
    expect(row()).toBeTruthy();
    fireEvent.click(screen.getByTestId("view-files"));
    expect(row().getAttribute("data-yield")).toBe("true");
    fireEvent.click(screen.getByTestId("view-processes"));
    expect(row().getAttribute("data-yield")).toBe("true");
  });

  it("terminal 视图与 overview/batch 实体视图：data-yield=false（行内有在流内容）", () => {
    seedSessions([fakeSession()]);
    const { container } = render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    const row = () => container.querySelector<HTMLElement>(".term-main-row")!;
    expect(row().getAttribute("data-yield")).toBe("false");
    act(() => {
      useWorkspaceStore.getState().openMainView("overview");
    });
    expect(row().getAttribute("data-yield")).toBe("false");
    act(() => {
      useWorkspaceStore.getState().openMainView("batch");
    });
    expect(row().getAttribute("data-yield")).toBe("false");
  });

  it("filesOnly（FTP）：文件视图恒开，data-yield=true", () => {
    seedSessions([fakeSession({ protocol: "ftp" })]);
    const { container } = render(<MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />);
    expect(container.querySelector<HTMLElement>(".term-main-row")!.getAttribute("data-yield")).toBe("true");
  });
});

// ui-batch2 Task 3（审计 A4 清偿）：零会话空态从纯文字升级为快捷操作卡——
// 三入口 = 连接夹具（库内有走查夹具端点 127.0.0.1:2222 的 ssh 主机才出现，
// 动作 = 既有 openTab）/ 新建主机（onAddHost → App 的 setForm({mode:"new"})
// 语义）/ ⌘K 命令面板卡（onOpenPalette → setPaletteOpen(true) 语义）。
// 空态判定不变：仍只在 terminalMode=false 且未选中主机的占位面出现，原
// 占位文案（mainArea.placeholder）保留为卡片引导语。
describe("MainArea：空态快捷操作卡（ui2 T3，审计 A4）", () => {
  it("三入口渲染且动作真实可达：夹具→openTab(夹具)、新建→onAddHost、⌘K→onOpenPalette", () => {
    useVaultStore.setState({ hosts: [fakeHost({ id: 1, name: "t12-prod" })] });
    const openTabSpy = vi.fn();
    useSessionStore.setState({ openTab: openTabSpy });
    const onAddHost = vi.fn();
    const onOpenPalette = vi.fn();
    render(
      <MainArea
        storeError={null}
        selected={null}
        onOpenAiSettings={() => {}}
        onAddHost={onAddHost}
        onOpenPalette={onOpenPalette}
      />,
    );
    // 空态判定不变：占位文案仍在（原断言语义保留）
    expect(screen.getByTestId("main-area").textContent).toContain("Pick a host");
    expect(screen.getByTestId("main-empty-actions")).toBeTruthy();

    fireEvent.click(screen.getByTestId("empty-connect-fixture"));
    expect(openTabSpy).toHaveBeenCalledTimes(1);
    expect(openTabSpy.mock.calls[0][0].id).toBe(1);
    expect(screen.getByTestId("empty-connect-fixture").textContent).toContain("t12-prod");

    fireEvent.click(screen.getByTestId("empty-add-host"));
    expect(onAddHost).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("empty-palette-hint"));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("库内无夹具端点主机：连接夹具入口不渲染（入口存在性随库况，端点口径 127.0.0.1:2222）", () => {
    useVaultStore.setState({
      hosts: [
        fakeHost({ id: 2, name: "other", address: "10.0.0.9", port: 22 }),
        fakeHost({ id: 3, name: "wrong-proto", protocol: "ftp" }),
      ],
    });
    const openTabSpy = vi.fn();
    useSessionStore.setState({ openTab: openTabSpy });
    render(
      <MainArea
        storeError={null}
        selected={null}
        onOpenAiSettings={() => {}}
        onAddHost={() => {}}
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.queryByTestId("empty-connect-fixture")).toBeNull();
    expect(screen.getByTestId("empty-add-host")).toBeTruthy();
    expect(screen.getByTestId("empty-palette-hint")).toBeTruthy();
  });

  it("已选中主机分支不渲染快捷卡（空态判定不变：只在未选中占位面出现）", () => {
    useVaultStore.setState({ hosts: [fakeHost({ id: 1, name: "t12-prod" })] });
    render(
      <MainArea
        storeError={null}
        selected={fakeHost({ id: 1, name: "t12-prod" })}
        onOpenAiSettings={() => {}}
        onAddHost={() => {}}
        onOpenPalette={() => {}}
      />,
    );
    expect(screen.queryByTestId("main-empty-actions")).toBeNull();
  });
});
