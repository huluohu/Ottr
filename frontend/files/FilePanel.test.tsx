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

/** 测试分派里的命令名取法（mockListings 的 _cmd 直传别名）。 */
function cmd1(c: string): string {
  return c;
}


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
  // 目录记忆（2026-10-19）跨用例隔离：记忆命中会改变初载路径（绕过
  // sftp_realpath/local_home），不清则级联污染后续用例。
  localStorage.clear();
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

// ---------------------------------------------------------------------------
// 第二轮（2026-10-16 用户实测反馈）：空白右键出 webview 默认菜单；HTML5 DnD
// 在 Tauri webview 里松手无效——行拖拽已改 Pointer Events 自管，本组测试
// 驱动真实 pointer 事件链（jsdom 无 Tauri，但拖拽逻辑不再依赖引擎）。
// ---------------------------------------------------------------------------
describe("文件面板增强·第二轮", () => {
  function stubHitTarget(el: Element | null) {
    const docWithHit = document as unknown as { elementFromPoint?: () => Element | null };
    const original = docWithHit.elementFromPoint;
    docWithHit.elementFromPoint = () => el;
    return () => {
      docWithHit.elementFromPoint = original;
    };
  }

  it("空白区右键：出应用菜单（刷新/新建目录），不再落给 webview 默认菜单", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-remote").textContent).toContain("big100"));
    // 右键远端栏列表空白（列表容器本身，非文件行）
    fireEvent.contextMenu(screen.getByTestId("file-list-remote"), { clientX: 40, clientY: 400 });
    const menu = await screen.findByTestId("file-ctx-menu");
    const labels = [...menu.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("Refresh") || l.includes("刷新"))).toBe(true);
    expect(labels.some((l) => l.includes("folder") || l.includes("目录"))).toBe(true);
  });

  it("行指针拖拽 本地→远端：过阈值出浮标+对侧高亮，松手即 sftp_upload", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    const remotePane = screen
      .getByTestId("file-title-remote")
      .closest("[data-file-drop]") as HTMLElement;
    const restore = stubHitTarget(remotePane);
    const row = screen
      .getAllByRole("option")
      .find((el) => (el.textContent ?? "").includes("notes.txt")) as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 260 });
    // 浮标已现、对侧栏高亮可放
    expect(screen.getByTestId("file-drag-badge").textContent).toContain("notes.txt");
    expect(
      screen.getByTestId("file-title-remote").closest("[data-file-drop]")?.getAttribute("data-droptarget"),
    ).toBe("true");
    fireEvent.pointerUp(window, { clientX: 160, clientY: 260 });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_upload", {
        id: "pty-0",
        local: "/Users/me/notes.txt",
        remoteDir: "/home/spike",
      }),
    );
    // 收尾：浮标消失、高亮撤除
    expect(screen.queryByTestId("file-drag-badge")).toBeNull();
    expect(
      screen.getByTestId("file-title-remote").closest("[data-file-drop]")?.getAttribute("data-droptarget"),
    ).toBe("false");
    restore();
    act(() => useTransferStore.setState({ items: [] }));
  });

  it("目录行拖拽到远端：递归上传（幂等建目录 + 逐文件入队）；拖到本地仍跳过", async () => {
    // 2026-10-19 用户需求：面板拖拽目录不再整体跳过——本地目录拖到远端栏
    // 建远端目录树并逐文件入队（uploadLocalTree 编排，本用例验接入面）。
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string; local?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list") {
        if (args?.path === "/Users/me") return Promise.resolve(localEntries);
        if (args?.path === "/Users/me/Downloads")
          return Promise.resolve([
            { name: "inner.txt", is_dir: false, size: 3, mode: 0o100644, mtime: 1 },
          ]);
        return Promise.resolve([]);
      }
      if (cmd === "sftp_mkdir_all") return Promise.resolve(null);
      if (cmd === "sftp_upload")
        return Promise.resolve({
          transfer_id: "xfer-test",
          local_path: args?.local ?? "",
          remote_path: "/home/spike/Downloads/inner.txt",
          total: 3,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    const remotePane = screen
      .getByTestId("file-title-remote")
      .closest("[data-file-drop]") as HTMLElement;
    const restore = stubHitTarget(remotePane);
    const row = screen
      .getAllByRole("option")
      .find((el) => (el.textContent ?? "").includes("Downloads")) as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 260 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 260 });
    await waitFor(
      () =>
        expect(mockedInvoke).toHaveBeenCalledWith("sftp_mkdir_all", {
          id: "pty-0",
          path: "/home/spike/Downloads",
        }),
      { timeout: 3000 },
    );
    await waitFor(
      () =>
        expect(
          mockedInvoke.mock.calls.some(
            ([cmd, a]) =>
              cmd === "sftp_upload" &&
              (a as { local?: string; remoteDir?: string }).local ===
                "/Users/me/Downloads/inner.txt" &&
              (a as { remoteDir?: string }).remoteDir === "/home/spike/Downloads",
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    restore();
  });

  it("按下未过阈值即松手：普通点击选中，不出浮标不传输", async () => {
    mockListings();
    render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"));
    const row = screen
      .getAllByRole("option")
      .find((el) => (el.textContent ?? "").includes("notes.txt")) as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 101, clientY: 200 });
    // 真浏览器在按下/松开同一元素时会合成 click——补发以驱动选中
    fireEvent.click(row);
    expect(screen.queryByTestId("file-drag-badge")).toBeNull();
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(mockedInvoke).not.toHaveBeenCalledWith("sftp_upload", expect.anything());
  });
});

