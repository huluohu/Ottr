// batchStore 单测：乱序容错（2026-11-08 审计 C1）——Rust 侧结果事件在
// spawn 后、exec 回执返回前 emit（batch.rs 的池任务先于 Ok(batch_id)），
// 「未连接主机」这类同步失败的首个结果可抢在回执前落地。此前 onBatchResult
// 对未知 batch_id 直接丢弃 → results 永远到不了 total → 进度条永久卡死。
// 修法与 TransferStore 的「begin 事件可能先于命令回执落地」同款：暂存
// pending，begin 时回收同 id、丢弃旧批尾巴。
import { beforeEach, describe, expect, it } from "vitest";
import { useBatchStore } from "./batchStore";
import type { BatchResult } from "./api";

function result(batchId: string, hostId: number, status: BatchResult["status"] = "ok"): BatchResult {
  return {
    batch_id: batchId,
    host_id: hostId,
    name: `host-${hostId}`,
    status,
    exit_code: status === "ok" ? 0 : 1,
    stdout: status === "ok" ? "out" : "",
    stderr: status === "ok" ? "" : "err",
    truncated: false,
    duration_ms: 12,
    error: null,
  };
}

beforeEach(() => {
  useBatchStore.getState().reset();
});

describe("batchStore：结果事件先于 exec 回执（乱序容错）", () => {
  it("回执前的结果事件暂存 pending，begin 回收同 id → finished 立即收敛", () => {
    useBatchStore.getState().onBatchResult(result("b1", 1, "failed"));
    // 回执未到：results 为空、finished 假
    expect(useBatchStore.getState().results).toHaveLength(0);
    expect(useBatchStore.getState().finished()).toBe(false);

    useBatchStore.getState().begin("b1", 1);
    const s = useBatchStore.getState();
    expect(s.batchId).toBe("b1");
    expect(s.results).toHaveLength(1);
    expect(s.results[0].status).toBe("failed");
    expect(s.finished()).toBe(true);
  });

  it("begin 只回收同 id 的暂存，旧批尾巴丢弃", () => {
    useBatchStore.getState().onBatchResult(result("old", 1));
    useBatchStore.getState().onBatchResult(result("b1", 2));
    useBatchStore.getState().begin("b1", 1);
    const s = useBatchStore.getState();
    expect(s.results.map((r) => r.batch_id)).toEqual(["b1"]);
    expect(s.pending).toHaveLength(0);
  });

  it("正常路径（回执先到）不受影响；旧批尾巴丢弃、孤儿事件进 pending", () => {
    useBatchStore.getState().begin("b1", 1);
    useBatchStore.getState().onBatchResult(result("b1", 1));
    expect(useBatchStore.getState().results).toHaveLength(1);

    // reset→重发后旧批事件迟到：已有新批在跑（batchId=b2）→ 静默丢弃
    useBatchStore.getState().reset();
    useBatchStore.getState().begin("b2", 1);
    useBatchStore.getState().onBatchResult(result("b1", 9));
    expect(useBatchStore.getState().results).toHaveLength(0);
    expect(useBatchStore.getState().pending).toHaveLength(0);

    // 空闲态（reset 后无批次）收到的孤儿事件进 pending，下次 begin 兜底回收
    useBatchStore.getState().reset();
    useBatchStore.getState().onBatchResult(result("b3", 5));
    expect(useBatchStore.getState().pending).toHaveLength(1);
  });

  it("reset 清空 pending（不留跨批残留）", () => {
    useBatchStore.getState().onBatchResult(result("b1", 1));
    useBatchStore.getState().reset();
    expect(useBatchStore.getState().pending).toHaveLength(0);
  });
});
