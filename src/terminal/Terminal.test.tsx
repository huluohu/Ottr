// 终端体验层组件测试（Task 8 Step 3/4）：粘贴确认弹层（多行/危险两态）、
// 右键菜单模型与渲染（含编码子菜单）、SessionTerminal 上右键唤起菜单、
// 主题实时跟随（system 模式 OS 切换 → xterm theme）与 TerminalArea 分隔条/⌘F。
// xterm 在 jsdom 里 open() 会失败（Terminal.tsx 已容错），DOM 交互面不受影响；
// ThemeProvider 需 matchMedia（jsdom 不实现）→ 最小 stub。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

// xterm 实例捕获：主题跟随测试需要读到 term.options.theme（实例不出组件面，
// 子类只记录不改行为，对既有用例透明）。
vi.mock("@xterm/xterm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xterm/xterm")>();
  const captured: InstanceType<typeof mod.Terminal>[] = [];
  class Terminal extends mod.Terminal {
    constructor(...args: ConstructorParameters<typeof mod.Terminal>) {
      super(...args);
      captured.push(this);
    }
    static __captured = captured;
  }
  return { ...mod, Terminal };
});

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
import { terminalThemes } from "../theme/terminal-themes";
import { findGalleryTheme } from "../theme/gallery";
import { resetTerminalThemeStoreForTest, useTerminalThemeStore } from "../theme/terminalThemeStore";
import { applyTermTheme, ContextMenuView, PasteConfirmDialog, SessionTerminal, TerminalArea } from "./Terminal";
import { buildContextMenu, DEFAULT_TERMINAL_FONT_FAMILY, loadTerminalSettings, saveTerminalSettings } from "./ContextMenu";
import { completionHistory } from "../history/cache";
import { useSessionStore, type Session } from "../session/SessionStore";
import { Terminal as XTermClass } from "@xterm/xterm";

function capturedTerms(): InstanceType<typeof XTermClass>[] {
  return (XTermClass as unknown as { __captured: InstanceType<typeof XTermClass>[] }).__captured ?? [];
}

function sess(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
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

function i18nT(key: string): string {
  // 菜单工厂的 t 形状只需要单参调用（测试文案断言用）
  return key;
}
// buildContextMenu 签名要 TFunction；测试桩经同形转换（运行时只调单参 key）
const tStub = i18nT as unknown as Parameters<typeof buildContextMenu>[1];

afterEach(() => {
  cleanup();
  resetTerminalThemeStoreForTest();
  useSessionStore.setState({ sessions: [], activeId: null, trees: {}, activePane: {}, searchSessionId: null });
  localStorage.clear();
  saveTerminalSettings({ copyOnSelect: false, completionEnabled: true, fontFamily: null, fontSize: null });
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
      { hasSelection: false, copyOnSelect: true, completionEnabled: true, encoding: "gbk" },
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
    const items = buildContextMenu({ hasSelection: true, copyOnSelect: false, completionEnabled: false, encoding: "utf-8" }, tStub);
    expect(items.find((i) => i.id === "copy")!.disabled).toBe(false);
    for (const id of ["copy", "paste", "search", "clear", "encoding", "splitRight", "splitDown", "closePane"]) {
      expect(items.some((i) => i.id === id), `缺菜单项 ${id}`).toBe(true);
    }
  });
});

describe("ContextMenuView（菜单渲染）", () => {
  it("点击菜单项上抛动作 id；编码子菜单点开并选择", () => {
    const onAction = vi.fn();
    const items = buildContextMenu({ hasSelection: true, copyOnSelect: false, completionEnabled: false, encoding: "utf-8" }, tStub);
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
    const items = buildContextMenu({ hasSelection: false, copyOnSelect: false, completionEnabled: false, encoding: "utf-8" }, tStub);
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
    saveTerminalSettings({ copyOnSelect: true, completionEnabled: true, fontFamily: null, fontSize: null });
    expect(loadTerminalSettings().copyOnSelect).toBe(true);
  });
});

