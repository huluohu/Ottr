// BatchPanel 组件测试（Phase 3 Task 4，B6）：主机多选/未连接徽标、变量表单与
// batch_exec 载荷（per-host 渲染命令）、danger 分档确认（green 直发 / yellow
// 二击 / red armed）、结果表（状态档 + 少数派 data-differs 高亮 + 全同组折叠）、
// 取消。invoke 走 mock；结果经 batchStore 直灌（事件接线另有 App 链）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { BatchPanel } from "./BatchPanel";
import { useBatchStore } from "./batchStore";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";
import type { BatchResult } from "./api";

const mockedInvoke = invoke as unknown as Mock;

function host(over: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return {
    group_id: null,
    tags: [],
    address: "10.0.0.1",
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

function session(over: Partial<Session> & Pick<Session, "id" | "hostId">): Session {
  return {
    hostName: "h",
    address: "10.0.0.1",
    port: 2222,
    username: null,
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: null,
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

const hosts = [host({ id: 1, name: "fx-a" }), host({ id: 2, name: "fx-b" }), host({ id: 3, name: "fx-c" })];

function seedInvoke() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "batch_exec":
        return "batch-1";
      case "batch_cancel":
        return true;
      case "snippets_list":
        return [];
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

function execCalls(): { targets: unknown[]; concurrency: number; timeoutSecs: number }[] {
  return mockedInvoke.mock.calls.filter(([c]) => c === "batch_exec").map(([, a]) => a);
}

function selectHost(id: number) {
  fireEvent.click(screen.getByTestId(`batch-host-${id}`));
}

function result(over: Partial<BatchResult>): BatchResult {
  return {
    batch_id: "batch-1",
    host_id: 1,
    name: "fx-a",
    status: "ok",
    exit_code: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    duration_ms: 12,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  seedInvoke();
  act(() => {
    useVaultStore.setState({ hosts });
    useSessionStore.setState({
      sessions: [session({ id: "tab-1", hostId: 1, rustId: "pty-1" })],
    });
    useBatchStore.setState({ batchId: null, total: 0, results: [] });
  });
});

describe("BatchPanel", () => {
  it("主机多选切换 + 已选计数 + 未连接徽标", () => {
    render(<BatchPanel open onClose={() => {}} />);
    expect(screen.getByTestId("batch-selected-count").textContent).toContain("0");
    selectHost(1);
    selectHost(3);
    expect(screen.getByTestId("batch-selected-count").textContent).toContain("2");
    // 未连接提示 = 已选中主机里无在册会话的台数：host 3 无会话
    expect(screen.getByTestId("batch-nc-hint").textContent).toContain("1");
    // 只剩已连的 host 1 → 提示消失；只剩未连的 host 3 → 提示回归
    selectHost(3);
    expect(screen.queryByTestId("batch-nc-hint")).toBeNull();
    selectHost(3);
    expect(screen.getByTestId("batch-nc-hint")).toBeTruthy();
    selectHost(1);
    expect(screen.getByTestId("batch-selected-count").textContent).toContain("1");
  });

  it("无主机/无命令时执行禁用", () => {
    render(<BatchPanel open onClose={() => {}} />);
    expect((screen.getByTestId("batch-execute") as HTMLButtonElement).disabled).toBe(true);
    selectHost(1);
    expect((screen.getByTestId("batch-execute") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "whoami" } });
    expect((screen.getByTestId("batch-execute") as HTMLButtonElement).disabled).toBe(false);
  });

  it("green 命令一键执行：batch_exec 载荷 = per-host 渲染命令 + 未连接空 session_id", async () => {
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    selectHost(3);
    fireEvent.change(screen.getByTestId("batch-body"), {
      target: { value: "echo $((41+{{n}}))" },
    });
    fireEvent.change(screen.getByTestId("batch-var-1-n"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("batch-var-3-n"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("batch-execute"));
    await waitFor(() => expect(screen.getByTestId("batch-progress")).toBeTruthy());
    const calls = execCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      targets: [
        { host_id: 1, name: "fx-a", session_id: "pty-1", command: "echo $((41+1))" },
        { host_id: 3, name: "fx-c", session_id: "", command: "echo $((41+2))" },
      ],
      concurrency: 5,
      timeoutSecs: 30,
    });
  });

  it("yellow 二击确认：首击不发起，二击执行", () => {
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    fireEvent.change(screen.getByTestId("batch-body"), {
      target: { value: "sudo systemctl restart nginx" },
    });
    expect(screen.getByTestId("batch-level").className).toContain("ai-level-yellow");
    fireEvent.click(screen.getByTestId("batch-execute"));
    expect(execCalls()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("batch-execute"));
    expect(execCalls()).toHaveLength(1);
  });

  it("red armed：两击红字确认后执行", () => {
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "rm -rf /tmp/x" } });
    expect(screen.getByTestId("batch-level").className).toContain("ai-level-red");
    const btn = screen.getByTestId("batch-execute");
    fireEvent.click(btn);
    expect(execCalls()).toHaveLength(0);
    expect(btn.dataset.stage).toBe("armed");
    fireEvent.click(btn);
    expect(execCalls()).toHaveLength(1);
  });

  it("修改命令/选择后确认状态机复位", () => {
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "sudo reboot" } });
    fireEvent.click(screen.getByTestId("batch-execute"));
    expect(screen.getByTestId("batch-execute").dataset.stage).toBe("confirm");
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "sudo reboot -f" } });
    expect(screen.getByTestId("batch-execute").dataset.stage).toBe("idle");
  });

  it("Fix round 1 I-1：armed 态改变量 → 确认复位，需重新二击", () => {
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "rm -rf {{p}}" } });
    fireEvent.change(screen.getByTestId("batch-var-1-p"), { target: { value: "/tmp/x" } });
    const btn = screen.getByTestId("batch-execute");
    fireEvent.click(btn);
    expect(btn.dataset.stage).toBe("armed");
    expect(execCalls()).toHaveLength(0);
    // armed 后只改变量（/tmp/x → /）也必须重走确认——否则一击即执行新命令串
    fireEvent.change(screen.getByTestId("batch-var-1-p"), { target: { value: "/" } });
    expect(btn.dataset.stage).toBe("idle");
    fireEvent.click(btn);
    expect(btn.dataset.stage).toBe("armed");
    expect(execCalls()).toHaveLength(0);
    fireEvent.click(btn);
    expect(execCalls()).toHaveLength(1);
    // 执行的是改后的命令串
    const calls = execCalls();
    expect((calls[0].targets as { command: string }[])[0].command).toBe("rm -rf /");
  });

  it("结果表：状态档 + 退出码 + 少数派 data-differs 高亮与行级标注", () => {
    act(() => {
      useBatchStore.setState({
        batchId: "batch-9",
        total: 4,
        results: [
          result({ host_id: 1, name: "fx-a", stdout: "42\n", duration_ms: 5 }),
          result({ host_id: 2, name: "fx-b", status: "failed", exit_code: null, error: "boom" }),
          result({ host_id: 3, name: "fx-c", status: "timeout", exit_code: null, duration_ms: 30000 }),
          result({ host_id: 4, name: "fx-d", stdout: "43\n" }),
        ],
      });
    });
    render(<BatchPanel open onClose={() => {}} />);
    // 少数派高亮：fx-d 输出 43 与多数派 42 不同
    const outlierRow = screen.getByTestId("batch-row-4");
    expect(outlierRow.dataset.differs).toBe("true");
    expect(screen.getByTestId("batch-row-1").dataset.differs).toBe("false");
    expect(screen.getByTestId("batch-diff-head")).toBeTruthy();
    // 状态档/错误面
    expect(screen.getByTestId("batch-row-2").dataset.status).toBe("failed");
    expect(screen.getByTestId("batch-row-2").textContent).toContain("boom");
    expect(screen.getByTestId("batch-row-3").dataset.status).toBe("timeout");
    // 完成汇总
    expect(screen.getByTestId("batch-summary").textContent).toContain("2");
  });

  it("展开少数派输出：多数派里没有的行标 batch-diff-line", () => {
    act(() => {
      useBatchStore.setState({
        batchId: "batch-9",
        total: 2,
        results: [
          result({ host_id: 1, name: "fx-a", stdout: "user=nobody\nhome=/root\n" }),
          result({ host_id: 2, name: "fx-b", stdout: "user=spike\nhome=/root\n" }),
        ],
      });
    });
    render(<BatchPanel open onClose={() => {}} />);
    const row = screen.getByTestId("batch-row-2");
    expect(row.dataset.differs).toBe("true");
    // jsdom 不支持 details 交互，但 children 恒在 DOM——直接断言行级标注
    // 少数派输出里 "user=spike" 不在多数派行集合 → 高亮行
    expect(screen.getAllByTestId("batch-diff-line").map((el) => el.textContent)).toEqual([
      "user=spike",
    ]);
    // Fix round 1 I-2：行间补 "\n" 文本节点——多行输出不粘行，textContent 保留换行
    const pre = row.querySelector("pre");
    expect(pre!.textContent).toBe("user=spike\nhome=/root");
  });

  it("输出全同的机器折叠为一组（batch-group 摘要）", () => {
    act(() => {
      useBatchStore.setState({
        batchId: "batch-9",
        total: 2,
        results: [
          result({ host_id: 1, name: "fx-a", stdout: "spike\n" }),
          result({ host_id: 2, name: "fx-b", stdout: "spike\n" }),
        ],
      });
    });
    render(<BatchPanel open onClose={() => {}} />);
    expect(screen.getByTestId("batch-group").textContent).toContain("2");
    expect(screen.queryByTestId("batch-diff-head")).toBeNull();
  });

  it("执行中可取消：batch_cancel 带 batch_id", async () => {
    act(() => {
      useBatchStore.getState().begin("batch-1", 2);
      useBatchStore.getState().onBatchResult(result({ host_id: 1 }));
    });
    render(<BatchPanel open onClose={() => {}} />);
    expect(screen.getByTestId("batch-progress")).toBeTruthy();
    fireEvent.click(screen.getByTestId("batch-cancel"));
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.some(([c, a]) => c === "batch_cancel" && (a as { batchId: string }).batchId === "batch-1")).toBe(true),
    );
  });

  it("snippet 选择回填命令体", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "snippets_list") {
        return [{ id: 7, name: "uptime", body: "uptime {{secs}}", variables: [], tags: [], host_scope: null, created_at: 1, updated_at: 1 }];
      }
      if (cmd === "batch_exec") return "batch-1";
      if (cmd === "batch_cancel") return true;
      throw new Error(`unexpected command: ${cmd}`);
    });
    render(<BatchPanel open onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByTestId("batch-snippet") as HTMLSelectElement).options.length).toBe(2),
    );
    fireEvent.change(screen.getByTestId("batch-snippet"), { target: { value: "7" } });
    expect((screen.getByTestId("batch-body") as HTMLTextAreaElement).value).toBe("uptime {{secs}}");
  });

  it("发起失败（命令报错）显示错误面", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "snippets_list") return [];
      throw new Error("batch: no targets");
    });
    render(<BatchPanel open onClose={() => {}} />);
    selectHost(1);
    fireEvent.change(screen.getByTestId("batch-body"), { target: { value: "whoami" } });
    fireEvent.click(screen.getByTestId("batch-execute"));
    await waitFor(() => expect(screen.getByTestId("batch-error")).toBeTruthy());
  });
});
