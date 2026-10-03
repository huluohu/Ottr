// CronPanel（Phase 4 Task 1，缺口①）：cron 定时任务中心（顶栏入口对话框，
// ForwardPanel 同款布局语言）。
// * 任务列表：主机 · schedule · 下次触发（cj_next_fire，打开时解析）·
//   最近运行徽标（cronStore.live 活性）· enabled 开关 / 立即运行 / 编辑 / 删除。
// * 运行历史：行展开（cj_runs 最近 20 条；状态档 + 退出码 + 时长 + 时刻），
//   有 output_path 的行可看输出正文（cj_run_output，Rust 侧目录守卫）。
// * 表单：主机下拉 / schedule 输入（失焦实时「下次运行」预览——非法表达式
//   即时报错，Rust CronExpr 单一事实源）/ 脚本文本域 / 渠道多选（③外部渠道
//   订阅面）/ enabled。编辑走 cj_update 全量替换。
// * 主题/i18n 纪律：语义令牌（--color-*，forward/batch 面板同款 class）、
//   文案全走词典键。
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type Host, type NotifyChannel } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { cronApi, type CronJob, type CronJobInput, type CronRun, type CronRunStatus } from "./api";
import { useCronStore } from "./cronStore";
import { Checkbox } from "../ui/Checkbox";

export interface CronPanelProps {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  hostId: string;
  schedule: string;
  script: string;
  channels: number[];
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  hostId: "",
  schedule: "* * * * *",
  script: "",
  channels: [],
  enabled: true,
};

function formFromRow(row: CronJob): FormState {
  return {
    hostId: String(row.host_id),
    schedule: row.schedule,
    script: row.script,
    channels: [...row.channels],
    enabled: row.enabled,
  };
}

/** 状态 → 色档（data-state；ok=绿 failed/timeout=红 missed=黄）。 */
export function toneOf(status: CronRunStatus): "ok" | "failed" | "warn" {
  if (status === "ok") return "ok";
  if (status === "missed") return "warn";
  return "failed";
}