describe("智能补全开关（Task 8 B8）", () => {
  it("菜单模型：completion 项在位且 checked 透传（默认开）", () => {
    const items = buildContextMenu(
      { hasSelection: false, copyOnSelect: false, completionEnabled: true, encoding: "utf-8" },
      tStub,
    );
    const item = items.find((i) => i.id === "completion")!;
    expect(item).toBeTruthy();
    expect(item.checked).toBe(true);
    const off = buildContextMenu(
      { hasSelection: false, copyOnSelect: false, completionEnabled: false, encoding: "utf-8" },
      tStub,
    );
    expect(off.find((i) => i.id === "completion")!.checked).toBe(false);
  });

  it("设置默认值：completionEnabled 默认开；存量 localStorage（无该字段）回退默认开", () => {
    localStorage.clear();
    expect(loadTerminalSettings().completionEnabled).toBe(true);
    // 旧版本存量：只有 copyOnSelect
    localStorage.setItem("ottr.settings.terminal", JSON.stringify({ copyOnSelect: true }));
    const loaded = loadTerminalSettings();
    expect(loaded.copyOnSelect).toBe(true);
    expect(loaded.completionEnabled).toBe(true);
    // 关闭后持久化
    saveTerminalSettings({ copyOnSelect: true, completionEnabled: false, fontFamily: null, fontSize: null });
    expect(loadTerminalSettings().completionEnabled).toBe(false);
  });

  it("I-3 PTY 纯净性（集成）：ghost 显示时按 Tab——write_session 收 suffix 而非 \\t，打字字节原样透传", async () => {
    completionHistory.resetForTests();
    completionHistory.append(5, "docker ps -a");
    useSessionStore.setState({
      sessions: [sess({ id: "tab-b8", hostId: 5, rustId: "pty-b8" })],
      activeId: "tab-b8",
      trees: { "tab-b8": { kind: "leaf", id: "tab-b8" } },
      activePane: { "tab-b8": "tab-b8" },
    });
    const writes: Array<{ id: string; bytes: number[] }> = [];
    mockedInvoke.mockImplementation((cmd: string, args: { id?: string; bytes?: number[] }) => {
      if (cmd === "write_session" && args.bytes) {
        writes.push({ id: args.id ?? "", bytes: args.bytes });
      }
      return Promise.resolve([]); // history_search 等 → 空结果（缓存已被 append 预置）
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-b8" />
      </ThemeProvider>,
    );
    const captured = capturedTerms();
    const term = captured[captured.length - 1];
    const text = (b: number[]) => new TextDecoder().decode(Uint8Array.from(b));
    // 打字：ghost 前置语义透传 → trzsz 空闲透传 → write_session 原样字节
    await act(async () => {
      term.input("d");
      term.input("o");
      term.input("c");
    });
    expect(writes.map((w) => text(w.bytes))).toEqual(["d", "o", "c"]);
    // Tab：ghost 拦截采纳——write_session 收补全剩余文本，\t 不进 PTY
    await act(async () => {
      term.input("\t");
    });
    expect(writes).toHaveLength(4);
    expect(text(writes[3].bytes)).toBe("ker ps -a");
    expect(writes[3].id).toBe("pty-b8");
    // 全程无任何 \t 字节落 PTY
    for (const w of writes) expect(text(w.bytes)).not.toContain("\t");
  });
});

describe("终端字体/字号设置事件（设置页 → 活动终端即时应用）", () => {
  it("ottr://terminal-settings 事件 → options 即时更新；null 事件 → 还原默认", async () => {
    useSessionStore.setState({
      sessions: [sess({ id: "tab-font", hostId: 5, rustId: "pty-font" })],
      activeId: "tab-font",
      trees: { "tab-font": { kind: "leaf", id: "tab-font" } },
      activePane: { "tab-font": "tab-font" },
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-font" />
      </ThemeProvider>,
    );
    const term = capturedTerms()[capturedTerms().length - 1];

    // 换字体 + 大字号
    saveTerminalSettings({ copyOnSelect: false, completionEnabled: true, fontFamily: "Menlo", fontSize: 20 });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ottr://terminal-settings"));
    });
    expect(term.options.fontFamily).toBe("Menlo");
    expect(term.options.fontSize).toBe(20);

    // 切回「系统默认」（null）→ 还原默认字体栈（SF Mono 现代栈，非 xterm 缺省 Courier New）
    saveTerminalSettings({ copyOnSelect: false, completionEnabled: true, fontFamily: null, fontSize: null });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ottr://terminal-settings"));
    });
    expect(term.options.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(term.options.fontSize).toBe(13);
  });
});

