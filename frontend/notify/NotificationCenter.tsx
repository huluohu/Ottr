// NotificationCenter（Task 12，spec §7①；2026-10-09 四面板统一批次）：通知
// 中心面板。原为右上受控浮层（点外/Esc 收起）——按「四面板统一为 dock 面板」
// 裁定改造为 dock 页签面板（DockPanel 挂载，标题由 dock 壳供给），入口 =
// 侧栏导航行（带未读徽标）+ 原生菜单（未读数经 menu_set_notify_count 进文案）。
// * 面板：列表（severity 语义配色 / 未读标记 / 点击单条已读）、全部已读、
//   清空、按 kind 静音开关（存 vault settings，管线入口判定，见 core.ts）。
//   【Phase 5 T1（BL-517）】投递失败块：条目 payload.delivery_failed（由重试
//   装饰器终败回执写入）→ 状态标签 + 渠道名 + 错误摘要 + 手动重发按钮
//   （channelRegistry.resendNotification 重跑该渠道 send）。
// * 空态引导（ui-batch2 T3，审计 A4）：「暂无通知」文案保留，补「查看告警
//   规则」入口——既有 openDock("alerts") 动作（workspaceStore 单槽 dock），
//   点击后通知面板收起（导航即收，防与右侧 dock 视觉叠压）。空态判定不变
//   （items.length === 0 分支），非空列表不渲染引导块。
// * 数据面全部在 useNotifyStore（core.ts）；本组件只渲染 + 调 action。
// * 主题/i18n 纪律：severity 走语义令牌（--color-*），文案全走词典键。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { Notification } from "../vault/api";
import i18n from "../i18n";
import { readDeliveryFailures, useNotifyStore, type DeliveryFailure, type NotifyKind } from "./core";
import { resendNotification } from "./channelRegistry";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { Checkbox } from "../ui/Checkbox";

// Phase 3 Task 3（B5）：告警事件独立静音位（规则引擎事件走 kind="alert"）。
// Phase 3 Task 6（B9）：指纹巡检 changed 告警独立静音位（kind="security"）。
const MUTABLE_KINDS: NotifyKind[] = ["transfer", "session", "ai", "alert", "security", "cron"];

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 投递失败块（单渠道一行）：状态标签 + 渠道名（alert.kind 词典，剥 `#id`）
 * + 错误摘要（截断、title 悬停全文）+ 手动重发按钮（在途禁用）。 */
function DeliveryFailedRow({ item, failure }: { item: Notification; failure: DeliveryFailure }) {
  const { t } = useTranslation();
  const [resending, setResending] = useState(false);
  const kind = failure.channel.split("#")[0] ?? failure.channel;
  const kindLabel = i18n.exists(`alert.kind.${kind}`)
    ? t(`alert.kind.${kind}`, { defaultValue: kind })
    : kind;
  return (
    <div className="notify-dlv-row">
      <span className="notify-dlv-status">{t("notify.deliveryFailed")}</span>
      <span className="notify-dlv-channel">{kindLabel}</span>
      <span className="notify-dlv-error" title={failure.error}>
        {failure.error}
      </span>
      <button
        type="button"
        className="notify-dlv-resend"
        data-testid={`notify-resend-${item.id}`}
        data-channel={failure.channel}
        disabled={resending}
        onClick={() => {
          setResending(true);
          // 重发 = 对该事件重跑该渠道 send（channelRegistry）；翻正清账由装饰器
          // onDelivered 缺省回执完成——这里只触发 + 管按钮在途态。
          void resendNotification(item, failure).finally(() => setResending(false));
        }}
      >
        {resending ? t("notify.resending") : t("notify.resend")}
      </button>
    </div>
  );
}

function NotificationRow({ item }: { item: Notification }) {
  const { t } = useTranslation();
  const markRead = useNotifyStore((s) => s.markRead);
  const failures = readDeliveryFailures(item.payload);
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
      {failures.length > 0 && (
        <div className="notify-dlv" data-testid={`notify-dlv-${item.id}`}>
          {failures.map((f) => (
            <DeliveryFailedRow key={f.channel} item={item} failure={f} />
          ))}
        </div>
      )}
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
  // 空态引导入口（ui2 T3，A4）：告警规则面板走既有 dock 单槽动作。
  const openDock = useWorkspaceStore((s) => s.openDock);

  // 挂载即对齐真源（多窗口/落库失败兜底）；未读数 → 原生菜单文案跟随。
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    invoke("menu_set_notify_count", { unread }).catch(() => {});
  }, [unread]);

  return (
    <>
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
            <div className="notify-empty-guide" data-testid="notify-empty-guide">
              <p className="notify-empty" data-testid="notify-empty">
                {t("notify.empty")}
              </p>
              <p className="notify-empty-hint">{t("notify.emptyHint")}</p>
              <button
                type="button"
                data-testid="notify-empty-alerts"
                onClick={() => openDock("alerts")}
              >
                {t("notify.emptyAlertsCta")}
              </button>
            </div>
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
                <Checkbox
                  testid={`notify-mute-${kind}`}
                  checked={muted.includes(kind)}
                  onChange={() => toggleMuted(kind)}
                />
                <span>{t(`notify.kind${kind[0].toUpperCase()}${kind.slice(1)}`)}</span>
              </label>
            ))}
            <p className="notify-mute-hint">{t("notify.muteHint")}</p>
          </div>
        </div>
    </>
  );
}