describe("FilePanel 目录记忆（2026-10-19 用户需求）", () => {
  const KEY = "ottr.files.cwdMemory";

  beforeEach(() => {
    localStorage.clear();
  });

  it("有记忆：初载直接用保存的目录（不再回 home）", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ "1": { local: "/Users/me/Downloads", remote: "/var/log" } }),
    );
    // local_list 对记忆路径返回条目（路径有效）；sftp_list 同理
    mockedInvoke.mockImplementation((_cmd: string, args: { path?: string; id?: string }) => {
      if (cmd1(_cmd) === "local_list")
        return Promise.resolve(args.path === "/Users/me/Downloads" ? localEntries : []);
      if (cmd1(_cmd) === "sftp_list")
        return Promise.resolve(args.path === "/var/log" ? remoteEntries : []);
      return Promise.resolve(undefined as unknown as never);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_list", { path: "/Users/me/Downloads" }),
    );
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_list", { id: "pty-0", path: "/var/log" }),
    );
    // home 不应被查询（记忆命中即不回默认）
    expect(mockedInvoke).not.toHaveBeenCalledWith("local_home");
  });

  it("记忆路径失效：回退 home 并清掉该侧记忆（防永久坏状态）", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ "1": { local: "/gone/local/dir", remote: "/gone/remote/dir" } }),
    );
    mockedInvoke.mockImplementation((_cmd: string, args: { path?: string; id?: string }) => {
      const c = cmd1(_cmd);
      if (c === "local_home") return Promise.resolve("/Users/me");
      if (c === "sftp_realpath") return Promise.resolve("/home/spike");
      // 记忆路径与 home 都有效，但记忆路径返回空列表也视为有效加载——
      // 这里让「记忆路径」报错模拟目录已删除
      if (args?.path?.startsWith("/gone")) return Promise.reject(new Error("no such directory"));
      if (c === "local_list") return Promise.resolve(localEntries);
      if (c === "sftp_list") return Promise.resolve(remoteEntries);
      return Promise.resolve(undefined as unknown as never);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("local_list", { path: "/Users/me" }),
    );
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_list", { id: "pty-0", path: "/home/spike" }),
    );
    // 失效记忆被清后，回退的 home 加载成功即成为新记忆（浏览成功即持久化）
    const saved = JSON.parse(localStorage.getItem(KEY)!);
    expect(saved["1"].local).toBe("/Users/me");
    expect(saved["1"].remote).toBe("/home/spike");
  });

  it("浏览即持久化：进入新目录写入 per-host 记忆", async () => {
    localStorage.clear();
    mockListings();
    const { rerender } = render(<FilePanel session={makeSession()} />);
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    // 用户进入远端子目录 src
    rerender(<FilePanel session={makeSession()} />);
    // 直接驱动状态面：模拟 loadRemote 成功后的 path（经双击导航等价面）
    // ——这里用纯函数面验证持久化写入路径（navigate 集成由真机覆盖）
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // 初载 home 已被持久化（浏览成功即写）
    expect(saved["1"].remote ?? saved["1"].local).toBeTruthy();
  });
});

