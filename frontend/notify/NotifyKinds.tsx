// 通知类型开关（2026-10-17 用户需求：自通知中心迁设置 → 告警分区）——
// 哪些事件类别允许产生通知。配置归设置、视图管消费（IA 一贯原则）：
// 通知中心只留列表与已读/清空，类型开关住在告警分区（与告警规则/通知通道
// 同页：什么事件、走什么通道、何时静音，一处说清）。
// 状态 = useNotifyStore.muted（vault settings notify.muted_kinds），管线入口
// 消费；本组件只渲染开关面，无本地状态。
import { useTranslation } from "react-i18next";
import { Checkbox } from "../ui/Checkbox";
import { InfoHint } from "../ui/InfoHint";
import { useNotifyStore, type NotifyKind } from "./core";

/** 可静音的事件类别（原 NotificationCenter 口径原样迁入）。 */
const MUTABLE_KINDS: NotifyKind[] = ["transfer", "session", "ai", "alert", "security", "cron"];

export function NotifyKindsSection() {
  const { t } = useTranslation();
  const muted = useNotifyStore((s) => s.muted);
  const toggleMuted = useNotifyStore((s) => s.toggleMuted);
  return (
    <section aria-label={t("notify.muteSection")} data-testid="notify-kinds-section">
      <div className="settings-head">
        <h3>{t("notify.muteSection")}</h3>
        <InfoHint text={t("notify.muteHint")} />
      </div>
      <div className="notify-kinds-grid">
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
      </div>
    </section>
  );
}
