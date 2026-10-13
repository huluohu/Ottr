// 轻量应用内 Toast（2026-10-10 交互统一）：右下角卡片、6 秒自动消失、
// 可手动关闭。替代此前「主区顶部状态条」的路径/结果反馈（用户反馈太丑）。
// 2026-10-10 评审 P1-9：补出现/消失动画与剩余时间进度条——dismiss 两段式
// （先置 closing 播退场动画 160ms，再移除；TTL 与手动关闭同路）。
// 2026-10-13：补可选操作按钮（action）与逐条 TTL——「发现新版本」toast
// 内直接「下载并安装」（用户裁定：跳设置页下载太扯），操作型 toast 默认
// 15s（6s 对带按钮的决策窗口太短）。
import { create } from "zustand";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
  /** 退场中（播完移除；此态不再响应重复 dismiss）。 */
  closing?: boolean;
  /** 可选主操作按钮（点击 = run + 收起本条）。 */
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastItem[];
  /** 返回 toast id（调用方可据此提前 dismiss——如「正在检查」在结果到达时收走）。 */
  show: (
    message: string,
    kind?: "info" | "error",
    action?: ToastAction,
    ttlMs?: number,
  ) => number;
  dismiss: (id: number) => void;
  /** 就地更新文案（下载进度等长驻 toast 的原地改写，不重弹）。 */
  update: (id: number, patch: { message?: string }) => void;
}

let nextToastId = 1;
/** 与 tokens.css --toast-ttl 同源（进度条动画时长必须一致）。 */
const TOAST_TTL_MS = 6000;
/** 退场动画窗（29-toast.css toast-out --dur-fast + 帧余量）；测试环境直通
 * （既有「TTL 后清除」断言是同步移除语义，动画窗属视觉层）。 */
const TOAST_EXIT_MS = import.meta.env?.MODE === "test" ? 0 : 160;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (message, kind = "info", action, ttlMs) => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind, action }] }));
    setTimeout(() => {
      useToastStore.getState().dismiss(id);
    }, ttlMs ?? TOAST_TTL_MS);
    return id;
  },
  update: (id, patch) => {
    set((s) => ({
      toasts: s.toasts.map((t) =>
        t.id === id ? { ...t, message: patch.message ?? t.message } : t,
      ),
    }));
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
export function showToast(
  message: string,
  kind: "info" | "error" = "info",
  action?: ToastAction,
  ttlMs?: number,
): number {
  return useToastStore.getState().show(message, kind, action, ttlMs);
}

/** 就地更新 toast 文案（导出便捷入口，语义同 showToast）。 */
export function updateToast(id: number, message: string): void {
  useToastStore.getState().update(id, { message });
}

export { TOAST_TTL_MS, TOAST_EXIT_MS };
