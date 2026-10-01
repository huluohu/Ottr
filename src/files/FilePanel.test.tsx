// FilePanel 组件测试（Task 10 Step 4）：双栏渲染 / 路径栏导航 / 右键菜单 /
// 操作对话框（mkdir/chmod/delete 走 Rust 命令）。invoke 全量 mock。
// Phase 2 Task 3 增补：右键「编辑」挂点 + 冲突对话框（fake timers 驱动轮询）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// 拖拽监听依赖 Tauri webview API：组件测试隔离（jsdom 无 __TAURI_INTERNALS__）
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));

import "../i18n";
import { FilePanel } from "./FilePanel";
import { EDIT_POLL_MS, remoteEdits } from "./RemoteEdit";
import type { Session } from "../session/SessionStore";

const mockedInvoke = invoke as unknown as Mock;

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "tab-1",
    hostId: 1,
    hostName: "web-01",
    address: "127.0.0.1",
    port: 2222,
    username: "spike",
    status: "connected",
    rustId: "pty-0",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    ...over,
  };
}

const remoteEntries = [
  { name: "src", is_dir: true, size: 4096, mode: 0o40755, mtime: 1700000000 },
  { name: "big100", is_dir: false, size: 104857600, mode: 0o100644, mtime: 1700000000 },
];
const localEntries = [
  { name: "Downloads", is_dir: true, size: 0, mode: 0o40755, mtime: 1700000000 },
  { name: "notes.txt", is_dir: false, size: 42, mode: 0o100644, mtime: 1700000000 },
];