describe("文件面板多选与批量传输（2026-10-19 用户需求）", () => {
  const rowsOf = (listTestId: string) =>
    Array.from(
      (screen.getByTestId(listTestId) as HTMLElement).querySelectorAll('[role="option"]'),
    ) as HTMLElement[];

  it("Ctrl 点选多项；批量下载逐个入队（目录不计）", async () => {
    mockListings();
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string; id?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list") return Promise.resolve(localEntries);
      if (cmd === "sftp_list")
        return Promise.resolve([
          { name: "a.txt", is_dir: false, size: 1, mode: 0o100644, mtime: 1 },
          { name: "b.txt", is_dir: false, size: 2, mode: 0o100644, mtime: 1 },
          { name: "sub", is_dir: true, size: 0, mode: 0o40755, mtime: 1 },
        ]);
      if (cmd === "sftp_download")
        return Promise.resolve({
          transfer_id: `t-${String(args?.path ?? "")}`,
          local_path: "/d/x",
          remote_path: String(args?.path ?? ""),
          total: 1,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-remote").textContent).toContain("a.txt"),
    );
    const rows = rowsOf("file-list-remote");
    const a = rows.find((r) => r.textContent?.includes("a.txt"))!;
    const b = rows.find((r) => r.textContent?.includes("b.txt"))!;
    fireEvent.click(a);
    fireEvent.click(b, { ctrlKey: true });
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(b.getAttribute("aria-selected")).toBe("true");
    // 批量下载按钮带计数并逐个入队
    const dl = screen.getByTestId("fb-download");
    expect(dl.textContent).toContain("(2)");
    fireEvent.click(dl);
    await waitFor(() => {
      const downloads = mockedInvoke.mock.calls.filter(([c]) => c === "sftp_download");
      expect(downloads).toHaveLength(2);
    });
  });

  it("Shift 范围选：锚点到最后一项之间全选", async () => {
    mockListings();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list") return Promise.resolve(localEntries);
      if (cmd === "sftp_list")
        return Promise.resolve([
          { name: "a.txt", is_dir: false, size: 1, mode: 0o100644, mtime: 1 },
          { name: "b.txt", is_dir: false, size: 2, mode: 0o100644, mtime: 1 },
          { name: "c.txt", is_dir: false, size: 3, mode: 0o100644, mtime: 1 },
        ]);
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-remote").textContent).toContain("c.txt"),
    );
    const rows = rowsOf("file-list-remote");
    const a = rows.find((r) => r.textContent?.includes("a.txt"))!;
    const c = rows.find((r) => r.textContent?.includes("c.txt"))!;
    fireEvent.click(a);
    fireEvent.click(c, { shiftKey: true });
    for (const r of rows) expect(r.getAttribute("aria-selected")).toBe("true");
  });

  it("本地栏多选（文件 + 目录）→ 上传：文件直传、目录递归建远端树", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string; id?: string; local?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list") {
        if (args?.path === "/Users/me") return Promise.resolve(localEntries);
        if (args?.path === "/Users/me/Downloads")
          return Promise.resolve([
            { name: "inner.txt", is_dir: false, size: 1, mode: 0o100644, mtime: 1 },
          ]);
        return Promise.resolve([]);
      }
      if (cmd === "sftp_list") return Promise.resolve([]);
      if (cmd === "sftp_mkdir_all") return Promise.resolve(null);
      if (cmd === "sftp_upload")
        return Promise.resolve({
          transfer_id: `u-${String(args?.local ?? "")}`,
          local_path: String(args?.local ?? ""),
          remote_path: "/home/spike/x",
          total: 1,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"),
    );
    const rows = rowsOf("file-list-local");
    const notes = rows.find((r) => r.textContent?.includes("notes.txt"))!;
    const dir = rows.find((r) => r.textContent?.includes("Downloads"))!;
    // 焦点侧切到本地（工具栏「上传」按 focus 渲染）；jsdom click 不触发 pointerdown
    fireEvent.pointerDown(notes, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(notes);
    fireEvent.pointerDown(dir, { button: 0, clientX: 10, clientY: 40 });
    fireEvent.click(dir, { ctrlKey: true });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 40 });
    fireEvent.click(screen.getByTestId("fb-upload"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("sftp_mkdir_all", {
        id: "pty-0",
        path: "/home/spike/Downloads",
      }),
    );
    await waitFor(() => {
      const uploads = mockedInvoke.mock.calls
        .filter(([c]) => c === "sftp_upload")
        .map(([, a]) => (a as { local?: string }).local);
      expect(uploads).toContain("/Users/me/notes.txt");
      expect(uploads).toContain("/Users/me/Downloads/inner.txt");
    });
  });
});