describe("applyTermTheme（resolved → xterm theme 映射）", () => {
  it("light/dark 分别取 terminalThemes 对应套", () => {
    const stub = { options: {} as { theme?: (typeof terminalThemes)["light"] } };
    applyTermTheme(stub, "light");
    expect(stub.options.theme).toBe(terminalThemes.light);
    applyTermTheme(stub, "dark");
    expect(stub.options.theme).toBe(terminalThemes.dark);
  });
});

describe("主题实时跟随（system 模式 OS 明暗切换 → xterm theme）", () => {
  it("system 模式下 prefers-color-scheme 变化，终端主题同步换套", async () => {
    // 受控 matchMedia：ThemeProvider 订阅 change 事件，翻转 matches 模拟 OS 切换
    const mqs: Array<{
      matches: boolean;
      media: string;
      listeners: Array<(e: { matches: boolean }) => void>;
      addEventListener: (t: string, l: (e: { matches: boolean }) => void) => void;
      removeEventListener: () => void;
    }> = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => {
        const o = {
          matches: false,
          media: query,
          listeners: [] as Array<(e: { matches: boolean }) => void>,
          addEventListener(_t: string, l: (e: { matches: boolean }) => void) {
            o.listeners.push(l);
          },
          removeEventListener() {},
        };
        mqs.push(o);
        return o;
      }),
    );
    localStorage.clear(); // theme 未设置 → mode=system（默认）
    useSessionStore.setState({
      sessions: [sess({ id: "tab-th" })],
      activeId: "tab-th",
      trees: { "tab-th": { kind: "leaf", id: "tab-th" } },
      activePane: { "tab-th": "tab-th" },
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-th" />
      </ThemeProvider>,
    );
    const terms = capturedTerms();
    const term = terms[terms.length - 1]!;
    expect(term.options.theme).toBe(terminalThemes.light); // 初始 OS=亮

    await act(async () => {
      // matchMedia 在 ThemeProvider 里至少被调两次（state 初值 + effect 订阅），
      // 逐个翻转并广播 change——模拟 OS 级明暗切换
      for (const o of mqs) {
        o.matches = true;
        o.listeners.forEach((l) => l({ matches: true }));
      }
    });
    expect(term.options.theme).toBe(terminalThemes.dark); // 实时换套
  });
});