/** local_list / sftp_list / realpath 按（命令, 路径）分派。 */
function mockListings() {
  mockedInvoke.mockImplementation((_cmd: string, args: { path?: string; id?: string }) => {
    const cmd = _cmd;
    if (cmd === "local_home") return Promise.resolve("/Users/me");
    if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
    if (cmd === "local_list") {
      return Promise.resolve(args.path === "/Users/me" ? localEntries : []);
    }
    if (cmd === "sftp_list") {
      return Promise.resolve(args.path === "/home/spike" ? remoteEntries : []);
    }
    return Promise.resolve(undefined as unknown as never);
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  cleanup();
  remoteEdits.resetForTests();
  vi.useRealTimers();
});

describe("FilePanel", () => {
  it("未连接：显示提示，不发起任何 SFTP 命令", () => {
    mockListings();
    render(<FilePanel session={makeSession({ rustId: null, status: "disconnected" })} />);
    expect(screen.getByTestId("file-panel-hint").textContent).toContain("not connected");
    expect(mockedInvoke).not.toHaveBeenCalledWith("sftp_list", expect.anything());
  });

  it("双栏渲染：本地/远端条目、目录标记、大小与权限形态", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt");
    });
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    const remoteList = screen.getByTestId("file-list-remote");
    expect(remoteList.textContent).toContain("src");
    expect(remoteList.textContent).toContain("100 MB");
    expect(remoteList.textContent).toContain("rw-r--r--");
    expect(mockedInvoke).toHaveBeenCalledWith("sftp_realpath", { id: "pty-0", path: "." });
  });

  it("路径栏 Enter 导航远端目录", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    mockedInvoke.mockImplementation((_cmd: string, args: { path?: string }) => {
      if (_cmd === "sftp_list") {
        return Promise.resolve(
          args.path === "/home/spike/src"
            ? [{ name: "main.rs", is_dir: false, size: 7, mode: 0o100644, mtime: 1 }]
            : [],
        );
      }
      return Promise.resolve([]);
    });
    const inputs = screen.getAllByLabelText("Remote path");
    fireEvent.change(inputs[0], { target: { value: "/home/spike/src" } });
    fireEvent.keyDown(inputs[0], { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("main.rs");
    });
    expect(mockedInvoke).toHaveBeenCalledWith("sftp_list", {
      id: "pty-0",
      path: "/home/spike/src",
    });
  });

  it("右键远端条目出菜单；chmod 对话框回写 sftp_chmod（八进制）", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.contextMenu(screen.getByText("big100"));
    const menu = screen.getByTestId("file-ctx-menu");
    expect(menu.textContent).toContain('Change permissions of "big100"');
    fireEvent.click(screen.getByText(/Change permissions of "big100"/));
    const input = screen.getByTestId("file-dialog-input") as HTMLInputElement;
    expect(input.value).toBe("644");
    fireEvent.change(input, { target: { value: "600" } });
    mockedInvoke.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_chmod", {
        id: "pty-0",
        path: "/home/spike/big100",
        mode: 0o600,
      });
    });
  });

  it("删除走确认对话框（delete 无输入框），确认后 sftp_remove", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.contextMenu(screen.getByText("big100"));
    fireEvent.click(screen.getByText(/Delete "big100"/));
    expect(screen.queryByTestId("file-dialog-input")).toBeNull();
    expect(screen.getByTestId("file-dialog").textContent).toContain("cannot be undone");
    mockedInvoke.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_remove", {
        id: "pty-0",
        path: "/home/spike/big100",
        isDir: false,
      });
    });
  });

  it("工具栏下载：双击/下载按钮 → sftp_download（local 缺省落下载目录）", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.click(screen.getByText("big100"));
    mockedInvoke.mockResolvedValueOnce({
      transfer_id: "xfer-1",
      local_path: "/Users/me/Downloads/big100",
      remote_path: "/home/spike/big100",
      total: 104857600,
    });
    fireEvent.click(screen.getByTestId("fb-download"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_download", {
        id: "pty-0",
        remote: "/home/spike/big100",
        local: null,
      });
    });
    expect(await screen.findByTestId("file-notice").then((el) => el.textContent)).toContain(
      "Downloads",
    );
  });

  it("新建目录对话框：回车提交 sftp_mkdir", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.click(screen.getByTestId("fb-mkdir"));
    const input = screen.getByTestId("file-dialog-input");
    fireEvent.change(input, { target: { value: "newdir" } });
    mockedInvoke.mockImplementation(() => Promise.resolve([]));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_mkdir", {
        id: "pty-0",
        path: "/home/spike/newdir",
      });
    });
  });

  // --- Phase 2 Task 3：右键「编辑」→ 冲突 → 裁定 --------------------------------

  it("右键「编辑」：remote_edit_open 后菜单变「停止编辑」（轮询已启动）", async () => {
    mockListings();
    mockedInvoke.mockImplementation((_cmd: string, args?: { path?: string }) => {
      if (_cmd === "remote_edit_open") {
        return Promise.resolve({ local_path: "/tmp/ottr-edit/pty-0/x/big100" });
      }
      return (mockListingsDispatcher as (cmd: string, a: { path?: string }) => Promise<unknown>)(
        _cmd,
        args ?? { path: "" },
      );
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.contextMenu(screen.getByText("big100"));
    expect(screen.getByTestId("file-ctx-menu").textContent).toContain('Edit "big100"');
    fireEvent.click(screen.getByText(/Edit "big100"/));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_open", {
        id: "pty-0",
        remote: "/home/spike/big100",
      });
    });
    expect(await screen.findByTestId("file-notice").then((el) => el.textContent)).toContain(
      "Editing",
    );
    // 重新右键：同一文件现在应显示「停止编辑」
    fireEvent.contextMenu(screen.getByText("big100"));
    expect(screen.getByTestId("file-ctx-menu").textContent).toContain('Stop editing "big100"');
    mockedInvoke.mockClear();
    fireEvent.click(screen.getByText(/Stop editing "big100"/));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_close", {
        id: "pty-0",
        remote: "/home/spike/big100",
      });
    });
  });

  it("冲突对话框：轮询报 conflict 弹「覆盖？」；覆盖 → remote_edit_save(force)，保留 → dismiss", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockImplementation((_cmd: string, args?: { path?: string; remote?: string }) => {
      if (_cmd === "remote_edit_open") {
        return Promise.resolve({ local_path: "/tmp/ottr-edit/pty-0/x/big100" });
      }
      if (_cmd === "remote_edit_poll") {
        return Promise.resolve({ status: "conflict" });
      }
      return (mockListingsDispatcher as (cmd: string, a: { path?: string }) => Promise<unknown>)(
        _cmd,
        args ?? { path: "" },
      );
    });
    render(<FilePanel session={makeSession()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    fireEvent.contextMenu(screen.getByText("big100"));
    fireEvent.click(screen.getByText(/Edit "big100"/));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // 轮询到 conflict → 对话框
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    });
    const dialog = screen.getByTestId("file-dialog");
    expect(dialog.textContent).toContain("Remote file changed");
    expect(dialog.textContent).toContain("Overwrite the remote copy");
    // 「保留本地」→ remote_edit_dismiss（Rust 记账，轮询不重弹）
    fireEvent.click(screen.getByTestId("conflict-keep"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_dismiss", {
      id: "pty-0",
      remote: "/home/spike/big100",
    });
    expect(screen.queryByTestId("file-dialog")).toBeNull();
    // 再次冲突（mock 常返 conflict，等价「远端又一次被改」）→ 「覆盖远端」→
    // remote_edit_save force:true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDIT_POLL_MS);
    });
    expect(screen.getByTestId("file-dialog").textContent).toContain("Remote file changed");
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("remote_edit_save", {
      id: "pty-0",
      remote: "/home/spike/big100",
      force: true,
    });
    expect(screen.queryByTestId("file-dialog")).toBeNull();
  });

  it("超限拒绝（M-1）：remote_edit_open 报 too large → 专用提示，不起轮询", async () => {
    mockListings();
    mockedInvoke.mockImplementation((_cmd: string, args?: { path?: string }) => {
      if (_cmd === "remote_edit_open") {
        return Promise.reject(new Error("file too large to edit (20971520 bytes > 10485760): /x"));
      }
      return (mockListingsDispatcher as (cmd: string, a: { path?: string }) => Promise<unknown>)(
        _cmd,
        args ?? { path: "" },
      );
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.contextMenu(screen.getByText("big100"));
    fireEvent.click(screen.getByText(/Edit "big100"/));
    await waitFor(() => {
      expect(screen.getByTestId("file-notice").textContent).toContain("too large to edit");
    });
    expect(remoteEdits.isActive("pty-0", "/home/spike/big100")).toBe(false);
  });
});

/** mockListings 的分发体（编辑流用例复用同一目录数据）。 */
function mockListingsDispatcher(_cmd: string, args: { path?: string }): Promise<unknown> {
  if (_cmd === "local_home") return Promise.resolve("/Users/me");
  if (_cmd === "sftp_realpath") return Promise.resolve("/home/spike");
  if (_cmd === "local_list") {
    return Promise.resolve(args.path === "/Users/me" ? localEntries : []);
  }
  if (_cmd === "sftp_list") {
    return Promise.resolve(args.path === "/home/spike" ? remoteEntries : []);
  }
  return Promise.resolve(undefined as unknown as never);
}
