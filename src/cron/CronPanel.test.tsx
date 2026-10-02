// CronPanel 组件测试（Phase 4 Task 1）：任务列表（主机/schedule/下次触发/
// 最近运行徽标）、enabled 开关、立即运行、历史展开、表单载荷（主机/schedule/
// script/channels/enabled）、删除。invoke 走 mock（BatchPanel 同款纪律）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { CronPanel } from "./CronPanel";
import { useCronStore } from "./cronStore";
import { useVaultStore } from "../vault/store";
import type { CronJob, CronRun, CronRunEvent } from "./api";
import type { Host } from "../vault/api";

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

function job(over: Partial<CronJob>): CronJob {
  return {
    id: 1,
    host_id: 3,
    schedule: "*/5 * * * *",
    script: "echo hi",
    channels: [],
    enabled: true,
    created_at: 100,
    updated_at: 100,
    ...over,
  };
}

function run(over: Partial<CronRun>): CronRun {
  return {
    id: 11,
    cron_id: 1,
    status: "ok",
    exit_code: 0,
    output_digest: null,
    output_path: null,
    duration_ms: 42,
    ts: 1_800_000_000,
    ...over,
  };
}

const hosts = [host({ id: 3, name: "fx-a" }), host({ id: 4, name: "fx-b" })];

function seedJobs(jobs: CronJob[]) {
  useCronStore.setState({ jobs, live: {}, error: null });
}

