// FilePanel 组件测试（Task 10 Step 4）：双栏渲染 / 路径栏导航 / 右键菜单 /
// 操作对话框（mkdir/chmod/delete 走 Rust 命令）。invoke 全量 mock。
// Phase 2 Task 3 增补：右键「编辑」挂点 + 冲突对话框（fake timers 驱动轮询）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// 拖拽监听依赖 Tauri webview API：组件测试隔离（jsdom 无 __TAURI_INTERNALS__）。
// 回调捕获到 drag.handler 供 OS 拖拽用例直驱（vi.hoisted 保工厂外可见）。
const drag = vi.hoisted(() => ({ handler: null as null | ((ev: unknown) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn((cb: (ev: unknown) => void) => {
      drag.handler = cb;
      return Promise.resolve(() => {});
    }),
  }),
}));

import "../i18n";
import { FilePanel, fileIconKind, modeToPermBits, permBitsToMode, sortFileEntries } from "./FilePanel";
import { EDIT_POLL_MS, remoteEdits } from "./RemoteEdit";
import { useTransferStore, type TransferItem } from "./TransferStore";
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
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-0",
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
  it("FTP 后端切换（Phase 2 Task 5）：同命令面照常工作，编辑入口按协议隐藏", async () => {
    mockListings();
    render(<FilePanel session={makeSession({ protocol: "ftp" })} />);
    // 初载走同一组 sftp_* 命令（Rust 侧按会话表分派到 FtpClient，前端零感知）
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_realpath", { id: "pty-0", path: "." }),
    );
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));

    // 远端条目右键：菜单出现，但**无「编辑」项**（远端编辑是 SFTP 专属能力）
    // 双栏 options 含本地侧：定位远端文件行（big100）再呼出菜单
    const remoteRow = screen
      .getAllByRole("option")
      .find((el) => (el.textContent ?? "").includes("big100"));
    expect(remoteRow).toBeDefined();
    fireEvent.contextMenu(remoteRow!);
    const menu = await screen.findByTestId("file-ctx-menu");
    const labels = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => /edit/i.test(l))).toBe(false);
    expect(labels.some((l) => /download/i.test(l))).toBe(true);
  });

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

  it("右键远端条目出菜单；chmod 九宫格点选即换算，确认回写 sftp_chmod", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    fireEvent.contextMenu(screen.getByText("big100"));
    const menu = screen.getByTestId("file-ctx-menu");
    expect(menu.textContent).toContain('Change permissions of "big100"');
    fireEvent.click(screen.getByText(/Change permissions of "big100"/));
    // 九宫格初值 = 条目当前 mode 644：用户读写有、执行无（2026-10-16 可视化；
    // 用户裁定只留九宫格，八进制输入不显示——mode 由位算回）。
    const bit = (i: number) => screen.getByTestId(`perm-bit-${i}`) as HTMLInputElement;
    expect(bit(0).checked, "用户-读").toBe(true);
    expect(bit(1).checked, "用户-写").toBe(true);
    expect(bit(2).checked, "用户-执行").toBe(false);
    expect(bit(6).checked, "其他-读").toBe(true);
    expect(bit(8).checked, "其他-执行").toBe(false);
    expect(screen.queryByTestId("perm-octal"), "八进制输入不显示").toBeNull();
    // 点选即换算：勾用户执行（→744）再退组读（→704），确认按位回写。
    fireEvent.click(bit(2));
    fireEvent.click(bit(3));
    mockedInvoke.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_chmod", {
        id: "pty-0",
        path: "/home/spike/big100",
        mode: 0o704,
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

  it("二进制拒绝（BL-506）：remote_edit_open 报 binary_file → 专用提示，不起轮询", async () => {
    mockListings();
    mockedInvoke.mockImplementation((_cmd: string, args?: { path?: string }) => {
      if (_cmd === "remote_edit_open") {
        return Promise.reject(new Error("binary_file: /home/spike/big100"));
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
      // 专用提示（zh/en 词典 files.editBinary），不是通用 editFailed 兜底
      expect(screen.getByTestId("file-notice").textContent).toContain("binary file");
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

// 2026-10-16 用户反馈两件套：文件类型图标 + 权限九宫格的纯函数面。
describe("文件类型图标与权限位纯函数", () => {
  it("fileIconKind：目录/文本/图片/压缩包/通用五类；dotfile 去前导点取扩展名", () => {
    expect(fileIconKind({ name: "src", is_dir: true })).toBe("dir");
    expect(fileIconKind({ name: "notes.txt", is_dir: false })).toBe("text");
    expect(fileIconKind({ name: "deploy.sh", is_dir: false })).toBe("text");
    expect(fileIconKind({ name: ".gitignore", is_dir: false })).toBe("text");
    expect(fileIconKind({ name: "photo.PNG", is_dir: false }), "扩展名大小写不敏感").toBe("image");
    expect(fileIconKind({ name: "backup.tar.gz", is_dir: false })).toBe("archive");
    expect(fileIconKind({ name: "ottr", is_dir: false }), "无扩展名二进制 = 通用").toBe("file");
    expect(fileIconKind({ name: "weird.unknownext", is_dir: false })).toBe("file");
  });

  it("modeToPermBits / permBitsToMode 互逆：644 与 755", () => {
    expect(modeToPermBits(0o644)).toEqual([
      true, true, false,
      true, false, false,
      true, false, false,
    ]);
    expect(modeToPermBits(0o755)).toEqual([
      true, true, true,
      true, false, true,
      true, false, true,
    ]);
    expect(permBitsToMode(modeToPermBits(0o644))).toBe(0o644);
    expect(permBitsToMode(modeToPermBits(0o755))).toBe(0o755);
    // 高位文件类型位（0o100644 的 0o100000）不进九宫格
    expect(permBitsToMode(modeToPermBits(0o100644))).toBe(0o644);
  });

  it("行渲染带类型图标：目录 dir / 文本 text / 通用 file（data-icon 钉住）", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => {
      expect(screen.getByTestId("file-list-remote").textContent).toContain("big100");
    });
    const srcRow = screen.getByText("src").closest(".file-row") as HTMLElement;
    expect(srcRow.querySelector('[data-icon="dir"]')).toBeTruthy();
    const txtRow = screen.getByText("notes.txt").closest(".file-row") as HTMLElement;
    expect(txtRow.querySelector('[data-icon="text"]')).toBeTruthy();
    const bigRow = screen.getByText("big100").closest(".file-row") as HTMLElement;
    expect(bigRow.querySelector('[data-icon="file"]')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 文件面板增强（feat/file-panel-enhancements）：排序 / 本地写操作 / OS 拖拽
// 落本地 / 双侧刷新 / 传输完成自动刷新。
// ---------------------------------------------------------------------------
describe("文件面板增强", () => {
  function makeItem(over: Partial<TransferItem>): TransferItem {
    return {
      transferId: "t1",
      kind: "upload",
      remotePath: "/home/spike/x.bin",
      localPath: "/Users/me/x.bin",
      rustId: "pty-0",
      total: 10,
      transferred: 10,
      status: "active",
      error: null,
      cancelling: false,
      startedAt: Date.now(),
      ...over,
    };
  }

  it("排序纯函数：目录恒在前，名称/大小/时间升降翻转，不改输入数组", () => {
    const rows = [
      { name: "b.log", is_dir: false, size: 2, mtime: 1700000002 },
      { name: "folder", is_dir: true, size: 4096, mtime: 1700000001 },
      { name: "a.txt", is_dir: false, size: 30, mtime: 1700000003 },
      { name: "c.zip", is_dir: false, size: 1, mtime: 1700000001 },
    ];
    const nameAsc = sortFileEntries(rows, { key: "name", asc: true });
    expect(nameAsc.map((r) => r.name)).toEqual(["folder", "a.txt", "b.log", "c.zip"]);
    expect(sortFileEntries(rows, { key: "name", asc: false }).map((r) => r.name)).toEqual([
      "folder", "c.zip", "b.log", "a.txt",
    ]);
    expect(sortFileEntries(rows, { key: "size", asc: true }).map((r) => r.name)).toEqual([
      "folder", "c.zip", "b.log", "a.txt",
    ]);
    expect(sortFileEntries(rows, { key: "mtime", asc: true }).map((r) => r.name)).toEqual([
      "folder", "c.zip", "b.log", "a.txt",
    ]);
    expect(sortFileEntries(rows, { key: "mtime", asc: false }).map((r) => r.name)).toEqual([
      "folder", "a.txt", "b.log", "c.zip",
    ]);
    // 输入数组不被改动
    expect(rows[0].name).toBe("b.log");
  });

  it("排序表头：点击切换 key/方向，行序随之重排", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list") return Promise.resolve([]);
      if (cmd === "sftp_list") {
        return Promise.resolve([
          { name: "b.log", is_dir: false, size: 2, mode: 0o100644, mtime: 1700000002 },
          { name: "folder", is_dir: true, size: 4096, mode: 0o40755, mtime: 1700000001 },
          { name: "a.txt", is_dir: false, size: 30, mode: 0o100644, mtime: 1700000003 },
          { name: "c.zip", is_dir: false, size: 1, mode: 0o100644, mtime: 1700000001 },
        ]);
      }
      return Promise.resolve(undefined as unknown as never);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-remote").textContent).toContain("c.zip"));
    const names = () =>
      [...screen.getByTestId("file-list-remote").querySelectorAll(".file-name")].map(
        (el) => el.textContent,
      );
    expect(names()).toEqual(["folder", "a.txt", "b.log", "c.zip"]);
    fireEvent.click(screen.getByTestId("file-sort-remote-name"));
    expect(names()).toEqual(["folder", "c.zip", "b.log", "a.txt"]);
    fireEvent.click(screen.getByTestId("file-sort-remote-size"));
    expect(names()).toEqual(["folder", "c.zip", "b.log", "a.txt"]);
    fireEvent.click(screen.getByTestId("file-sort-remote-mtime"));
    expect(names()).toEqual(["folder", "c.zip", "b.log", "a.txt"]);
    fireEvent.click(screen.getByTestId("file-sort-remote-mtime"));
    expect(names()).toEqual(["folder", "a.txt", "b.log", "c.zip"]);
  });

  it("本地新建文件夹：工具条 → 对话框 → local_mkdir + 本地列刷新", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    fireEvent.pointerDown(screen.getByTestId("file-title-local"));
    fireEvent.click(screen.getByTestId("fb-mkdir-local"));
    fireEvent.change(screen.getByTestId("file-dialog-input"), { target: { value: "新目录" } });
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_mkdir", { path: "/Users/me/新目录" }),
    );
    // 操作后自动重列本地
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_list", { path: "/Users/me" }),
    );
  });

  it("本地删除：选中文件 → 确认对话框 → local_remove(isDir)", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    fireEvent.pointerDown(screen.getByTestId("file-title-local"));
    const row = screen
      .getAllByRole("option")
      .find((el) => (el.textContent ?? "").includes("notes.txt"));
    fireEvent.click(row!);
    fireEvent.click(screen.getByTestId("fb-delete-local"));
    await screen.findByTestId("file-dialog");
    fireEvent.click(screen.getByTestId("file-dialog-confirm"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_remove", {
        path: "/Users/me/notes.txt",
        isDir: false,
      }),
    );
  });

  it("工具条刷新：双侧同时重列", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    mockedInvoke.mockClear();
    fireEvent.click(screen.getByTestId("fb-refresh"));
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("local_list", { path: "/Users/me" });
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_list", { id: "pty-0", path: "/home/spike" });
    });
  });

  it("传输完成自动刷新对应栏：上传 done 重列远端、下载 done 重列本地", async () => {
    mockListings();
    const { unmount } = render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    act(() => {
      useTransferStore.setState({ items: [makeItem({ transferId: "t1", status: "active" })] });
    });
    mockedInvoke.mockClear();
    act(() => {
      useTransferStore.setState({
        items: [makeItem({ transferId: "t1", status: "done" })],
      });
    });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_list", { id: "pty-0", path: "/home/spike" }),
    );
    act(() => {
      useTransferStore.setState({
        items: [makeItem({ transferId: "t2", kind: "download", status: "active" })],
      });
    });
    mockedInvoke.mockClear();
    act(() => {
      useTransferStore.setState({
        items: [makeItem({ transferId: "t2", kind: "download", status: "done" })],
      });
    });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_list", { path: "/Users/me" }),
    );
    act(() => useTransferStore.setState({ items: [] }));
    unmount();
  });

  it("OS 拖拽落本地栏：local_copy 复制进当前目录；目录条目跳过", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    // elementFromPoint 打桩指到本地栏（OS 拖拽落点判定）
    const localPane = screen
      .getByTestId("file-title-local")
      .closest("[data-file-drop]") as HTMLElement;
    // jsdom 无 elementFromPoint——直接下桩
    const docWithHit = document as unknown as { elementFromPoint?: () => Element | null };
    const originalHit = docWithHit.elementFromPoint;
    docWithHit.elementFromPoint = () => localPane;
    await act(async () => {
      drag.handler?.({
        payload: {
          type: "drop",
          paths: ["/Users/me/notes.txt", "/Users/me/Downloads"],
          position: { x: 10, y: 10 },
        },
      });
    });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_copy", {
        from: "/Users/me/notes.txt",
        toDir: "/Users/me",
      }),
    );
    // 目录（Downloads）被过滤：local_copy 只此一次
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "local_copy"),
    ).toHaveLength(1);
    docWithHit.elementFromPoint = originalHit;
    act(() => useTransferStore.setState({ items: [] }));
  });
});
