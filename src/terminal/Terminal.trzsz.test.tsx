// 终端区 trzsz 集成面组件测试（Phase 2 Task 4，B10 下半）：拖拽落点 → 询问对话框
// （trz 上传 / 插入路径 / 取消）、插入路径的 shell 转义、上传启动序列真实走到
// write_session（\x03 + trz\r，checkPathsReadable 走 node:fs 真件）。
// 协议栈本体（TrzszFilter/fsShim）已在各自单测覆盖；这里钉 Terminal.tsx 挂点。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import i18n from "../i18n";
import { ThemeProvider } from "../theme/ThemeContext";
import { useSessionStore, type Session } from "../session/SessionStore";
import { quotePathsForShell, SessionTerminal } from "./Terminal";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

// 拖拽事件源：捕获 onDragDropEvent handler，测试直接喂 payload
let dragHandler: ((ev: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (ev: { payload: unknown }) => void) => {
      dragHandler = handler;
      return Promise.resolve(() => {
        dragHandler = null;
      });
    },
  }),
}));

const mockedInvoke = invoke as unknown as Mock;

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

function writeSessionText(): string {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === "write_session")
    .map(([, args]) => String.fromCharCode(...(args.bytes as number[])))
    .join("");
}

beforeEach(() => {
  dragHandler = null;
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("quotePathsForShell（插入路径转义）", () => {
  it("单引号包裹，内部 ' 转义为 '\\''，多路径空格连接", () => {
    expect(quotePathsForShell(["/tmp/a.txt"])).toBe("'/tmp/a.txt'");
    expect(quotePathsForShell(["/tmp/it's.txt", "/b"])).toBe("'/tmp/it'\\''s.txt' '/b'");
  });
});

describe("终端区拖拽 → 询问对话框（trz 上传 / 插入路径）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottr-trzsz-term-"));
    useSessionStore.setState({
      sessions: [sess({ id: "tab-1" })],
      activeId: "tab-1",
      trees: { "tab-1": { kind: "leaf", id: "tab-1" } },
      activePane: { "tab-1": "tab-1" },
    });
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function feedDrop(paths: string[]) {
    act(() => {
      dragHandler?.({
        payload: { type: "drop", paths, position: { x: 100, y: 100 } },
      });
    });
  }

  function renderTerm() {
    const ret = render(
      <ThemeProvider>
        <SessionTerminal sessionId="tab-1" />
      </ThemeProvider>,
    );
    // jsdom 无 elementFromPoint：stub 返回本 pane（生产 webview 原生实现）
    const host = document.querySelector('.session-term[data-session-id="tab-1"]');
    document.elementFromPoint = (() => host) as typeof document.elementFromPoint;
    return ret;
  }

  it("drop 落点命中本 pane → 对话框出现；「插入路径」经 term.paste 走 write_session", async () => {
    renderTerm();
    await waitFor(() => expect(dragHandler).not.toBeNull());
    feedDrop(["/tmp/a file.txt"]);
    expect(screen.getByTestId("trzsz-drop-dialog")).toBeTruthy();
    expect(screen.getByTestId("trzsz-drop-files").textContent).toContain("a file.txt");
    fireEvent.click(screen.getByTestId("trzsz-drop-insert"));
    await waitFor(() => expect(screen.queryByTestId("trzsz-drop-dialog")).toBeNull());
    // xterm paste → onData → controller（空闲透传）→ write_session
    await waitFor(() => expect(writeSessionText()).toBe("'/tmp/a file.txt'"));
  });

  it("「trz 上传」：真实临时文件 → checkPathsReadable → 发 Ctrl-C + trz 启动串", async () => {
    const file = join(dir, "up.bin");
    await writeFile(file, "payload");
    renderTerm();
    await waitFor(() => expect(dragHandler).not.toBeNull());
    feedDrop([file]);
    fireEvent.click(screen.getByTestId("trzsz-drop-upload"));
    // I-1：拖拽路径无对话框，授权在上传前登记（scope=会话 id，kind=file）
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("trzsz_grant", {
        scope: "tab-1",
        paths: [file],
        kind: "file",
      });
    });
    // uploadFiles：发 \x03 → 200ms → "trz\r"（经 write_session 下发）
    await waitFor(
      () => {
        const text = writeSessionText();
        expect(text).toContain("\x03");
        expect(text).toContain("trz\r");
      },
      { timeout: 3000 },
    );
  });

  it("drop 落点不在本 pane（别的会话）→ 不弹对话框", async () => {
    renderTerm();
    await waitFor(() => expect(dragHandler).not.toBeNull());
    // elementFromPoint 命中别的 pane（stub 返回 tab-2 的属性面）
    document.elementFromPoint = (() =>
      ({ closest: () => ({ getAttribute: () => "tab-2" }) }) as unknown as Element) as typeof document.elementFromPoint;
    feedDrop(["/tmp/x.txt"]);
    expect(screen.queryByTestId("trzsz-drop-dialog")).toBeNull();
  });
});
