// 批量执行 store（Phase 3 Task 4，B6）：批次状态 + 逐主机结果归拢。
// monitorStore 同款纯数据机——事件接线在 ./events.ts，组件只读。
// 语义：begin(batchId, total) 开新批（清旧结果，回收乱序先到的结果）；
// onBatchResult 按 batch_id 归拢（过期批次的事件——取消后重发前的尾巴——
// 静默丢弃）。
import { create } from "zustand";
import type { BatchResult } from "./api";

interface BatchState {
  /** 在跑批次 id（null = 空闲）。 */
  batchId: string | null;
  /** 本批目标总数（进度分母）。 */
  total: number;
  /** 已收到的逐主机结果（到达序）。 */
  results: BatchResult[];
  /**
   * 结果事件先于 exec 回执落地的暂存（2026-11-08 审计 C1）：Rust 侧 spawn
   * 池任务在 `Ok(batch_id)` 返回之前（batch.rs），「未连接主机」这类目标
   * 同步失败时首个结果事件可抢在回执前 emit——此前直接被丢弃，results
   * 永远到不了 total，进度条永久卡「执行中」。同款乱序 TransferStore 已有
   * 先例（begin 占位合并）。begin 时回收同 id 事件，其余（旧批尾巴）丢弃。
   */
  pending: BatchResult[];
  begin: (batchId: string, total: number) => void;
  onBatchResult: (result: BatchResult) => void;
  /** 终态推进：Rust 无「批次完成」事件，前端按 results.length >= total 收敛。 */
  finished: () => boolean;
  reset: () => void;
}

export const useBatchStore = create<BatchState>((set, get) => ({
  batchId: null,
  total: 0,
  results: [],
  pending: [],
  begin: (batchId, total) =>
    set((s) => {
      const absorbed = s.pending.filter((r) => r.batch_id === batchId);
      return { batchId, total, results: absorbed, pending: [] };
    }),
  onBatchResult: (result) =>
    set((s) => {
      if (s.batchId === result.batch_id) return { results: [...s.results, result] };
      // 尚无回执（空闲态）→ 暂存待 begin 回收；已有别的批次在跑（旧批尾巴）
      // → 静默丢弃。
      return s.batchId === null ? { pending: [...s.pending, result] } : s;
    }),
  finished: () => {
    const s = get();
    return s.batchId !== null && s.results.length >= s.total;
  },
  reset: () => set({ batchId: null, total: 0, results: [], pending: [] }),
}));
