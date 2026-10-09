// 轻量应用内 Toast（2026-10-10 交互统一）：右下角卡片、6 秒自动消失、
// 可手动关闭。替代此前「主区顶部状态条」的路径/结果反馈（用户反馈太丑）。
import { create } from "zustand";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
}

interface ToastStore {
  toasts: ToastItem[];
  show: (message: string, kind?: "info" | "error") => void;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
const TOAST_TTL_MS = 6000;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, kind = "info") => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TOAST_TTL_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 命令式入口（非组件环境/事件回调均可直接调用）。 */
export function showToast(message: string, kind: "info" | "error" = "info"): void {
  useToastStore.getState().show(message, kind);
}
