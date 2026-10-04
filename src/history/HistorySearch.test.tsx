// HistorySearch（Task 15 ⌘R 面板）组件测试：结果渲染（命令/主机/退出码/时间）、
// host 过滤、回车插入上抛、Esc/遮罩关闭。
// 词典固定 zh-CN（jsdom navigator.language 是 en-US，changeLanguage 拧回中文，
// 同 CommandPalette.test 惯例）；invoke 全量 mock（Rust 命令已在 vault 命令面接线）。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { HistorySearch, exitBadgeClass, queryHitIndices } from "./HistorySearch";
import type { HistoryEntry } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const hosts = [
  { id: 1, name: "web-01" },
  { id: 2, name: "db-01" },
] as Parameters<typeof HistorySearch>[0]["hosts"];

let seq = 0;
function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: ++seq,
    host_id: 1,
    command: "root@web01:~$ docker logs ottr-api",
    cwd: "/srv",
    exit_code: 0,
    session_id: "tab-1",
    ts: 1_760_000_000,
    ...overrides,
  };
}

function renderPanel(props: Partial<Parameters<typeof HistorySearch>[0]> = {}) {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  render(
    <HistorySearch
      open
      onClose={onClose}
      hosts={hosts}
      onInsert={onInsert}
      plat="mac"
      {...props}
    />,
  );
  return { onInsert, onClose };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});
