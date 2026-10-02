// cronStore（Phase 4 Task 1）：任务表 + 最近运行事件（面板与通知共用的数据态）。
// 事件是活性面（ottr://cron-run 直灌）；任务表在面板打开时拉取（cj_list）。
import { create } from "zustand";
import { cronApi, type CronJob, type CronRunEvent } from "./api";

interface CronStore {
  jobs: CronJob[];
  /** cron_id → 最近一条运行事件（列表徽标活性；面板关闭时也在累积）。 */
  live: Record<number, CronRunEvent>;
  error: string | null;
  /** 任务表刷新（面板打开时；失败留 error 由面板展示）。 */
  refresh: () => Promise<void>;
  /** ottr://cron-run 直灌（events.ts）。 */
  onRunEvent: (event: CronRunEvent) => void;
}

export const useCronStore = create<CronStore>((set) => ({
  jobs: [],
  live: {},
  error: null,

  refresh: async () => {
    try {
      const jobs = await cronApi.list();
      set({ jobs, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  onRunEvent: (event) =>
    set((st) => ({ live: { ...st.live, [event.cron_id]: event } })),
}));
