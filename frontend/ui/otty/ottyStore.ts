// Otty 情感时刻调度（2026-10-16 视觉重设计 M3「疏渠」，报告 §5 提案 3）：
// 四个标志性时刻——连接成功（探头划水）/ 传输完成（星光滑行）/ 解锁成功
// （草叶飘落）/ 更新就绪（冲浪板滑过）。铁律：
//   * 同一时刻最多一个 Otty 在场（报告红线：频率克制）——后来者排队 FIFO，
//     队列上限 3（爆量场景丢弃，防连跑批量时刷屏）；
//   * 默认开、可一键关（报告红线②）：真源 vault settings `ui.ottyMoments`，
//     本 store 持镜像标志；关闭即 play 直接丢弃（队列保留纯工具界面）；
//   * 弱动效偏好（prefers-reduced-motion）下 play 直接跳过——情感动画是
//     纯装饰，非理解性反馈。
import { create } from "zustand";

export type OttyMoment = "connect" | "transfer" | "unlock" | "update";

/** 单个时刻的在场时长（ms）。与 31-otty.css 的 --dur-otty-moment token 同值
 * （2.4s，报告口径「探头划水 2.4s」）；JS 侧负责到点卸载，改值两处同步。 */
export const OTTY_MOMENT_MS = 2400;
/** 队列上限：超出即丢（批量执行连发完成事件时不刷屏）。 */
const QUEUE_CAP = 3;

const SETTING_KEY = "ui.ottyMoments";

interface OttyState {
  /** 当前在场的时刻；null = 无。 */
  current: OttyMoment | null;
  /** 排队中的时刻（FIFO）。 */
  queue: OttyMoment[];
  /** 功能开关镜像（真源 vault settings；默认开）。 */
  enabled: boolean;
  /** 触发一个时刻（关/弱动效/队列爆量时静默丢弃）。 */
  play: (m: OttyMoment) => void;
  /** 当前时刻播完（OttyMoments 定时器调用）；自动出队下一个。 */
  finish: () => void;
  /** 设置页开关 / vault 启动同步共用。 */
  setEnabled: (v: boolean) => void;
}

/** 弱动效偏好即时判定（play 时点检查，不缓存——用户中途改系统设置也生效）。 */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export const useOttyStore = create<OttyState>()((set, get) => ({
  current: null,
  queue: [],
  enabled: true,
  play: (m) => {
    if (!get().enabled || prefersReducedMotion()) return;
    const { current, queue } = get();
    if (current !== null) {
      if (queue.length >= QUEUE_CAP) return;
      set({ queue: [...queue, m] });
      return;
    }
    set({ current: m });
  },
  finish: () => {
    const [next, ...rest] = get().queue;
    set({ current: next ?? null, queue: rest });
  },
  setEnabled: (v) => set({ enabled: v }),
}));

/** vault 真源 → store 镜像（App 就绪链调用一次；失败保持默认开）。 */
export async function syncOttyFromVault(): Promise<void> {
  try {
    const { vaultApi } = await import("../../vault/api");
    const v = await vaultApi.settings.get<boolean>(SETTING_KEY);
    // 键不存在（undefined/null）= 从未配置 → 保持默认开
    if (typeof v === "boolean") useOttyStore.getState().setEnabled(v);
  } catch {
    // 非 Tauri 环境（纯浏览器 dev / vitest）：保持默认
  }
}

/** 设置页开关写入：store 镜像即时生效 + vault 真源落库（失败不回滚镜像——
 * 会话内体验优先，重启后以 vault 为准，与 ui.theme 同口径）。 */
export function setOttyEnabled(v: boolean): void {
  useOttyStore.getState().setEnabled(v);
  void import("../../vault/api")
    .then(({ vaultApi }) => vaultApi.settings.set(SETTING_KEY, v))
    .catch(() => {
      // 非 Tauri 环境：镜像已是会话内持久化面
    });
}
