// SyncDialog 组件测试（Phase 5 Task 4）：三态动作 → 确认面状态机。
//   * 未配置通道 → nochannel；钥匙链无口令 → askpass（记住勾选走保存面）；
//   * push 态：范围勾选（默认取偏好）→ setScope+push 精确调用 → 完成面；
//   * pull 态：覆盖预告（红线延伸——勾选即亮出该分类将被替换的本机数据）→
//     setScope+pull → 完成面带导入回执；
//   * conflict 态：ConflictDialog 裁定 → 先 pull(云端侧) 再 push(双侧有数据
//     并集) 全序断言（信封全量语义，见 SyncDialog 文件头）；
//   * synced 态信息面；auth 错误回 askpass；执行失败入 error 面 + 重试；
//   * A5 解困（ui-batch2 T4）：检查挂起 → 10s 超时入错误面（关闭恢复可达，
//     迟到 settle 不回填）；busy 中 Esc/关闭恒可达 = 放弃本次同步。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

import "../i18n";
import { EnvelopeError } from "./envelope";
import { SYNC_CATEGORIES, type SyncAction, type SyncCategory, type SyncData } from "./engine";
import type { CategoryConflict } from "./engine";
import type { PullResult, SyncStatus, SyncStore } from "./SyncStore";
import type { SyncDialogModel } from "./SyncDialog";
import { SyncDialog } from "./SyncDialog";

function dataWith(rows: Partial<Record<SyncCategory, unknown[]>>): SyncData {
  const categories = {} as SyncData["categories"];
  for (const c of SYNC_CATEGORIES) categories[c] = rows[c] ?? [];
  return { version: 1, categories };
}

const LOCAL = dataWith({
  hosts: [{ id: 1, name: "db1", address: "10.0.0.1", port: 22 }],
  settings: [{ key: "ui.language", value: "zh-CN" }],
});
const REMOTE = dataWith({
  hosts: [{ id: 88, name: "db1", address: "10.0.0.1", port: 22 }],
  snippets: [{ id: 9, name: "deploy", body: "x" }],
});

const CONFLICTS: CategoryConflict[] = [
  { category: "hosts", local_count: 1, remote_count: 1, local_fp: "a", remote_fp: "b" },
  { category: "snippets", local_count: 0, remote_count: 1, local_fp: "c", remote_fp: "d" },
];

function statusOf(action: SyncAction, overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    action,
    localFp: "l",
    remoteFp: "r",
    remoteExists: true,
    baseline: { remote_fp: "r0", local_fp: "l0", saved_at: 1_700_000_000 },
    conflicts: action === "conflict" ? CONFLICTS : null,
    ...overrides,
  };
}

/** 记录调用的假 store（默认 push/pull resolve，带导入回执）。 */
function fakeStore(
  status: SyncStatus,
  overrides: Partial<Record<string, unknown>> = {},
): SyncStore & { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  const store = {
    calls,
    getScope: vi.fn(async (kind: "push" | "restore") =>
      kind === "push" ? (["hosts", "settings"] as SyncCategory[]) : (["hosts"] as SyncCategory[]),
    ),
    setScope: vi.fn(async (kind: "push" | "restore", cats: readonly SyncCategory[]) => {
      calls.push({ op: `setScope:${kind}`, args: [[...cats]] });
    }),
    push: vi.fn(async (_pass: string, cats?: readonly SyncCategory[]) => {
      calls.push({ op: "push", args: [cats ? [...cats] : null] });
      return { action: "push" as const, localFp: "l2", remoteFp: "r2" };
    }),
    pull: vi.fn(async (_pass: string, cats?: readonly SyncCategory[]) => {
      calls.push({ op: "pull", args: [cats ? [...cats] : null] });
      const report = { applied: { hosts: 1 }, skipped: { alert_rules: 2 } };
      return { action: "pull" as const, localFp: "l2", remoteFp: "r2", report } satisfies PullResult;
    }),
    status: vi.fn(async () => {
      calls.push({ op: "status", args: [] });
      return status;
    }),
    ...(overrides as object),
  };
  return store;
}

function fakeModel(over: Partial<SyncDialogModel> = {}): SyncDialogModel {
  const base = {
    store: null as unknown as SyncStore,
    passphrase: vi.fn(async () => "stored-pass"),
    savePassphrase: vi.fn(async () => {}),
    localSnapshot: vi.fn(async () => LOCAL),
    remoteSnapshot: vi.fn(async () => REMOTE),
    channelReady: vi.fn(async () => true),
  };
  return { ...base, ...over } as SyncDialogModel;
}

