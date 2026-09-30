// 终端体验层组件测试（Task 8 Step 3/4）：粘贴确认弹层（多行/危险两态）、
// 右键菜单模型与渲染（含编码子菜单）、SessionTerminal 上右键唤起菜单。
// xterm 在 jsdom 里 open() 会失败（Terminal.tsx 已容错），DOM 交互面不受影响；
// ThemeProvider 需 matchMedia（jsdom 不实现）→ 最小 stub。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue(undefined);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  // jsdom 无 ResizeObserver（xterm fit 观测用）：no-op 即可
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

import i18n from "../i18n";
import { ThemeProvider } from "../theme/ThemeContext";
import { ContextMenuView, PasteConfirmDialog, SessionTerminal } from "./Terminal";
import { buildContextMenu, loadTerminalSettings, saveTerminalSettings } from "./ContextMenu";
import { useSessionStore, type Session } from "../session/SessionStore";

function sess(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
    hostId: 1,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    status: "connected",
    rustId: "pty-1",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    ...over,
  };
}

function i18nT(key: string): string {
  // 菜单工厂的 t 形状只需要单参调用（测试文案断言用）
  return key;
}
// buildContextMenu 签名要 TFunction；测试桩经同形转换（运行时只调单参 key）
const tStub = i18nT as unknown as Parameters<typeof buildContextMenu>[1];

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: [], activeId: null, trees: {}, activePane: {}, searchSessionId: null });
  localStorage.clear();
  saveTerminalSettings({ copyOnSelect: false });
});

describe("PasteConfirmDialog（粘贴确认弹层）", () => {
  it("多行内容：多行警告 + 预览 + 确认回调", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<PasteConfirmDialog text={"export A=1\nexport B=2"} onConfirm={onConfirm} onCancel={onCancel} />);
    // i18n 实际词典（zh 检测依 navigator；两语言都断言结构键）
    expect(screen.getByTestId("paste-confirm")).toBeTruthy();
    expect(screen.getByTestId("paste-preview").textContent).toContain("export B=2");
    expect(screen.queryByTestId("paste-findings")).toBeNull();
    fireEvent.click(screen.getByTestId("paste-confirm-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("危险命令：列出命中规则（ai.danger 词典），确认键为 danger 样式", async () => {
    await i18n.changeLanguage("zh-CN"); // 词典文案断言（en 环境下 pin 回 zh）
    render(<PasteConfirmDialog text={"rm -rf /tmp/x"} onConfirm={() => {}} onCancel={() => {}} />);
    const findings = screen.getByTestId("paste-findings");
    expect(findings.textContent).toContain("rm -rf");
    // kind 经 ai.danger.<kind> 词典本地化（recursive-delete）
    expect(findings.textContent).toContain("递归强制删除");
    const btn = screen.getByTestId("paste-confirm-button");
    expect(btn.className).toContain("btn-danger");
  });
});

describe("buildContextMenu（菜单模型）", () => {
  it("无选中：复制禁用；编码子菜单当前项打勾；选择即复制状态透传", () => {
    const items = buildContextMenu(
      { hasSelection: false, copyOnSelect: true, encoding: "gbk" },
      tStub,
    );
    const copy = items.find((i) => i.id === "copy")!;
    expect(copy.disabled).toBe(true);
    const encoding = items.find((i) => i.id === "encoding")!;
    expect(encoding.children!.find((c) => c.id === "encoding:gbk")!.checked).toBe(true);
    expect(encoding.children!.find((c) => c.id === "encoding:utf-8")!.checked).toBe(false);
    expect(items.find((i) => i.id === "copyOnSelect")!.checked).toBe(true);
  });

  it("有选中：复制可用；简报菜单面齐备（复制/粘贴/搜索/清屏/编码）", () => {
    const items = buildContextMenu({ hasSelection: true, copyOnSelect: false, encoding: "utf-8" }, tStub);
    expect(items.find((i) => i.id === "copy")!.disabled).toBe(false);
    for (const id of ["copy", "paste", "search", "clear", "encoding", "splitRight", "splitDown", "closePane"]) {
      expect(items.some((i) => i.id === id), `缺菜单项 ${id}`).toBe(true);
    }
  });
});

describe("ContextMenuView（菜单渲染）", () => {
  it("点击菜单项上抛动作 id；编码子菜单点开并选择", () => {
    const onAction = vi.fn();
    const items = buildContextMenu({ hasSelection: true, copyOnSelect: false, encoding: "utf-8" }, tStub);
    render(<ContextMenuView x={10} y={10} items={items} onAction={onAction} testPrefix="t1" />);
    expect(screen.getByTestId("ctx-menu-t1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ctx-copy"));
    expect(onAction).toHaveBeenCalledWith("copy");
    // 子菜单：hover 展开由 mouseenter 驱动；点击父项也切换
    fireEvent.mouseEnter(screen.getByTestId("ctx-encoding"));
    fireEvent.click(screen.getByTestId("ctx-encoding:gbk"));
    expect(onAction).toHaveBeenCalledWith("encoding:gbk");
  });

  it("禁用项点击不上抛", () => {
    const onAction = vi.fn();
    const items = buildContextMenu({ hasSelection: false, copyOnSelect: false, encoding: "utf-8" }, tStub);
    render(<ContextMenuView x={0} y={0} items={items} onAction={onAction} testPrefix="t2" />);
    const copy = screen.getByTestId("ctx-copy") as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    fireEvent.click(copy);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("SessionTerminal 右键唤起菜单（集成）", () => {
  it("contextmenu 事件弹出菜单并渲染各动作项；点击关闭动作上抛到 store", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "tab-1" })],
      activeId: "tab-1",
      trees: { "tab-1": { kind: "leaf", id: "tab-1" } },
      activePane: { "tab-1": "tab-1" },
    });
    const closePane = vi.spyOn(useSessionStore.getState(), "closePane");
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-1" />
      </ThemeProvider>,
    );
    const host = document.querySelector(".session-term")!;
    expect(host).toBeTruthy();
    fireEvent.contextMenu(host);
    expect(screen.getByTestId("ctx-menu-tab-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ctx-copy"));
    fireEvent.click(screen.getByTestId("ctx-closePane"));
    expect(closePane).toHaveBeenCalledWith("tab-1");
  });

  it("设置读写：copyOnSelect 开关持久化", () => {
    expect(loadTerminalSettings().copyOnSelect).toBe(false);
    saveTerminalSettings({ copyOnSelect: true });
    expect(loadTerminalSettings().copyOnSelect).toBe(true);
  });
});
