// NotificationCenter（Task 12，spec §7①）：顶栏铃铛 + 下拉通知中心面板。
// * 铃铛：未读数红点（badge，99+ 封顶）；点击开合面板。
// * 面板：列表（severity 语义配色 / 未读标记 / 点击单条已读）、全部已读、
//   清空、按 kind 静音开关（存 vault settings，管线入口判定，见 core.ts）。
// * 数据面全部在 useNotifyStore（core.ts）；本组件只渲染 + 调 action。
// * 主题/i18n 纪律：severity 走语义令牌（--color-*），文案全走词典键。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Notification } from "../vault/api";
import { useNotifyStore, type NotifyKind } from "./core";

/** 未读数徽标文案封顶（99+ 防 badge 撑爆铃铛）。 */
const BADGE_CAP = 99;

// Phase 3 Task 3（B5）：告警事件独立静音位（规则引擎事件走 kind="alert"）。
const MUTABLE_KINDS: NotifyKind[] = ["transfer", "session", "ai", "alert"];

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BellIcon() {
  // 内联铃铛（不引图标库；与 stroke 色随 currentColor）
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3a6 6 0 0 0-6 6v3.2l-1.6 3A1 1 0 0 0 5.3 16.7h13.4a1 1 0 0 0 .9-1.5L18 12.2V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NotificationRow({ item }: { item: Notification }) {
  const { t } = useTranslation();
  const markRead = useNotifyStore((s) => s.markRead);
  return (
    <li>
      <button
        className={`notify-item${item.read ? "" : " unread"}`}
        data-testid={`notify-item-${item.id}`}
        data-severity={item.severity}
        data-read={item.read}
        onClick={() => {
          if (!item.read) void markRead(item.id);
        }}
      >
        <span className="notify-sev" aria-hidden="true" />
        <span className="notify-item-main">
          <span className="notify-item-title">{t(item.title_key)}</span>
          {item.body && <span className="notify-item-body">{item.body}</span>}
        </span>
        <time className="notify-item-time">{formatTime(item.ts)}</time>
      </button>
    </li>
  );
}

export function NotificationCenter() {
  const { t } = useTranslation();
  const items = useNotifyStore((s) => s.items);
  const unread = useNotifyStore((s) => s.unread);
  const muted = useNotifyStore((s) => s.muted);
  const refresh = useNotifyStore((s) => s.refresh);
  const markAllRead = useNotifyStore((s) => s.markAllRead);
  const clear = useNotifyStore((s) => s.clear);
  const toggleMuted = useNotifyStore((s) => s.toggleMuted);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 开着时点面板外收起（document 级 mousedown；面板/铃铛内部不收）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const badge = unread > BADGE_CAP ? `${BADGE_CAP}+` : String(unread);

  return (
    <div className="notify-root" ref={rootRef}>
      <button
        className="topbar-debug notify-bell"
        data-testid="notify-bell"
        aria-label={t("notify.bellAria") + (unread > 0 ? ` (${t("notify.unreadBadge", { count: unread })})` : "")}
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refresh(); // 打开即对齐真源（多窗口/落库失败兜底）
        }}
      >
        <BellIcon />
        {unread > 0 && (
          <span className="notify-badge" data-testid="notify-badge">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="notify-panel" data-testid="notify-panel">
          <div className="notify-panel-head">
            <div className="notify-actions">
              <button
                type="button"
                data-testid="notify-mark-all"
                disabled={unread === 0}
                onClick={() => void markAllRead()}
              >
                {t("notify.markAllRead")}
              </button>
              <button
                type="button"
                data-testid="notify-clear"
                disabled={items.length === 0}
                onClick={() => void clear()}
              >
                {t("notify.clear")}
              </button>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="notify-empty" data-testid="notify-empty">
              {t("notify.empty")}
            </p>
          ) : (
            <ul className="notify-list">
              {items.map((item) => (
                <NotificationRow key={item.id} item={item} />
              ))}
            </ul>
          )}

          <div className="notify-mute" data-testid="notify-mute-section">
            <span className="notify-mute-label">{t("notify.muteSection")}</span>
            {MUTABLE_KINDS.map((kind) => (
              <label key={kind} className="notify-mute-row">
                <input
                  type="checkbox"
                  data-testid={`notify-mute-${kind}`}
                  checked={muted.includes(kind)}
                  onChange={() => toggleMuted(kind)}
                />
                <span>{t(`notify.kind${kind[0].toUpperCase()}${kind.slice(1)}`)}</span>
              </label>
            ))}
            <p className="notify-mute-hint">{t("notify.muteHint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
