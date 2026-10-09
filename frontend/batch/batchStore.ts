// 批量执行 store（Phase 3 Task 4，B6）：批次状态 + 逐主机结果归拢。
// monitorStore 同款纯数据机——事件接线在 ./events.ts，组件只读。
// 语义：begin(batchId, total) 开新批（清旧结果）；onBatchResult 按 batch_id
// 归拢（过期批次的事件——取消后重发前的尾巴——静默丢弃）。
import { create } from "zustand";
import type { BatchResult } from "./api";

interface BatchState {
  /** 在跑批次 id（null = 空闲）。 */
  batchId: string | null;
  /** 本批目标总数（进度分母）。 */
  total: number;
  /** 已收到的逐主机结果（到达序）。 */
  results: BatchResult[];
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
  begin: (batchId, total) => set({ batchId, total, results: [] }),
  onBatchResult: (result) =>
    set((s) => (s.batchId === result.batch_id ? { results: [...s.results, result] } : s)),
  finished: () => {
    const s = get();
    return s.batchId !== null && s.results.length >= s.total;
  },
  reset: () => set({ batchId: null, total: 0, results: [] }),
}));
