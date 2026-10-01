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

import { HistorySearch, exitBadgeClass } from "./HistorySearch";
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
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe("exitBadgeClass（退出码徽标语义类）", () => {
  it("0=exit-ok / 非 0=exit-fail / null=exit-none", () => {
    expect(exitBadgeClass(0)).toContain("exit-ok");
    expect(exitBadgeClass(127)).toContain("exit-fail");
    expect(exitBadgeClass(null)).toContain("exit-none");
  });
});
