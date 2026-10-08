// 会话编码（Task 9，A9）纯函数与载荷（自 SessionStore.ts 拆出）。
// 公共 API 经 SessionStore.ts 的 export * 保持原路径不变。

// --- 会话编码（Task 9，A9） --------------------------------------------------

/** 会话编码支持集（与 Rust encoding_from_str / ottr-term Decoder 同口径；
 * big5 等其余 T8 菜单候选 Rust 侧无解码器，显式不支持）。 */
export const SESSION_ENCODINGS = ["utf-8", "gbk", "gb18030"] as const;
export type SessionEncoding = (typeof SESSION_ENCODINGS)[number];

/** 编码 id → 展示名（徽标/提示条用；编码名不作 i18n）。 */
export function encodingName(e: SessionEncoding): string {
  return e === "utf-8" ? "UTF-8" : e === "gbk" ? "GBK" : "GB18030";
}

/** host 表 encoding_override 字符串 → 支持集内编码；无法识别 → null（兜底 utf-8）。 */
export function parseSessionEncoding(v: string | null | undefined): SessionEncoding | null {
  return (SESSION_ENCODINGS as readonly string[]).includes(v ?? "")
    ? (v as SessionEncoding)
    : null;
}

/** 编码徽标点击循环序（utf-8 → gbk → gb18030 → utf-8）。 */
export function nextEncoding(e: SessionEncoding): SessionEncoding {
  return SESSION_ENCODINGS[(SESSION_ENCODINGS.indexOf(e) + 1) % SESSION_ENCODINGS.length];
}

const HINT_DISMISSED_KEY = "ottr.encoding.hintDismissed";

/** 已「不再提示」的 hostId 集（localStorage；「一次性可关」= 接受/忽略后同
 * host 不再弹，含换标签/重连）。 */
export function loadDismissedEncodingHosts(): number[] {
  try {
    const raw = localStorage.getItem(HINT_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

export function persistDismissedEncodingHosts(ids: number[]): void {
  try {
    localStorage.setItem(HINT_DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // 持久化失败不阻塞提示条
  }
}

/** `ottr://encoding-hint` 事件载荷（Rust EncodingHintPayload 同构）。 */
export interface EncodingHintPayload {
  /** Rust 会话 id（按 rustId 反查会话）。 */
  id: string;
  /** 固定 "gbk"（Rust 侧仅 detect_hint 命中 GBK 家族才发事件）。 */
  encoding: "gbk";
}