beforeEach(() => {
  seq = 0;
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue([]);
  // 「录制」页签点击命中会挂 RecordingPlayer（真 xterm）——jsdom 需要的 stub
  // （Terminal.test 同款口径 + addListener 补齐）。
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HistorySearch", () => {
  it("初始态发 history_search（空 query 跨主机）并渲染最近记录（命令/主机/退出码）", async () => {
    mockedInvoke.mockResolvedValue([
      entry(),
      entry({ id: 2, host_id: 2, exit_code: 127, command: "user@db:~$ topp" }),
    ]);
    renderPanel();
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", {
      query: "",
      hostId: null,
      limit: 50,
    });
    await act(async () => {});
    const items = screen.getAllByTestId("history-item");
    expect(items).toHaveLength(2);
    expect(screen.getByText("root@web01:~$ docker logs ottr-api")).toBeTruthy();
    // 主机名同时出现在过滤下拉 option（全量主机）与结果行：按出现次数断言
    expect(screen.getAllByText("web-01").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("db-01").length).toBeGreaterThanOrEqual(1);
    // 结果行内（非下拉）的主机名各一次
    const rowHosts = items.map(
      (el) => el.querySelector(".history-host")?.textContent,
    );
    expect(rowHosts).toEqual(["web-01", "db-01"]);
    // 退出码徽标：0 与 127 原样展示
    expect(screen.getAllByTestId("history-exit").map((el) => el.textContent)).toEqual([
      "0",
      "127",
    ]);
  });

  it("键入防抖后带 query 检索；host 过滤下拉即切即查", async () => {
    vi.useFakeTimers();
    renderPanel();
    mockedInvoke.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", { query: "", hostId: null, limit: 50 });

    fireEvent.change(screen.getByTestId("history-input"), { target: { value: "docker logs" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_search", {
      query: "docker logs",
      hostId: null,
      limit: 50,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", {
      query: "docker logs",
      hostId: null,
      limit: 50,
    });

    fireEvent.change(screen.getByTestId("history-host-filter"), { target: { value: "2" } });
    await vi.advanceTimersByTimeAsync(0);
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("history_search", {
      query: "docker logs",
      hostId: 2,
      limit: 50,
    });
  });

  it("回车选定 → onInsert 上抛**原样入库文本**（剥提示符在 App 侧）+ 关闭", async () => {
    const cmd = "root@web01:~$ systemctl restart ottr";
    mockedInvoke.mockResolvedValue([entry({ command: cmd })]);
    const { onInsert, onClose } = renderPanel();
    await act(async () => {});
    fireEvent.keyDown(screen.getByTestId("history-input"), { key: "Enter" });
    expect(onInsert).toHaveBeenCalledWith(cmd);
    expect(onClose).toHaveBeenCalled();
  });

  it("↑↓ 在结果间导航（data-active 跟随），Esc 与遮罩点击关闭", async () => {
    mockedInvoke.mockResolvedValue([entry({ id: 1 }), entry({ id: 2 })]);
    const { onClose } = renderPanel();
    await act(async () => {});
    const items = screen.getAllByTestId("history-item");
    expect(items[0].getAttribute("data-active")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("history-input"), { key: "ArrowDown" });
    expect(items[1].getAttribute("data-active")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("history-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId("history-search"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("检索失败降级空结果（不白屏）；open=false 不渲染", async () => {
    mockedInvoke.mockRejectedValue(new Error("backend gone"));
    renderPanel();
    await act(async () => {});
    expect(screen.getByTestId("history-list").textContent).toContain("无匹配命令");
    const { container } = render(
      <HistorySearch open={false} onClose={() => {}} hosts={hosts} onInsert={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("HistorySearch 纪要页签（Task 7，B1）", () => {
  it("切「纪要」页签 → summary_list 取数并渲染（摘要全文/主机/命令数/时间）；隐藏查询框", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "summary_list"
        ? Promise.resolve([
            {
              id: 9,
              host_id: 1,
              session_id: "tab-a",
              summary: "部署了 docker compose 服务，共 3 条命令。",
              command_count: 3,
              ts: 1_760_000_000,
            },
            {
              id: 8,
              host_id: 2,
              session_id: "tab-b",
              summary: "巡检数据库磁盘水位。",
              command_count: 5,
              ts: 1_759_900_000,
            },
          ])
        : Promise.resolve([]),
    );
    renderPanel();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("summary-tab"));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("summary_list", { hostId: null, limit: 50 });
    const items = screen.getAllByTestId("summary-item");
    expect(items).toHaveLength(2);
    expect(screen.getByText("部署了 docker compose 服务，共 3 条命令。")).toBeTruthy();
    // 元信息行：主机 + 命令数徽标
    const hostsInRows = items.map((el) => el.querySelector(".history-host")?.textContent);
    expect(hostsInRows).toEqual(["web-01", "db-01"]);
    expect(screen.getAllByTestId("summary-count").map((el) => el.textContent)).toEqual([
      "3 条命令",
      "5 条命令",
    ]);
    // 只读面：无查询输入、无插入上抛（Enter 不动作）
    expect(screen.queryByTestId("history-input")).toBeNull();
  });

  it("纪要列表为空显示空态；host 过滤随取数下发；Esc 关闭", async () => {
    mockedInvoke.mockResolvedValue([]);
    const { onClose } = renderPanel();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("summary-tab"));
    await act(async () => {});
    expect(screen.getByTestId("summary-list").textContent).toContain("还没有会话纪要");
    fireEvent.change(screen.getByTestId("history-host-filter"), { target: { value: "2" } });
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("summary_list", { hostId: 2, limit: 50 });
    // 键盘处理在 dialog 容器（无输入框页签 Esc 照常关闭）
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("exitBadgeClass（退出码徽标语义类）", () => {
  it("0=exit-ok / 非 0=exit-fail / null=exit-none", () => {
    expect(exitBadgeClass(0)).toContain("exit-ok");
    expect(exitBadgeClass(127)).toContain("exit-fail");
    expect(exitBadgeClass(null)).toContain("exit-none");
  });
});

describe("搜索词高亮（批次三 T2，审计 ⌘R 23/24/25）", () => {
  it("queryHitIndices：大小写不敏感子串命中，多词合并下标", () => {
    expect(queryHitIndices("root@web:~$ Docker logs docker", "docker")).toEqual([
      12, 13, 14, 15, 16, 17, 24, 25, 26, 27, 28, 29,
    ]);
    expect(queryHitIndices("docker logs", "DOCKER")).toEqual([0, 1, 2, 3, 4, 5]);
    // 多词各自命中（"og" 命中 logs 中段）
    expect(queryHitIndices("docker logs", "og")).toEqual([8, 9]);
    expect(queryHitIndices("docker logs", "  ")).toEqual([]); // 纯空白无词
    expect(queryHitIndices("docker logs", "")).toEqual([]); // 空查询不高亮
    expect(queryHitIndices("docker logs", "zzz")).toEqual([]);
  });

  it("键入检索词后，结果行命令文本出现 <mark> 高亮（大小写不敏感）", async () => {
    vi.useFakeTimers();
    mockedInvoke.mockResolvedValue([entry()]);
    renderPanel();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByTestId("history-item")[0].querySelectorAll("mark")).toHaveLength(0);

    fireEvent.change(screen.getByTestId("history-input"), { target: { value: "Docker LOGS" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const marks = screen.getAllByTestId("history-item")[0].querySelectorAll("mark");
    expect(marks.length).toBe(2); // docker 与 logs 各一段
    expect(marks[0].textContent).toBe("docker");
    expect(marks[1].textContent).toBe("logs");
    vi.useRealTimers();
  });

  it("空查询（最近记录态）不高亮", async () => {
    mockedInvoke.mockResolvedValue([entry()]);
    renderPanel();
    await act(async () => {});
    expect(screen.getAllByTestId("history-item")[0].querySelectorAll("mark")).toHaveLength(0);
  });
});

describe("HistorySearch 录制页签（Phase 3 Task 5，B3）", () => {
  const hit = {
    id: 11,
    host_id: 1,
    path: "/data/recordings/rec-1.cast",
    duration: 12,
    text_index_path: "recordings_fts:11",
    created_at: 1_760_000_000,
    snippet: "root@web:~$ docker logs ottr-api",
  };

  it("切「录制」页签 → recording_search 空查询取最近；命中行渲染（snippet/主机/时长）", async () => {
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "recording_search" ? Promise.resolve([hit]) : Promise.resolve([]),
    );
    renderPanel();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("recording-tab"));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("recording_search", {
      query: "",
      hostId: null,
      limit: 50,
    });
    const items = screen.getAllByTestId("recording-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("docker logs ottr-api");
    expect(items[0].querySelector(".history-host")?.textContent).toBe("web-01");
    expect(screen.getByTestId("recording-duration").textContent).toBe("12s");
  });

  it("点击命中行 → recording_read 取回放数据并挂回放器；Esc 先关回放（面板保留）", async () => {
    const data = {
      entry: hit,
      header: { version: 2, width: 80, height: 24, timestamp: 1_760_000_000 },
      events: [{ time: 0, data: "root@web:~$ " }],
      duration: 12,
    };
    mockedInvoke.mockImplementation((cmd: string) =>
      cmd === "recording_search"
        ? Promise.resolve([hit])
        : cmd === "recording_read"
          ? Promise.resolve(data)
          : Promise.resolve([]),
    );
    const { onClose } = renderPanel();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("recording-tab"));
    await act(async () => {});
    fireEvent.click(screen.getByTestId("recording-item"));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("recording_read", { id: 11 });
    expect(screen.getByTestId("recording-player")).toBeTruthy();
    // Esc = 先关回放，面板仍在（再 Esc 才关面板）
    fireEvent.keyDown(screen.getByTestId("recording-player"), { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByTestId("recording-player")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("录制为空显示空态", async () => {
    mockedInvoke.mockResolvedValue([]);
    renderPanel();
    fireEvent.click(screen.getByTestId("recording-tab"));
    await act(async () => {});
    expect(screen.getByTestId("recording-list").textContent).toContain("还没有录制");
  });

  it("录制页签查询框（fix round 1/5 I-1）：键入防抖后带 query 走 recording_search 过滤", async () => {
    vi.useFakeTimers();
    const hit12 = {
      id: 12,
      host_id: 1,
      path: "/data/recordings/rec-12.cast",
      duration: 8,
      text_index_path: "recordings_fts:12",
      created_at: 1_760_000_100,
      snippet: "root@web:~$ [部署完成]",
    };
    let searchQuery = "";
    mockedInvoke.mockImplementation((cmd: string, args: { query: string }) => {
      if (cmd === "recording_search") {
        searchQuery = args.query;
        return Promise.resolve(args.query === "部署" ? [hit12] : []);
      }
      return Promise.resolve([]);
    });
    renderPanel();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByTestId("recording-tab"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("recording_search", {
      query: "",
      hostId: null,
      limit: 50,
    });
    // 录制页签有输入框且键入驱动检索（防抖 200ms）
    const input = screen.getByTestId("history-input");
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "部署" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(searchQuery).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("recording_search", {
      query: "部署",
      hostId: null,
      limit: 50,
    });
    expect(searchQuery).toBe("部署");
    const items = screen.getAllByTestId("recording-item");
    expect(items).toHaveLength(1);
    vi.useRealTimers();
  });
});