beforeEach(() => {
  useVaultStore.setState({ hosts, error: null });
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string, _args?: Record<string, unknown>) => {
    switch (cmd) {
      case "cj_list":
        return useCronStore.getState().jobs;
      case "cj_next_fire":
        return 1_800_060_000;
      case "cj_runs":
        return [run({})];
      case "cj_update":
      case "cj_delete":
      case "cj_trigger":
        return cmd === "cj_trigger"
          ? ({ run_id: 9 } as CronRunEvent)
          : ({} as unknown as CronJob);
      case "notifyChannels_list":
        return [];
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
});

describe("CronPanel", () => {
  it("空态（无任务）", async () => {
    seedJobs([]);
    render(<CronPanel open onClose={() => {}} />);
    expect(screen.getByTestId("cron-empty")).toBeTruthy();
  });

  it("任务行渲染（主机名 + schedule + 下次触发；先播种再挂载避免在途刷新回写）", async () => {
    seedJobs([job({})]);
    render(<CronPanel open onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("cron-row-1")).toBeTruthy();
    });
    expect(screen.getByTestId("cron-row-1").textContent).toContain("fx-a");
    expect(screen.getByTestId("cron-row-1").textContent).toContain("*/5 * * * *");
    await waitFor(() => {
      expect(screen.getByTestId("cron-next-1").textContent).not.toBe("—");
    }); // 下次触发由 cj_next_fire 解析
  });

  it("enabled 开关走 cj_update 全量替换", async () => {
    seedJobs([job({ enabled: true })]);
    render(<CronPanel open onClose={() => {}} />);
    const toggle = await screen.findByTestId("cron-enabled-1");
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        "cj_update",
        expect.objectContaining({
          id: 1,
          input: expect.objectContaining({ enabled: false }),
        }),
      );
    });
  });

  it("立即运行调 cj_trigger；历史展开调 cj_runs", async () => {
    seedJobs([job({})]);
    render(<CronPanel open onClose={() => {}} />);
    await screen.findByTestId("cron-row-1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-run-1"));
    });
    expect(mockedInvoke).toHaveBeenCalledWith("cj_trigger", { id: 1 });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-history-1"));
    });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("cj_runs", { cronId: 1, limit: 20 });
      expect(screen.getByTestId("cron-runs-1").textContent).toContain("exit 0");
    });
  });

  // Phase 4 走查批（OBS-1）：展开的运行历史挂在行容器内的专类上
  // （.cron-row → flex-wrap，使展开区独占一行——真窗 flex 挤压不可见缺陷面）。
  it("历史展开区在行容器内（cron-row 专类供展开布局挂钩）", async () => {
    seedJobs([job({})]);
    render(<CronPanel open onClose={() => {}} />);
    await screen.findByTestId("cron-row-1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-history-1"));
    });
    const runs = await screen.findByTestId("cron-runs-1");
    const row = runs.closest("li");
    expect(row?.className).toContain("cron-row");
  });

  // Phase 4 走查批（OBS-1）：面板开着时 live 事件驱动两处刷新——
  // ①行内徽标带最新轮时刻（可观察新鲜度，不再是无变化的「成功 (0)」）；
  // ②展开中的历史自动 refetch（cj_runs 重拉），不重开面板也能看到新落库轮次。
  it("live 事件：徽标带最新轮时刻；展开中的历史自动 refetch", async () => {
    seedJobs([job({})]);
    render(<CronPanel open onClose={() => {}} />);
    await screen.findByTestId("cron-row-1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-history-1"));
    });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("cj_runs", { cronId: 1, limit: 20 });
    });
    const callsAfterExpand = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === "cj_runs",
    ).length;

    const event: CronRunEvent = {
      run_id: 12,
      cron_id: 1,
      host_id: 3,
      status: "ok",
      exit_code: 0,
      duration_ms: 55,
      ts: 1_800_000_100,
      output_digest: null,
      truncated: false,
      error: null,
      channel_ids: [],
    };
    await act(async () => {
      useCronStore.getState().onRunEvent(event);
    });

    // ① 徽标出现且带最新轮时刻（formatTime(1_800_000_100)）
    const badge = screen.getByTestId("cron-last-1");
    expect(badge.textContent).toContain("OK");
    expect(badge.textContent).toContain(new Date(1_800_000_100 * 1000).toLocaleString());
    // ② 展开中的历史自动 refetch（cj_runs 比展开时多拉一次）
    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "cj_runs").length;
      expect(calls).toBeGreaterThan(callsAfterExpand);
    });
  });

  it("删除调 cj_delete", async () => {
    seedJobs([job({})]);
    render(<CronPanel open onClose={() => {}} />);
    await screen.findByTestId("cron-row-1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-delete-1"));
    });
    expect(mockedInvoke).toHaveBeenCalledWith("cj_delete", { id: 1 });
  });

  it("表单：校验 + cj_create 载荷（主机/schedule/script/channels/enabled）", async () => {
    seedJobs([]);
    render(<CronPanel open onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-add"));
    });
    // 空脚本被拦
    await act(async () => {
      fireEvent.submit(screen.getByTestId("cron-form-save").closest("form")!);
    });
    expect(screen.getByTestId("cron-form-error")).toBeTruthy();
    expect(mockedInvoke).not.toHaveBeenCalledWith("cj_create", expect.anything());

    fireEvent.change(screen.getByTestId("cron-form-host"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("cron-form-schedule"), { target: { value: "0 9-17 * * 1-5" } });
    fireEvent.change(screen.getByTestId("cron-form-script"), { target: { value: "uptime" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("cron-form-save"));
    });
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        "cj_create",
        expect.objectContaining({
          input: {
            host_id: 4,
            schedule: "0 9-17 * * 1-5",
            script: "uptime",
            channels: [],
            enabled: true,
          },
        }),
      );
    });
  });

  it("schedule 输入防抖预览：非法表达式显示错误文案", async () => {
    vi.useFakeTimers();
    try {
      seedJobs([]);
      render(<CronPanel open onClose={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("cron-add"));
      });
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "cj_next_fire") throw new Error("invalid cron schedule: expected 5 fields");
        return [];
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId("cron-form-schedule"), {
          target: { value: "garbage" },
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // i18n 测试环境语言不定，两语任一即算命中
      expect(screen.getByTestId("cron-form-preview").textContent).toMatch(/无法解析|Cannot parse/);
    } finally {
      vi.useRealTimers();
    }
  });
});
