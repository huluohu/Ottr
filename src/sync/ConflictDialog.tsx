// ConflictDialog（Phase 5 Task 4）：双改冲突的逐分类裁定面板。
//
// 消费 T3 冲突列表（CategoryConflict：分类粒度，粒度裁定论证见
// task-3-report §4——全量替换语义下分类是可控最细人工处理粒度）+ 双侧
// 快照（SyncDialog 开封后传入），产出逐分类裁定映射 { category: "local" |
// "cloud" }，合并动作（先应用云端侧、再推送合并结果）在 SyncDialog。
//
// **红线（计划宪法，组件测试钉死）**：任何「保留云端」裁定在应用前必须
// 明示将被覆盖的本机值——选中「保留云端」的瞬间，该分类出现本机数据清单
// （overwrite-disclosure），与应用按钮互不依赖（先预告、后应用）；未选中
// 时不渲染。对照面（本机/云端双侧摘要）恒显，覆盖预告是对本机侧的二次强调。
//
// 摘要面 = T3 canonicalEntries 自然键投影的人类可读化（id 无关，跨机同形）；
// 超过 8 条截断计数（完整数据仍在快照里，裁定粒度是分类不是条目）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canonicalEntries,
  type CategoryConflict,
  type SyncCategory,
  type SyncData,
} from "./engine";

/** 逐分类摘要（canonical 投影 → 单行文本；解析失败回落投影原文截断）。 */
export function entrySummaries(cat: SyncCategory, data: SyncData): string[] {
  return canonicalEntries(cat, data).map((canonical) => {
    try {
      const o = JSON.parse(canonical) as Record<string, unknown>;
      const host = (v: unknown): string => {
        const h = JSON.parse(String(v)) as { name?: unknown; address?: unknown; port?: unknown };
        return `${String(h.name)} (${String(h.address)}:${String(h.port)})`;
      };
      switch (cat) {
        case "host_groups":
          return String(o.name ?? canonical);
        case "hosts":
          return `${String(o.name)} (${String(o.address)}:${String(o.port)})`;
        case "credentials": {
          // 覆盖预告可辨识度（fix round 1 Minor-1）：kind + key_pub 前缀指纹
          // （公钥材料可印）或 updated_at 兜底——secret/passphrase/totp_secret
          // 永不出现在摘要面（红线不变）。
          const kind = String(o.kind ?? "?");
          const pubKey = typeof o.key_pub === "string" && o.key_pub !== "" ? o.key_pub.slice(0, 12) : null;
          const when = typeof o.updated_at === "number" ? new Date(o.updated_at * 1000).toISOString().slice(0, 10) : null;
          const tag = pubKey ?? when;
          return tag === null ? kind : `${kind} · ${tag}`;
        }
        case "snippets":
          return String(o.name ?? canonical);
        case "notify_channels":
          return String(o.kind ?? canonical);
        case "alert_rules":
          return `${String(o.kind)} → ${host(o.host)}`;
        case "cron_jobs":
          return `${String(o.schedule)} → ${host(o.host)}`;
        case "settings":
          return String(o.key ?? canonical);
      }
    } catch {
      return canonical.slice(0, 48);
    }
  });
}

const SUMMARY_CAP = 8;