describe("终端配色选择（Phase 2 Task 9，B2 主题生态）", () => {
  it("选内置画廊套：与界面亮暗解耦，store selection 变化即时换套", async () => {
    useSessionStore.setState({
      sessions: [sess({ id: "tab-gal" })],
      activeId: "tab-gal",
      trees: { "tab-gal": { kind: "leaf", id: "tab-gal" } },
      activePane: { "tab-gal": "tab-gal" },
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-gal" />
      </ThemeProvider>,
    );
    const terms = capturedTerms();
    const term = terms[terms.length - 1]!;
    expect(term.options.theme).toBe(terminalThemes.light); // auto 初值跟随界面（亮）

    await act(async () => {
      useTerminalThemeStore.getState().select("dracula");
    });
    const dracula = findGalleryTheme("dracula")!.theme;
    expect(term.options.theme).toBe(dracula);

    await act(async () => {
      useTerminalThemeStore.getState().select("auto");
    });
    expect(term.options.theme).toBe(terminalThemes.light); // 回 auto 恢复跟随
  });
});

describe("TerminalArea（分屏主区）", () => {
  it("编码徽标：聚焦 pane 的当前编码，点击循环 utf-8→gbk→gb18030 并下发 Rust", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "t-a" })],
      activeId: "t-a",
      trees: { "t-a": { kind: "leaf", id: "t-a" } },
      activePane: { "t-a": "t-a" },
    });
    render(
      <ThemeProvider>
        <TerminalArea />
      </ThemeProvider>,
    );
    const badge = screen.getByTestId("encoding-badge");
    expect(badge.textContent).toBe("UTF-8");
    expect(badge.getAttribute("data-encoding")).toBe("utf-8");

    fireEvent.click(badge); // utf-8 → gbk
    expect(useSessionStore.getState().sessions[0].encoding).toBe("gbk");
    expect(mockedInvoke).toHaveBeenCalledWith("set_session_encoding", {
      id: "pty-1",
      encoding: "gbk",
    });
    expect(screen.getByTestId("encoding-badge").getAttribute("data-encoding")).toBe("gbk");
    expect(screen.getByTestId("encoding-badge").textContent).toBe("GBK");

    fireEvent.click(screen.getByTestId("encoding-badge")); // gbk → gb18030
    expect(useSessionStore.getState().sessions[0].encoding).toBe("gb18030");
    fireEvent.click(screen.getByTestId("encoding-badge")); // gb18030 → utf-8
    expect(useSessionStore.getState().sessions[0].encoding).toBe("utf-8");
  });

  it("编码提示条（Task 9）：提示展示/切换下发，接受记一次性可关", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "t-h", encodingHint: "gbk" })],
      activeId: "t-h",
      trees: { "t-h": { kind: "leaf", id: "t-h" } },
      activePane: { "t-h": "t-h" },
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="t-h" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("encoding-hint").textContent).toContain("GBK");

    fireEvent.click(screen.getByTestId("encoding-hint-accept"));
    const s = useSessionStore.getState().sessions[0];
    expect(s.encoding).toBe("gbk");
    expect(s.encodingHint).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("set_session_encoding", {
      id: "pty-1",
      encoding: "gbk",
    });
    expect(JSON.parse(localStorage.getItem("ottr.encoding.hintDismissed") ?? "[]")).toEqual([1]);
  });

  it("编码提示条：dismiss 只清除提示并持久化，不改编码", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "t-h2", encodingHint: "gbk" })],
      activeId: "t-h2",
      trees: { "t-h2": { kind: "leaf", id: "t-h2" } },
      activePane: { "t-h2": "t-h2" },
    });
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="t-h2" />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByTestId("encoding-hint-dismiss"));
    const s = useSessionStore.getState().sessions[0];
    expect(s.encoding).toBe("utf-8");
    expect(s.encodingHint).toBeNull();
    expect(screen.queryByTestId("encoding-hint")).toBeNull();
    expect(JSON.parse(localStorage.getItem("ottr.encoding.hintDismissed") ?? "[]")).toEqual([1]);
  });

  it("分隔条带 i18n aria 标签与方向；⌘F 呼出活动 pane 的搜索栏", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "t-a" }), sess({ id: "t-b", paneOf: "t-a" })],
      activeId: "t-a",
      trees: {
        "t-a": {
          kind: "split",
          dir: "row",
          ratio: 0.5,
          first: { kind: "leaf", id: "t-a" },
          second: { kind: "leaf", id: "t-b" },
        },
      },
      activePane: { "t-a": "t-a" },
    });
    render(
      <ThemeProvider>
        <TerminalArea />
      </ThemeProvider>,
    );
    const divider = document.querySelector(".split-divider") as HTMLElement;
    expect(divider).toBeTruthy();
    expect(divider.getAttribute("aria-label")).toBeTruthy(); // terminal.splitAria
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");

    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(screen.getByTestId("search-bar")).toBeTruthy();
    expect(useSessionStore.getState().searchSessionId).toBe("t-a");
  });

  it("拖拽分隔条（pointer 事件）回写 setPaneRatio", () => {
    useSessionStore.setState({
      sessions: [sess({ id: "t-a" }), sess({ id: "t-b", paneOf: "t-a" })],
      activeId: "t-a",
      trees: {
        "t-a": {
          kind: "split",
          dir: "row",
          ratio: 0.5,
          first: { kind: "leaf", id: "t-a" },
          second: { kind: "leaf", id: "t-b" },
        },
      },
      activePane: { "t-a": "t-a" },
    });
    render(
      <ThemeProvider>
        <TerminalArea />
      </ThemeProvider>,
    );
    // 布局由 ResizeObserver 驱动（stub 为 no-op）→ jsdom 里 bounds 退化为 0 尺寸，
    // 分隔条 rect = {x:-3, w:6}；把指针拖到远负值 → 原始 ratio 为负，经
    // setPaneRatio 的 clamp 落在 MIN_RATIO（0.15）——验证 pointer 事件确实回写 store。
    const divider = document.querySelector(".split-divider") as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: -100, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: -100, clientY: 0, pointerId: 1 });
    const tree = useSessionStore.getState().trees["t-a"];
    expect(tree.kind === "split" && tree.ratio).toBe(0.15);
  });
});