function renderDialog(model: SyncDialogModel, onClose = vi.fn()) {
  render(<SyncDialog open onClose={onClose} model={model} />);
  return { onClose };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("SyncDialog", () => {
  it("未配置通道 → nochannel 面；配置好但无口令 → askpass（记住勾选默认开，继续走保存+status）", async () => {
    const store = fakeStore(statusOf("synced"));
    const fm = fakeModel({ store, channelReady: vi.fn(async () => false), passphrase: vi.fn(async () => null) });
    renderDialog(fm);
    expect(await screen.findByTestId("sync-nochannel")).toBeTruthy();

    const fm2 = fakeModel({ store, passphrase: vi.fn(async () => null) });
    cleanup();
    renderDialog(fm2);
    await waitFor(() => expect(screen.getByTestId("sync-askpass")).toBeTruthy());
    expect((screen.getByTestId("sync-askpass-save") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("sync-askpass-continue") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("sync-askpass-input"), { target: { value: "p1" } });
    fireEvent.click(screen.getByTestId("sync-askpass-continue"));
    await waitFor(() => expect(fm2.savePassphrase).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(store.status).toHaveBeenCalled());
    // synced 态收尾
    expect(await screen.findByTestId("sync-synced")).toBeTruthy();
  });

  it("push 态：默认范围取 push 偏好，取消勾选后 setScope+push 按勾选范围执行 → 完成面", async () => {
    const store = fakeStore(statusOf("push"));
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("sync-push-panel")).toBeTruthy());
    // 默认勾选 = getScope("push") 偏好
    expect((screen.getByTestId("push-scope-hosts") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("push-scope-settings") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("push-scope-snippets") as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByTestId("push-scope-settings")); // 取消 settings
    fireEvent.click(screen.getByTestId("sync-push-start"));
    await waitFor(() => expect(store.push).toHaveBeenCalledWith("stored-pass", ["hosts"], expect.anything()));
    expect(store.setScope).toHaveBeenCalledWith("push", ["hosts"]);
    expect(await screen.findByTestId("sync-done-text").then((el) => el.textContent)).toContain("推送");
  });

  it("pull 态：勾选分类即亮出本机将被覆盖清单（红线延伸）；按勾选范围 pull → 完成面带回执", async () => {
    const store = fakeStore(statusOf("pull"));
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("sync-pull-panel")).toBeTruthy());
    // 默认勾选 = restore 偏好（hosts）→ hosts 预告已出现且含本机条目
    expect(screen.getByTestId("pull-overwrite-hosts")).toBeTruthy();
    expect(screen.getByTestId("pull-overwrite-entries-hosts").textContent).toContain("db1 (10.0.0.1:22)");
    // 未勾选分类无预告
    expect(screen.queryByTestId("pull-overwrite-settings")).toBeNull();

    // 勾选 settings → 立刻亮出其本机数据
    fireEvent.click(screen.getByTestId("restore-scope-settings"));
    expect(screen.getByTestId("pull-overwrite-settings").textContent).toContain("ui.language");

    fireEvent.click(screen.getByTestId("sync-pull-start"));
    await waitFor(() => expect(store.pull).toHaveBeenCalledWith("stored-pass", ["hosts", "settings"], expect.anything()));
    expect(store.setScope).toHaveBeenCalledWith("restore", ["hosts", "settings"]);
    expect(await screen.findByTestId("sync-done-report").then((el) => el.textContent)).toContain("1");
  });

  it("BL-525：导入后实体刷新失败 → 错误面如实呈现（form-error 可见，不吞不假成功）", async () => {
    const store = fakeStore(statusOf("pull"), {
      pull: vi.fn(async (_pass: string, cats?: readonly SyncCategory[]) => {
        // 生产形态：SyncStore onImported（entityRefresh）在基线写盘前上抛的
        // 本地化包装错误（zh = 「云端数据已应用，但界面刷新失败：…」）。
        throw new Error("sync.dialog.refreshFailed：boom-cause");
      }),
    });
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("sync-pull-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-pull-start"));
    const err = await screen.findByTestId("sync-error");
    expect(err.textContent).toContain("sync.dialog.refreshFailed");
    expect(err.textContent).toContain("boom-cause");
    // 不落 done 面（不假成功）
    expect(screen.queryByTestId("sync-done")).toBeNull();
  });

  it("conflict 态：裁定（hosts=本机、snippets=云端）→ 先 pull 云端侧再 push 双侧有数据并集（全序）", async () => {
    const store = fakeStore(statusOf("conflict"));
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("sync-conflict-panel")).toBeTruthy());
    // 红线：保留云端 → 覆盖预告（本机值）
    fireEvent.click(screen.getByTestId("keep-cloud-hosts"));
    expect(screen.getByTestId("overwrite-disclosure-hosts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("keep-local-snippets"));
    fireEvent.click(screen.getByTestId("conflict-apply"));

    await waitFor(() => {
      expect(store.calls.map((c) => c.op)).toEqual(["status", "pull", "push"]);
    });
    expect(store.calls[1]!.args[0]).toEqual(["hosts"]); // 云端侧先入本机
    // 发布面 = 双侧任一有数据（hosts、snippets、settings）∪ 裁定分类——
    // 信封全量语义：settings 本夹具有数据，随发布面一并写入，防止只推裁定
    // 分类把云端其余分类清空（SyncDialog 文件头论证）。
    expect(store.calls[2]!.args[0]).toEqual(["hosts", "snippets", "settings"]);
    expect(await screen.findByTestId("sync-done-text").then((el) => el.textContent)).toContain("合并");
  });

  it("conflict 态全选云端：每分类预告先亮（红线）→ pull 全部冲突分类", async () => {
    const store = fakeStore(statusOf("conflict"));
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("conflict-all-cloud")).toBeTruthy());
    fireEvent.click(screen.getByTestId("conflict-all-cloud"));
    expect(screen.getByTestId("overwrite-disclosure-hosts")).toBeTruthy();
    expect(screen.getByTestId("overwrite-disclosure-snippets")).toBeTruthy();
    fireEvent.click(screen.getByTestId("conflict-apply"));
    await waitFor(() => expect(store.pull).toHaveBeenCalledWith("stored-pass", ["hosts", "snippets"], expect.anything()));
  });

  it("auth 错误（status / push 中途）→ 回 askpass 并显示口令错；执行失败 → error 面 + 重试重走 status", async () => {
    const authErr = new EnvelopeError("auth", "nope");
    const store = fakeStore(statusOf("push"));
    (store.status as ReturnType<typeof vi.fn>).mockRejectedValue(authErr);
    const fm = fakeModel({ store });
    renderDialog(fm);
    await waitFor(() => expect(screen.getByTestId("sync-askpass")).toBeTruthy());
    expect(screen.getByTestId("sync-askpass-error").textContent).toContain("口令不对");

    // push 中途失败（非 auth）→ error 面
    const store2 = fakeStore(statusOf("push"));
    (store2.push as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 507"));
    const fm2 = fakeModel({ store: store2 });
    cleanup();
    renderDialog(fm2);
    await waitFor(() => expect(screen.getByTestId("sync-push-panel")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-push-start"));
    expect(await screen.findByTestId("sync-error-text").then((el) => el.textContent)).toContain("HTTP 507");
    // 重试 → 重走 status → push 面回归
    fireEvent.click(screen.getByTestId("sync-retry"));
    expect(await screen.findByTestId("sync-push-panel")).toBeTruthy();
  });

  it("关闭钮 busy 中亦可达（A5 解困）；synced 态显示上次同步时间", async () => {
    const store = fakeStore(statusOf("synced"));
    const fm = fakeModel({ store });
    renderDialog(fm);
    expect(screen.getByTestId("sync-dialog-close")).toBeTruthy();
    expect((screen.getByTestId("sync-dialog-close") as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByTestId("sync-last-sync").then((el) => el.textContent)).not.toContain("尚未");
  });

  // --- A5 解困（ui-batch2 T4）：伪 home 无钥匙链时 sync_passphrase_get 会
  // 被系统授权弹窗阻塞（invoke 永不 settle），checking 态困死（39 号缺陷）。

  it("检查挂起 → 10s 超时入错误面（关闭钮恢复可用）；迟到 settle 不回填旧运行", async () => {
    vi.useFakeTimers();
    try {
      let resolveStatus: (s: SyncStatus) => void = () => {};
      const store = fakeStore(statusOf("synced"));
      (store.status as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<SyncStatus>((res) => { resolveStatus = res; }),
      );
      const onClose = vi.fn();
      render(<SyncDialog open onClose={onClose} model={fakeModel({ store })} />);
      expect(screen.getByTestId("sync-checking")).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(screen.getByTestId("sync-error-text").textContent).toContain("超时");
      expect((screen.getByTestId("sync-dialog-close") as HTMLButtonElement).disabled).toBe(false);

      // 迟到 settle（系统弹窗最终被确认）：代序守卫丢弃，error 面不被覆盖
      resolveStatus(statusOf("synced"));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId("sync-synced")).toBeNull();
      expect(screen.getByTestId("sync-error-text")).toBeTruthy();

      fireEvent.click(screen.getByTestId("sync-dialog-close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("busy（检查挂起）中 Esc 强制关闭 = 放弃本次同步（A5：Esc 恢复可达）", () => {
    const store = fakeStore(statusOf("synced"));
    const fm = fakeModel({
      store,
      passphrase: vi.fn(() => new Promise<string | null>(() => {})), // 永挂（系统弹窗阻塞面）
    });
    const onClose = vi.fn();
    render(<SyncDialog open onClose={onClose} model={fm} />);
    expect(screen.getByTestId("sync-checking")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("running 中点关闭 = 放弃：关闭可达（带披露 title），迟到完成不回填 done 面", async () => {
    let resolvePush: () => void = () => {};
    const store = fakeStore(statusOf("push"));
    (store.push as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((res) => { resolvePush = res; }),
    );
    const onClose = vi.fn();
    render(<SyncDialog open onClose={onClose} model={fakeModel({ store })} />);
    await waitFor(() => expect(screen.getByTestId("sync-push-panel")).toBeTruthy());

    fireEvent.click(screen.getByTestId("sync-push-start"));
    expect(screen.getByTestId("sync-running")).toBeTruthy();
    // I-1(b) 披露：running 面旁注 + 关闭钮 title 双挂
    expect(screen.getByTestId("sync-running-abandon-hint").textContent).toContain("放弃");
    expect(screen.getByTestId("sync-dialog-close").getAttribute("title")).toContain("放弃");
    expect((screen.getByTestId("sync-dialog-close") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("sync-dialog-close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    // 后台 push 最终完成：不回填已弃的运行（无 done 面，running 面维持）
    resolvePush();
    await act(async () => {});
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.getByTestId("sync-running")).toBeTruthy();
  });

  // fix round 1 I-2：runStatus push/pull/conflict 分支的 await 后同样查岗——
  // 放弃后快速重开，旧延续的迟到 settle 不得污染新运行相位。
  it("放弃后快速重开：旧 runStatus 延续（getScope 在途）不污染新相位", async () => {
    const scopeResolvers: Array<(v: SyncCategory[]) => void> = [];
    const store = fakeStore(statusOf("pull"));
    (store.getScope as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SyncCategory[]>((res) => { scopeResolvers.push(res); }),
    );
    const fm = fakeModel({
      store,
      passphrase: vi.fn<() => Promise<string | null>>()
        .mockResolvedValueOnce("stored-pass") // 第一次运行：status → pull 分支（getScope 在途）
        .mockResolvedValueOnce(null), // 重开后的新运行：止步 askpass
    });
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="reopen-sync" onClick={() => setOpen(true)}>
            reopen
          </button>
          <SyncDialog open={open} onClose={() => setOpen(false)} model={fm} />
        </>
      );
    }
    render(<Host />);
    await waitFor(() => expect(store.getScope).toHaveBeenCalledTimes(1)); // pull 分支已进入

    fireEvent.click(screen.getByTestId("sync-dialog-close")); // 放弃旧运行
    expect(screen.queryByTestId("sync-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("reopen-sync")); // 快速重开（新 seq）
    expect(await screen.findByTestId("sync-askpass")).toBeTruthy(); // 新运行自置相位
    expect(screen.queryByTestId("sync-pull-panel")).toBeNull();

    // 旧延续此刻才 settle：守卫拦截——不 setState、不再走 localSnapshot
    scopeResolvers[0]!(["hosts"] as SyncCategory[]);
    await act(async () => {});
    expect(screen.getByTestId("sync-askpass")).toBeTruthy(); // 新相位不被污染
    expect(screen.queryByTestId("sync-pull-panel")).toBeNull();
    expect(fm.localSnapshot).not.toHaveBeenCalled();
  });
});
