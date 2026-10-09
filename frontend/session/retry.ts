// 重连策略与本地设置（自 SessionStore.ts 拆出）：指数退避纯函数 + localStorage
// 设置/会话恢复的持久化面。公共 API 经 SessionStore.ts 的 export * 保持原路径。
import type { Session } from "./types";

export interface SessionSettings {
  /** 自动重连上限（简报默认 5）。 */
  maxReconnectAttempts: number;
}

// --- 常量与纯函数（可测面） --------------------------------------------------

/** 重连退避基数/封顶（简报：1/2/4/8/16/30s 封顶）。 */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

/** 第 attempt 次（1 起）重连前的等待：2^(n-1) 秒，30s 封顶。 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);
}

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/** settings 迁移点（Task 8 settings 表落地后改走 vault；注释钉住） */
const SETTINGS_KEY = "ottr.settings.session";
/** 会话恢复迁移点（同上）：open_host_ids 暂存 localStorage。 */
export const OPEN_TABS_KEY = "ottr.session.openHostIds";

export function loadSettings(): SessionSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionSettings>;
      if (typeof parsed.maxReconnectAttempts === "number" && parsed.maxReconnectAttempts >= 0) {
        return { maxReconnectAttempts: parsed.maxReconnectAttempts };
      }
    }
  } catch {
    // 损坏/不可用 → 默认值
  }
  return { maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS };
}

export function loadOpenTabIds(): number[] {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number");
  } catch {
    return [];
  }
}

export function persistOpenTabs(sessions: Session[]): void {
  // 只持久化标签根（paneOf=null）：分屏 pane 属于标签内部布局，恢复时由用户重开
  try {
    localStorage.setItem(
      OPEN_TABS_KEY,
      JSON.stringify(sessions.filter((s) => s.paneOf === null).map((s) => s.hostId)),
    );
  } catch {
    // 持久化失败不阻塞会话管理
  }
}