describe("B11 防呆（Phase 2 Task 11）：危险输入提醒 + 生产 pane 标记", () => {
  it("键入 rm -rf…：行内提醒出现；回车撤；普通命令不弹", async () => {
    useSessionStore.setState({
      sessions: [sess({ id: "tab-b11" })],
      activeId: "tab-b11",
      trees: { "tab-b11": { kind: "leaf", id: "tab-b11" } },
      activePane: { "tab-b11": "tab-b11" },
    });
    mockedInvoke.mockImplementation(() => Promise.resolve([]));
    render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-b11" />
      </ThemeProvider>,
    );
    const term = capturedTerms()[capturedTerms().length - 1]!;
    // 普通命令：全程无提醒
    await act(async () => {
      term.input("ls -la");
    });
    expect(screen.queryByTestId("danger-hint")).toBeNull();
    // 递归强删（red）：提醒出现，带规则名与命中片段
    await act(async () => {
      term.input("\r");
      term.input("rm -rf /tmp/data");
    });
    const hint = screen.getByTestId("danger-hint");
    expect(hint.textContent).toContain("rm -rf /tmp/data");
    // 回车 = 执行 → 提醒撤
    await act(async () => {
      term.input("\r");
    });
    expect(screen.queryByTestId("danger-hint")).toBeNull();
    // 手动关闭路径：再次命中后点 ×
    await act(async () => {
      term.input("sudo -i");
    });
    expect(screen.getByTestId("danger-hint")).toBeTruthy();
    fireEvent.click(screen.getByTestId("danger-hint-dismiss"));
    expect(screen.queryByTestId("danger-hint")).toBeNull();
  });

  it("TerminalArea：生产会话 pane 带 data-production；普通会话无", () => {
    useSessionStore.setState({
      sessions: [
        sess({ id: "tab-prod", isProduction: true }),
        sess({ id: "tab-dev", hostId: 2, hostName: "dev-01", rustId: "pty-dev" }),
      ],
      activeId: "tab-prod",
      trees: {
        "tab-prod": { kind: "leaf", id: "tab-prod" },
        "tab-dev": { kind: "leaf", id: "tab-dev" },
      },
      activePane: { "tab-prod": "tab-prod", "tab-dev": "tab-dev" },
    });
    render(
      <ThemeProvider>
        <TerminalArea />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("term-pane-tab-prod").getAttribute("data-production")).toBe("true");
    expect(screen.getByTestId("term-pane-tab-dev").getAttribute("data-production")).toBeNull();
  });
});
