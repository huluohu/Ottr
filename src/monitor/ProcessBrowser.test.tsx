// ProcessBrowser 组件测试（Phase 3 Task 2 Step 3）：表格渲染 + 表头排序 +
// kill 确认流（SIGTERM 直确认 / SIGKILL 两段式）+ 错误面（EPERM 可见）+
// 未连接面 + 轮询。monitor_ps/monitor_kill 走 ./api mock。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "../i18n";
import { ProcessBrowser, sortRows } from "./ProcessBrowser";
import { fetchProcesses, killProcess, type ProcEntry } from "./api";

vi.mock("./api", () => ({
  fetchProcesses: vi.fn(),
  killProcess: vi.fn(),
}));

const mockedFetch = fetchProcesses as unknown as Mock;
const mockedKill = killProcess as unknown as Mock;

function row(over: Partial<ProcEntry> & Pick<ProcEntry, "pid">): ProcEntry {
  return {
    ppid: 1,
    user: "root",
    cpu_percent: 1.5,
    mem_percent: 2.5,
    etime_secs: 6100,
    etime: "01:41:40",
    comm: "sshd",
    ...over,
  };
}

const ROWS: ProcEntry[] = [
  row({ pid: 21, cpu_percent: 0.5, comm: "sshd" }),
  row({ pid: 300, cpu_percent: 9.9, mem_percent: 8.0, comm: "nginx", user: "www" }),
  row({ pid: 42, cpu_percent: 2.0, comm: "bash", user: "spike" }),
];

beforeEach(() => {
  mockedFetch.mockReset();
  mockedKill.mockReset();
  mockedKill.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("ProcessBrowser 纯排序", () => {
  it("数值列数值比、文本列字典序、同值回退 pid 稳定序", () => {
    const byCpu = sortRows(ROWS, "cpu_percent", "desc");
    expect(byCpu.map((r) => r.pid)).toEqual([300, 42, 21]);
    expect(sortRows(ROWS, "cpu_percent", "asc").map((r) => r.pid)).toEqual([21, 42, 300]);
    expect(sortRows(ROWS, "user", "asc").map((r) => r.user)).toEqual(["root", "spike", "www"]);
    const tied = [row({ pid: 9, cpu_percent: 1 }), row({ pid: 5, cpu_percent: 1 })];
    expect(sortRows(tied, "cpu_percent", "desc").map((r) => r.pid), "同值 pid 升序兜底").toEqual([5, 9]);
  });
});

describe("ProcessBrowser 表格", () => {
  it("渲染行 + 默认 CPU% 降序；点击表头切换排序", async () => {
    mockedFetch.mockResolvedValue(ROWS);
    render(<ProcessBrowser rustId="pty-1" />);
    await waitFor(() => expect(screen.getByTestId("proc-table")).toBeTruthy());
    expect(screen.getByTestId("proc-count").textContent).toBe("3");

    // 默认 cpu desc：行序 300 → 42 → 21
    let pids = screen.getAllByTestId(/^proc-row-/).map((el) => el.getAttribute("data-testid"));
    expect(pids).toEqual(["proc-row-300", "proc-row-42", "proc-row-21"]);
    expect(screen.getByTestId("proc-sort-cpu_percent").getAttribute("aria-sort") ??
      screen.getByTestId("proc-sort-cpu_percent").closest("th")!.getAttribute("aria-sort")).toBe("descending");

    // 点 CPU% 表头 → 升序
    fireEvent.click(screen.getByTestId("proc-sort-cpu_percent"));
    pids = screen.getAllByTestId(/^proc-row-/).map((el) => el.getAttribute("data-testid"));
    expect(pids).toEqual(["proc-row-21", "proc-row-42", "proc-row-300"]);

    // 点用户表头 → 文本列升序首击
    fireEvent.click(screen.getByTestId("proc-sort-user"));
    const users = screen.getAllByTestId(/^proc-row-/).map((el) => el.textContent);
    expect(users.some((u) => u!.includes("www"))).toBe(true);

    // 首拉即成功：无错误面
    expect(screen.queryByTestId("proc-error")).toBeNull();
  });

  it("5s 轮询自动刷新；rustId 变化重拉", async () => {
    vi.useFakeTimers();
    try {
      mockedFetch.mockResolvedValue(ROWS);
      const { rerender } = render(<ProcessBrowser rustId="pty-1" />);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockedFetch, "5s 轮询两跳").toHaveBeenCalledTimes(3);

      mockedFetch.mockClear();
      rerender(<ProcessBrowser rustId="pty-2" />);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedFetch).toHaveBeenCalledWith("pty-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("未连接面（rustId=null）：不发采集请求", () => {
    render(<ProcessBrowser rustId={null} />);
    expect(screen.getByTestId("proc-disconnected").textContent).toContain("not connected");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("采集失败错误面（proc-error 可见）", async () => {
    mockedFetch.mockRejectedValue(new Error("no such session: pty-x"));
    render(<ProcessBrowser rustId="pty-x" />);
    await waitFor(() =>
      expect(screen.getByTestId("proc-error").textContent).toContain("no such session"),
    );
  });
});

describe("ProcessBrowser kill 流", () => {
  async function setup() {
    mockedFetch.mockResolvedValue(ROWS);
    render(<ProcessBrowser rustId="pty-1" />);
    await waitFor(() => expect(screen.getByTestId("proc-table")).toBeTruthy());
  }

  it("确认流：结束 → 确认对话框 → SIGTERM 执行 → 刷新", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("proc-kill-300"));
    const dlg = screen.getByTestId("proc-kill-dialog");
    expect(dlg.textContent).toContain("300");
    expect(dlg.textContent).toContain("nginx");

    fireEvent.click(screen.getByTestId("proc-kill-cancel"));
    expect(screen.queryByTestId("proc-kill-dialog")).toBeNull();
    expect(mockedKill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("proc-kill-300"));
    fireEvent.click(screen.getByTestId("proc-kill-confirm"));
    await waitFor(() =>
      expect(mockedKill).toHaveBeenCalledWith("pty-1", 300, false),
    );
    // 成功后确认条关闭并刷新列表
    await waitFor(() => expect(screen.queryByTestId("proc-kill-dialog")).toBeNull());
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });

  it("SIGKILL 两段式：首击武装（换文案），再击才执行 force=true", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("proc-kill-42"));
    const force = screen.getByTestId("proc-kill-force");
    expect(force.textContent).toContain("SIGKILL");

    fireEvent.click(force);
    expect(mockedKill, "武装击不执行").not.toHaveBeenCalled();
    expect(screen.getByTestId("proc-kill-force").textContent).toContain("Click again");

    fireEvent.click(screen.getByTestId("proc-kill-force"));
    await waitFor(() => expect(mockedKill).toHaveBeenCalledWith("pty-1", 42, true));
  });

  it("kill 失败（EPERM）：远端 stderr 上屏错误面，确认条关闭", async () => {
    await setup();
    mockedKill.mockRejectedValue(new Error("kill: (300) - Operation not permitted"));
    fireEvent.click(screen.getByTestId("proc-kill-300"));
    fireEvent.click(screen.getByTestId("proc-kill-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("proc-error").textContent).toContain("Operation not permitted"),
    );
    expect(screen.queryByTestId("proc-kill-dialog")).toBeNull();
  });
});