/** 条目清单（截断 + 计数；冲突对照与拉取覆盖预告共用——SyncDialog 复用）。 */
export function EntryList({ testid, summaries, t }: { testid: string; summaries: string[]; t: (k: string, v?: Record<string, unknown>) => string }) {
  if (summaries.length === 0) {
    return (
      <p className="settings-hint" data-testid={testid}>
        {t("sync.dialog.entriesEmpty")}
      </p>
    );
  }
  const shown = summaries.slice(0, SUMMARY_CAP);
  const rest = summaries.length - shown.length;
  return (
    <ul className="sync-entries" data-testid={testid}>
      {shown.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
      {rest > 0 && <li>{t("sync.dialog.entriesMore", { count: rest })}</li>}
    </ul>
  );
}

export interface ConflictDialogProps {
  conflicts: CategoryConflict[];
  localData: SyncData;
  remoteData: SyncData;
  busy: boolean;
  /** 裁定映射（仅含已裁定的冲突分类）；调用方 = SyncDialog 合并执行。 */
  onApply: (resolution: Partial<Record<SyncCategory, "local" | "cloud">>) => void;
  onCancel?: () => void;
}

export function ConflictDialog({ conflicts, localData, remoteData, busy, onApply, onCancel }: ConflictDialogProps) {
  const { t } = useTranslation();
  const [resolution, setResolution] = useState<Partial<Record<SyncCategory, "local" | "cloud">>>({});

  const set = (cat: SyncCategory, side: "local" | "cloud") =>
    setResolution((r) => ({ ...r, [cat]: side }));
  const setAll = (side: "local" | "cloud") => {
    const all: Partial<Record<SyncCategory, "local" | "cloud">> = {};
    for (const c of conflicts) all[c.category] = side;
    setResolution(all);
  };
  const allDecided = conflicts.every((c) => resolution[c.category] !== undefined);

  return (
    <div data-testid="conflict-dialog" aria-busy={busy}>
      <p className="dialog-intro" data-testid="conflict-desc">
        {t("sync.dialog.conflictDesc")}
      </p>
      <div className="form-actions">
        <button type="button" data-testid="conflict-all-local" disabled={busy} onClick={() => setAll("local")}>
          {t("sync.dialog.selectAllLocal")}
        </button>
        <button type="button" data-testid="conflict-all-cloud" disabled={busy} onClick={() => setAll("cloud")}>
          {t("sync.dialog.selectAllCloud")}
        </button>
      </div>

      {conflicts.map((c) => {
        const cat = c.category;
        const localSummaries = entrySummaries(cat, localData);
        const cloudSummaries = entrySummaries(cat, remoteData);
        const chosen = resolution[cat];
        return (
          <fieldset key={cat} className="sync-conflict-row" data-testid={`conflict-row-${cat}`} disabled={busy}>
            <legend>{t(`sync.category.${cat}`)}</legend>
            <p className="settings-hint">
              {t("sync.dialog.localSide")} {c.local_count} · {t("sync.dialog.cloudSide")} {c.remote_count}
            </p>
            <div className="sync-conflict-sides">
              <div>
                <h4>{t("sync.dialog.localSide")}</h4>
                <EntryList testid={`local-entries-${cat}`} summaries={localSummaries} t={t} />
              </div>
              <div>
                <h4>{t("sync.dialog.cloudSide")}</h4>
                <EntryList testid={`cloud-entries-${cat}`} summaries={cloudSummaries} t={t} />
              </div>
            </div>
            <div className="settings-row" role="radiogroup" aria-label={t(`sync.category.${cat}`)}>
              <label>
                <input
                  type="radio"
                  name={`conflict-${cat}`}
                  data-testid={`keep-local-${cat}`}
                  disabled={busy}
                  checked={chosen === "local"}
                  onChange={() => set(cat, "local")}
                />
                {t("sync.dialog.keepLocal")}
              </label>
              <label>
                <input
                  type="radio"
                  name={`conflict-${cat}`}
                  data-testid={`keep-cloud-${cat}`}
                  disabled={busy}
                  checked={chosen === "cloud"}
                  onChange={() => set(cat, "cloud")}
                />
                {t("sync.dialog.keepCloud")}
              </label>
            </div>
            {chosen === "cloud" && (
              <div className="sync-overwrite-disclosure" data-testid={`overwrite-disclosure-${cat}`}>
                <p className="form-error">{t("sync.dialog.willOverwrite", { count: c.local_count })}</p>
                <EntryList testid={`overwrite-entries-${cat}`} summaries={localSummaries} t={t} />
              </div>
            )}
          </fieldset>
        );
      })}

      <div className="form-actions">
        {onCancel && (
          <button type="button" data-testid="conflict-cancel" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
        <button
          type="button"
          className="btn-accent"
          data-testid="conflict-apply"
          disabled={busy || !allDecided}
          onClick={() => onApply(resolution)}
        >
          {t("sync.dialog.apply")}
        </button>
      </div>
    </div>
  );
}
