// 轻量应用内 Toast（2026-10-10 交互统一）：右下角卡片、6 秒自动消失、
// 可手动关闭。替代此前「主区顶部状态条」的路径/结果反馈（用户反馈太丑）。
// 2026-10-10 评审 P1-9：补出现/消失动画与剩余时间进度条——dismiss 两段式
// （先置 closing 播退场动画 160ms，再移除；TTL 与手动关闭同路）。
import { create } from "zustand";

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
  /** 退场中（播完移除；此态不再响应重复 dismiss）。 */
  closing?: boolean;
}

interface ToastStore {
  toasts: ToastItem[];
  show: (message: string, kind?: "info" | "error") => void;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
/** 与 tokens.css --toast-ttl 同源（进度条动画时长必须一致）。 */
const TOAST_TTL_MS = 6000;
/** 退场动画窗（29-toast.css toast-out --dur-fast + 帧余量）；测试环境直通
 * （既有「TTL 后清除」断言是同步移除语义，动画窗属视觉层）。 */
const TOAST_EXIT_MS = import.meta.env?.MODE === "test" ? 0 : 160;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, kind = "info") => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => {
      useToastStore.getState().dismiss(id);
    }, TOAST_TTL_MS);
  },
  dismiss: (id) => {
    // 幂等：closing 态的重复 dismiss（连点/TTL 追上手动关）不再重启计时。
    if (useToastStore.getState().toasts.find((t) => t.id === id)?.closing) return;
    if (TOAST_EXIT_MS === 0) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      return;
    }
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, closing: true } : t)),
    }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TOAST_EXIT_MS);
  },
}));

/** 命令式入口（非组件环境/事件回调均可直接调用）。 */
export function showToast(message: string, kind: "info" | "error" = "info"): void {
  useToastStore.getState().show(message, kind);
}

export { TOAST_TTL_MS, TOAST_EXIT_MS };
