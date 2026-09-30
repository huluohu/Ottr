// TransferStore 状态机测试（Task 10 Step 4）：队列条目生命周期 + 事件竞态 +
// 取消/重试/清除。invoke 全量 mock（真后端命令已在 src-tauri 接线）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  sortQueueItems,
  useTransferStore,
  type TransferBeginPayload,
  type TransferEndPayload,
  type TransferProgressPayload,
} from "./TransferStore";

const mockedInvoke = invoke as unknown as Mock;

function resetStore() {
  useTransferStore.setState({ items: [] });
  mockedInvoke.mockReset();
}

describe("TransferStore 状态机", () => {
  beforeEach(resetStore);

  it("startDownload 成功 → active 占位（回执字段齐全）", async () => {
    mockedInvoke.mockResolvedValueOnce({
      transfer_id: "xfer-1",
      local_path: "/Users/me/Downloads/a.bin",
      remote_path: "/tmp/a.bin",
      total: 1000,
    });
    await useTransferStore.getState().startDownload("pty-1", "/tmp/a.bin");
    const items = useTransferStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      transferId: "xfer-1",
      kind: "download",
      rustId: "pty-1",
      total: 1000,
      transferred: 0,
      status: "active",
      cancelling: false,
    });
  });

  it("begin 事件先于命令回执的竞态：占位建条目，回执合并不重复", async () => {
    // 事件先到（total 0 待校正）
    const begin: TransferBeginPayload = {
      transfer_id: "xfer-race",
      kind: "upload",
      remote_path: "/tmp/a.bin",
      local_path: "/Users/me/a.bin",
      total: 0,
    };
    useTransferStore.getState().onBegin(begin);
    expect(useTransferStore.getState().items).toHaveLength(1);

    // 回执后到：只合并（total/rustId），不新建
    mockedInvoke.mockResolvedValueOnce({
      transfer_id: "xfer-race",
      local_path: "/Users/me/a.bin",
      remote_path: "/tmp/a.bin",
      total: 2048,
    });
    await useTransferStore.getState().startUpload("pty-2", "/Users/me/a.bin", "/tmp");
    const items = useTransferStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ total: 2048, rustId: "pty-2", status: "active" });
  });

  it("progress/end 驱动：进度前进，end 分派 done/failed/cancelled", () => {
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-1",
          kind: "download",
          remotePath: "/tmp/a.bin",
          localPath: "/d/a.bin",
          rustId: "pty-1",
          total: 100,
          transferred: 0,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: 1,
        },
      ],
    });
    const progress: TransferProgressPayload = {
      transfer_id: "xfer-1",
      transferred: 60,
      total: 100,
    };
    useTransferStore.getState().onProgress(progress);
    expect(useTransferStore.getState().items[0]).toMatchObject({ transferred: 60, total: 100 });

    const done: TransferEndPayload = { transfer_id: "xfer-1", status: "done", message: "" };
    useTransferStore.getState().onEnd(done);
    expect(useTransferStore.getState().items[0].status).toBe("done");

    // failed 携带错误文本；cancelled 清 cancelling 过渡态
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-2",
          kind: "download",
          remotePath: "/tmp/b.bin",
          localPath: "/d/b.bin",
          rustId: "pty-1",
          total: 10,
          transferred: 4,
          status: "active",
          error: null,
          cancelling: true,
          startedAt: 2,
        },
      ],
    });
    useTransferStore
      .getState()
      .onEnd({ transfer_id: "xfer-2", status: "failed", message: "boom" });
    expect(useTransferStore.getState().items[0]).toMatchObject({
      status: "failed",
      error: "boom",
      cancelling: false,
    });
    useTransferStore
      .getState()
      .onEnd({ transfer_id: "xfer-2", status: "cancelled", message: "" });
    expect(useTransferStore.getState().items[0]).toMatchObject({
      status: "cancelled",
      cancelling: false,
    });
  });

  it("cancel：invoke + cancelling 过渡态；未知 id 回滚过渡态并抛错", async () => {
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-1",
          kind: "download",
          remotePath: "/tmp/a.bin",
          localPath: "/d/a.bin",
          rustId: "pty-1",
          total: 10,
          transferred: 1,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: 1,
        },
      ],
    });
    mockedInvoke.mockResolvedValueOnce(undefined);
    await useTransferStore.getState().cancel("xfer-1");
    expect(mockedInvoke).toHaveBeenCalledWith("transfer_cancel", { transferId: "xfer-1" });
    expect(useTransferStore.getState().items[0].cancelling).toBe(true);

    mockedInvoke.mockRejectedValueOnce("no such transfer: xfer-9");
    await expect(useTransferStore.getState().cancel("xfer-9")).rejects.toBe(
      "no such transfer: xfer-9",
    );
  });

  it("retry：failed/cancelled → 同参数重发（新 transferId），旧条目移除", async () => {
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-old",
          kind: "download",
          remotePath: "/tmp/a.bin",
          localPath: "/Downloads/a.bin",
          rustId: "pty-1",
          total: 10,
          transferred: 3,
          status: "cancelled",
          error: null,
          cancelling: false,
          startedAt: 1,
        },
      ],
    });
    mockedInvoke.mockResolvedValueOnce({
      transfer_id: "xfer-new",
      local_path: "/Downloads/a.bin",
      remote_path: "/tmp/a.bin",
      total: 10,
    });
    await useTransferStore.getState().retry("xfer-old");
    expect(mockedInvoke).toHaveBeenCalledWith("sftp_download", {
      id: "pty-1",
      remote: "/tmp/a.bin",
      local: "/Downloads/a.bin",
    });
    const items = useTransferStore.getState().items;
    expect(items.map((i) => i.transferId)).toEqual(["xfer-new"]);
    expect(items[0].status).toBe("active");

    // active 条目 retry 是 no-op
    await useTransferStore.getState().retry("xfer-new");
    expect(useTransferStore.getState().items).toHaveLength(1);
  });

  it("retry 上传：remote_dir = 远端路径父目录", async () => {
    useTransferStore.setState({
      items: [
        {
          transferId: "xfer-up",
          kind: "upload",
          remotePath: "/srv/deploy/app.tar",
          localPath: "/Users/me/app.tar",
          rustId: "pty-3",
          total: 5,
          transferred: 0,
          status: "failed",
          error: "boom",
          cancelling: false,
          startedAt: 1,
        },
      ],
    });
    mockedInvoke.mockResolvedValueOnce({
      transfer_id: "xfer-up2",
      local_path: "/Users/me/app.tar",
      remote_path: "/srv/deploy/app.tar",
      total: 5,
    });
    await useTransferStore.getState().retry("xfer-up");
    expect(mockedInvoke).toHaveBeenCalledWith("sftp_upload", {
      id: "pty-3",
      local: "/Users/me/app.tar",
      remoteDir: "/srv/deploy",
    });
  });

  it("dismiss 移除条目；sortQueueItems active→收尾→failed", () => {
    const mk = (id: string, status: "active" | "done" | "failed" | "cancelled") => ({
      transferId: id,
      kind: "download" as const,
      remotePath: `/tmp/${id}`,
      localPath: `/d/${id}`,
      rustId: "p",
      total: 1,
      transferred: 1,
      status,
      error: null,
      cancelling: false,
      startedAt: 1,
    });
    const items = [mk("f", "failed"), mk("d", "done"), mk("a", "active"), mk("c", "cancelled")];
    expect(sortQueueItems(items).map((i) => i.transferId)).toEqual(["a", "d", "c", "f"]);
    useTransferStore.setState({ items });
    useTransferStore.getState().dismiss("c");
    expect(useTransferStore.getState().items.map((i) => i.transferId)).toEqual([
      "f",
      "d",
      "a",
    ]);
  });
});