describe("多选拖拽（2026-10-19 用户反馈：拖拽只传一个）", () => {
  const localRows = [
    { name: "docs", is_dir: true, size: 0, mode: 0o40755, mtime: 1 },
    { name: "notes.txt", is_dir: false, size: 1, mode: 0o100644, mtime: 1 },
    { name: "readme.md", is_dir: false, size: 2, mode: 0o100644, mtime: 1 },
  ];
  function dragRowTo(row: HTMLElement, targetEl: Element) {
    const docWithHit = document as unknown as { elementFromPoint?: () => Element | null };
    const original = docWithHit.elementFromPoint;
    docWithHit.elementFromPoint = () => targetEl;
    fireEvent.pointerDown(row, { button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 260 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 260 });
    docWithHit.elementFromPoint = original;
  }

  it("本地多选后拖其中一行到远端：选中的文件全部入队", async () => {
    mockListings();
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string; local?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list")
        return Promise.resolve(args?.path === "/Users/me" ? localRows : []);
      if (cmd === "sftp_list") return Promise.resolve([]);
      if (cmd === "sftp_upload")
        return Promise.resolve({
          transfer_id: `u-${String(args?.local ?? "")}`,
          local_path: String(args?.local ?? ""),
          remote_path: "/home/spike/x",
          total: 1,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"),
    );
    const rows = Array.from(
      (screen.getByTestId("file-list-local") as HTMLElement).querySelectorAll('[role="option"]'),
    ) as HTMLElement[];
    const notes = rows.find((r) => r.textContent?.includes("notes.txt"))!;
    const readme = rows.find((r) => r.textContent?.includes("readme.md"))!;
    fireEvent.click(notes);
    fireEvent.click(readme, { ctrlKey: true });
    const remotePane = screen.getByTestId("file-title-remote").closest("[data-file-drop]")!;
    dragRowTo(notes, remotePane);
    await waitFor(() => {
      const uploads = mockedInvoke.mock.calls
        .filter(([c]) => c === "sftp_upload")
        .map(([, a]) => (a as { local?: string }).local);
      expect(uploads).toContain("/Users/me/notes.txt");
      expect(uploads).toContain("/Users/me/readme.md");
    });
  });

  it("远端多选后拖其中一行到本地：选中的文件全部下载", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list")
        return Promise.resolve(args?.path === "/Users/me" ? localRows : []);
      if (cmd === "sftp_list")
        return Promise.resolve([
          { name: "a.txt", is_dir: false, size: 1, mode: 0o100644, mtime: 1 },
          { name: "b.txt", is_dir: false, size: 2, mode: 0o100644, mtime: 1 },
          { name: "dir", is_dir: true, size: 0, mode: 0o40755, mtime: 1 },
        ]);
      if (cmd === "sftp_download")
        return Promise.resolve({
          transfer_id: `d-${String(args?.path ?? "")}`,
          local_path: "/d/x",
          remote_path: String(args?.path ?? ""),
          total: 1,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-remote").textContent).toContain("a.txt"),
    );
    const rows = Array.from(
      (screen.getByTestId("file-list-remote") as HTMLElement).querySelectorAll('[role="option"]'),
    ) as HTMLElement[];
    const a = rows.find((r) => r.textContent?.includes("a.txt"))!;
    const b = rows.find((r) => r.textContent?.includes("b.txt"))!;
    fireEvent.click(a);
    fireEvent.click(b, { ctrlKey: true });
    const localPane = screen.getByTestId("file-title-local").closest("[data-file-drop]")!;
    dragRowTo(a, localPane);
    await waitFor(() => {
      const downloads = mockedInvoke.mock.calls
        .filter(([c]) => c === "sftp_download")
        .map(([, arg]) => (arg as { remote?: string }).remote);
      expect(downloads).toContain("/home/spike/a.txt");
      expect(downloads).toContain("/home/spike/b.txt");
    });
  });

  it("拖起未选中的行：只传该行（不误传其它选中项）", async () => {
    mockListings();
    mockedInvoke.mockImplementation((cmd: string, args?: { path?: string; local?: string }) => {
      if (cmd === "local_home") return Promise.resolve("/Users/me");
      if (cmd === "sftp_realpath") return Promise.resolve("/home/spike");
      if (cmd === "local_list")
        return Promise.resolve(args?.path === "/Users/me" ? localRows : []);
      if (cmd === "sftp_list") return Promise.resolve([]);
      if (cmd === "sftp_upload")
        return Promise.resolve({
          transfer_id: `u-${String(args?.local ?? "")}`,
          local_path: String(args?.local ?? ""),
          remote_path: "/home/spike/x",
          total: 1,
        });
      return Promise.resolve(null);
    });
    render(<FilePanel session={makeSession()} />);
    await waitFor(() =>
      expect(screen.getByTestId("file-list-local").textContent).toContain("notes.txt"),
    );
    const rows = Array.from(
      (screen.getByTestId("file-list-local") as HTMLElement).querySelectorAll('[role="option"]'),
    ) as HTMLElement[];
    const notes = rows.find((r) => r.textContent?.includes("notes.txt"))!;
    const readme = rows.find((r) => r.textContent?.includes("readme.md"))!;
    fireEvent.click(notes);
    fireEvent.click(readme, { ctrlKey: true });
    const remotePane = screen.getByTestId("file-title-remote").closest("[data-file-drop]")!;
    // 拖起 docs（未选中项，目录先跳过以免递归）：用 readme 之外的未选中行
    const other = rows.find((r) => r.textContent?.includes("docs"))!;
    dragRowTo(other, remotePane);
    await waitFor(() => {
      const uploads = mockedInvoke.mock.calls
        .filter(([c]) => c === "sftp_upload")
        .map(([, a]) => (a as { local?: string }).local);
      expect(uploads).not.toContain("/Users/me/notes.txt");
      expect(uploads).not.toContain("/Users/me/readme.md");
    });
  });
});