/** unix 秒 → 本地时刻（历史/下次触发共用；非法值原样返回）。 */
export function formatTime(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export function CronPanel({ open, onClose }: CronPanelProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const jobs = useCronStore((s) => s.jobs);
  const live = useCronStore((s) => s.live);
  const storeError = useCronStore((s) => s.error);
  const refreshJobs = useCronStore((s) => s.refresh);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nextFire, setNextFire] = useState<Record<number, number | null>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [schedulePreview, setSchedulePreview] = useState<string | null>(null);
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const listSeq = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      await refreshJobs();
      if (seq === listSeq.current) setLoadError(null);
    } catch (err) {
      if (seq === listSeq.current) setLoadError(String(err));
    }
  }, [refreshJobs]);

  // 打开即取任务表 + 逐任务解析下次触发（schedule 是静态配置，无需轮询）；
  // 最近运行徽标由 cronStore.live 事件直灌。
  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        useCronStore.getState().jobs.map(async (j) => {
          try {
            return [j.id, await cronApi.nextFire(j.schedule)] as const;
          } catch {
            return [j.id, null] as const;
          }
        }),
      );
      if (!cancelled) setNextFire(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, jobs]);

  // 表单打开时拉渠道清单（③订阅面多选）；失败 = 空清单（面板不阻塞）。
  useEffect(() => {
    if (!open || !formOpen) return;
    void vaultApi.notifyChannels
      .list()
      .then((rows) => setChannels(rows.filter((r) => r.enabled)))
      .catch(() => setChannels([]));
  }, [open, formOpen]);

  // OBS-1（Phase 4 走查批）：面板开着时，展开行的历史随 live 事件自动
  // refetch——新轮次落库不重开面板即可见。lastRunEvent 身份随每条事件变化
  // 即触发重拉；autoRunKeyRef 与 toggleHistory 的手动首拉去重（避免双拉）。
  const lastRunEvent = expanded != null ? live[expanded] : undefined;
  const autoRunKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || expanded == null || lastRunEvent == null) return;
    const key = `${expanded}:${lastRunEvent.run_id}`;
    if (autoRunKeyRef.current === key) return;
    autoRunKeyRef.current = key;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await cronApi.runs(expanded, 20);
        if (!cancelled) setRuns(rows);
      } catch {
        // 静默：事件驱动的自动刷新失败不打扰（手动展开路径的错误走 actionError）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, expanded, lastRunEvent]);

  if (!open) return null;

  /** schedule 预览（输入防抖 300ms → cj_next_fire；非法 = 错误文案）。 */
  function previewSchedule(schedule: string) {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    setSchedulePreview(null);
    previewTimer.current = setTimeout(() => {
      void cronApi
        .nextFire(schedule)
        .then((ts) =>
          setSchedulePreview(ts != null ? t("cron.nextFireAt", { time: formatTime(ts) }) : null),
        )
        .catch(() => setSchedulePreview(t("cron.badSchedule")));
    }, 300);
  }

  async function handleToggle(row: CronJob) {
    setActionError(null);
    const input: CronJobInput = {
      host_id: row.host_id,
      schedule: row.schedule,
      script: row.script,
      channels: row.channels,
      enabled: !row.enabled,
    };
    try {
      await cronApi.update(row.id, input);
      await refresh();
    } catch (err) {
      setActionError(t("cron.actionFailed", { message: String(err) }));
    }
  }

  async function handleTrigger(row: CronJob) {
    setActionError(null);
    setTriggering(row.id);
    try {
      await cronApi.trigger(row.id);
      if (expanded === row.id) await loadRuns(row.id);
    } catch (err) {
      setActionError(t("cron.actionFailed", { message: String(err) }));
    } finally {
      setTriggering(null);
    }
  }

  async function handleDelete(row: CronJob) {
    setActionError(null);
    try {
      await cronApi.remove(row.id);
      if (expanded === row.id) setExpanded(null);
      await refresh();
    } catch (err) {
      setActionError(t("cron.actionFailed", { message: String(err) }));
    }
  }

  async function loadRuns(cronId: number) {
    try {
      setRuns(await cronApi.runs(cronId, 20));
    } catch (err) {
      setActionError(t("cron.actionFailed", { message: String(err) }));
    }
  }

  async function toggleHistory(row: CronJob) {
    if (expanded === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded(row.id);
    setRuns([]);
    // 记下手动的首拉水位：live 里已有该行事件时，事件驱动的自动 refetch
    // 不再重复拉（见上方 effect 的 autoRunKeyRef）。
    const lastEvent = live[row.id];
    autoRunKeyRef.current = lastEvent != null ? `${row.id}:${lastEvent.run_id}` : null;
    await loadRuns(row.id);
  }

  function openCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, hostId: hosts[0] != null ? String(hosts[0].id) : "" });
    setFormError(null);
    setSchedulePreview(null);
    setFormOpen(true);
  }

  function openEdit(row: CronJob) {
    setEditingId(row.id);
    setForm(formFromRow(row));
    setFormError(null);
    setSchedulePreview(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setFormError(null);
  }

  function validateForm(): string | null {
    if (form.hostId === "") return t("cron.errHostRequired");
    if (form.schedule.trim() === "") return t("cron.errScheduleRequired");
    if (form.script.trim() === "") return t("cron.errScriptRequired");
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validateForm();
    if (err != null) {
      setFormError(err);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const input: CronJobInput = {
      host_id: Number(form.hostId),
      schedule: form.schedule.trim(),
      script: form.script,
      channels: form.channels,
      enabled: form.enabled,
    };
    try {
      if (editingId != null) {
        await cronApi.update(editingId, input);
      } else {
        await cronApi.create(input);
      }
      closeForm();
      await refresh();
    } catch (submitErr) {
      setFormError(t("cron.saveFailed", { message: String(submitErr) }));
    } finally {
      setSubmitting(false);
    }
  }

  const hostById = new Map<number, Host>(hosts.map((h) => [h.id, h]));

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("cron.title")}>
      <div className="dialog forward-panel" data-testid="cron-panel">
        <div className="dialog-head">
          <h2>{t("cron.title")}</h2>
          <button className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>

        {(loadError ?? storeError) && (
          <p className="form-error" data-testid="cron-load-error">
            {t("cron.loadFailed", { message: loadError ?? storeError ?? "" })}
          </p>
        )}
        {actionError && (
          <p className="form-error" data-testid="cron-action-error">
            {actionError}
          </p>
        )}

        {jobs.length === 0 && !loadError && !storeError && (
          <p className="forward-empty" data-testid="cron-empty">
            {t("cron.empty")}
          </p>
        )}

        <ul className="forward-list" data-testid="cron-list">
          {jobs.map((row) => {
            const last = live[row.id];
            const hostName = hostById.get(row.host_id)?.name ?? `#${row.host_id}`;
            return (
              <li key={row.id} className="forward-row cron-row" data-testid={`cron-row-${row.id}`}>
                <span
                  className="forward-light"
                  data-state={last ? (last.status === "ok" ? "active" : "error") : "off"}
                  aria-hidden="true"
                />
                <span className="forward-main">
                  <span className="forward-endpoint">
                    {hostName}
                    <span className="forward-arrow" aria-hidden="true">
                      {" · "}
                    </span>
                    <code>{row.schedule}</code>
                  </span>
                  <span className="forward-meta">
                    <span data-testid={`cron-next-${row.id}`}>
                      {t("cron.nextFire")}
                      {formatTime(nextFire[row.id] ?? null)}
                    </span>
                    {last != null && (
                      <>
                        {" · "}
                        {/* OBS-1：徽标带最新轮时刻——ok 轮逐轮刷新可观察，
                            不再是恒等不动的「成功 (0)」。 */}
                        <span data-testid={`cron-last-${row.id}`} data-tone={toneOf(last.status)}>
                          {t(`cron.status.${last.status}`)}
                          {last.exit_code != null ? ` (${last.exit_code})` : ""}
                          {` · ${formatTime(last.ts)}`}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <span className="forward-actions">
                  <label className="forward-flag" title={t("cron.enabledHint")}>
                    <Checkbox
                      testid={`cron-enabled-${row.id}`}
                      checked={row.enabled}
                      onChange={() => void handleToggle(row)}
                    />
                    {t("cron.enabled")}
                  </label>
                  <button
                    data-testid={`cron-run-${row.id}`}
                    disabled={triggering === row.id}
                    onClick={() => void handleTrigger(row)}
                  >
                    {triggering === row.id ? t("cron.running") : t("cron.runNow")}
                  </button>
                  <button data-testid={`cron-history-${row.id}`} onClick={() => void toggleHistory(row)}>
                    {t("cron.history")}
                  </button>
                  <button data-testid={`cron-edit-${row.id}`} onClick={() => openEdit(row)}>
                    {t("common.edit")}
                  </button>
                  <button data-testid={`cron-delete-${row.id}`} onClick={() => void handleDelete(row)}>
                    {t("common.delete")}
                  </button>
                </span>
                {expanded === row.id && (
                  <ul className="cron-runs" data-testid={`cron-runs-${row.id}`}>
                    {runs.length === 0 && <li className="forward-meta">{t("cron.noRuns")}</li>}
                    {runs.map((r) => (
                      <li key={r.id} className="forward-meta" data-tone={toneOf(r.status)}>
                        <span data-testid={`cron-run-row-${r.id}`}>
                          {t(`cron.status.${r.status}`)}
                          {r.exit_code != null ? ` · exit ${r.exit_code}` : ""} · {r.duration_ms}
                          ms · {formatTime(r.ts)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {formOpen ? (
          <form className="forward-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
            <h3>{editingId != null ? t("cron.editTitle") : t("cron.addTitle")}</h3>
            <div className="form-row">
              <label className="grow">
                <span>{t("cron.host")}</span>
                <select
                  data-testid="cron-form-host"
                  value={form.hostId}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setForm((f) => ({ ...f, hostId: v }));
                  }}
                >
                  {hosts.length === 0 && <option value="">—</option>}
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                <span>{t("cron.schedule")}</span>
                <input
                  data-testid="cron-form-schedule"
                  value={form.schedule}
                  placeholder="*/5 * * * *"
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setForm((f) => ({ ...f, schedule: v }));
                    previewSchedule(v);
                  }}
                />
              </label>
            </div>
            {schedulePreview != null && (
              <p className="forward-meta" data-testid="cron-form-preview">
                {schedulePreview}
              </p>
            )}
            <label className="grow">
              <span>{t("cron.script")}</span>
              <textarea
                data-testid="cron-form-script"
                rows={4}
                value={form.script}
                placeholder={t("cron.scriptPlaceholder")}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setForm((f) => ({ ...f, script: v }));
                }}
              />
            </label>
            {channels.length > 0 && (
              <fieldset className="forward-form-flags">
                <legend>{t("cron.channels")}</legend>
                {channels.map((c) => (
                  <label key={c.id} className="forward-flag">
                    <Checkbox
                      testid={`cron-form-channel-${c.id}`}
                      checked={form.channels.includes(c.id)}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        setForm((f) => ({
                          ...f,
                          channels: checked
                            ? [...f.channels, c.id]
                            : f.channels.filter((id) => id !== c.id),
                        }));
                      }}
                    />
                    {t(`alert.kind.${c.kind}`)}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="forward-form-flags">
              <label className="forward-flag">
                <Checkbox
                  testid="cron-form-enabled"
                  checked={form.enabled}
                  onChange={(e) => {
                    const c = e.currentTarget.checked;
                    setForm((f) => ({ ...f, enabled: c }));
                  }}
                />
                {t("cron.enabled")}
              </label>
            </div>
            {formError && (
              <p className="form-error" data-testid="cron-form-error">
                {formError}
              </p>
            )}
            <div className="form-actions">
              <button type="button" onClick={closeForm}>
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="btn-accent"
                data-testid="cron-form-save"
                disabled={submitting}
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        ) : (
          <div className="form-actions">
            <button className="btn-accent" data-testid="cron-add" onClick={openCreate}>
              {t("cron.add")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
