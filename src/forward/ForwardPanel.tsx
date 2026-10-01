// ForwardPanel（Phase 2 Task 1，B7 上半）：端口转发中心面板（顶栏入口的对话框）。
// * 列表：全部 port_forwards（配置 + 运行态拼接，pf_list）——状态灯
//   （active/starting/error/off 四色，data-state 驱动）、端点摘要（bind → target，
//   dynamic 显示 SOCKS5）、字节计数人话格式（formatBytes）、启停按钮。
// * 添加/编辑：三型表单（local/remote 带 target；dynamic 隐藏 target），
//   host 下拉（vault 主机表）；enabled = 会话建立即自动启动；auto_reconnect =
//   断线重连后自动恢复。
// * 运行面：pf_start 需要目标主机会话在线（rustId）；未连接禁用并提示。
//   pf_stop 随时可停。enabled 开关只落库（自动启动旗标），运行态启停走按钮。
// * 轮询：面板打开期间 2s 刷新（字节计数活性；关闭即停，无后台开销）。
// * 主题/i18n 纪律：语义令牌（--color-*），文案全走词典键。
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  vaultApi,
  type ForwardKind,
  type PortForwardInput,
  type PortForwardView,
  type Host,
} from "../vault/api";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";

export interface ForwardPanelProps {
  open: boolean;
  onClose: () => void;
}

/** 字节计数人话格式（B/KB/MB/GB/TB，1 位小数；0 特判「0 B」）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/** 运行态 → 状态灯档位（off = 无 runtime 或已停；error 优先展示失败）。 */
export function lightOf(row: PortForwardView): "active" | "starting" | "error" | "off" {
  const state = row.runtime?.state;
  if (state === "active") return "active";
  if (state === "starting") return "starting";
  if (state === "error") return "error";
  return "off";
}

interface FormState {
  hostId: string;
  kind: ForwardKind;
  bindAddr: string;
  bindPort: string;
  targetHost: string;
  targetPort: string;
  enabled: boolean;
  autoReconnect: boolean;
}

const EMPTY_FORM: FormState = {
  hostId: "",
  kind: "local",
  bindAddr: "127.0.0.1",
  bindPort: "",
  targetHost: "",
  targetPort: "",
  enabled: true,
  autoReconnect: true,
};

function formFromRow(row: PortForwardView): FormState {
  return {
    hostId: String(row.host_id),
    kind: row.kind,
    bindAddr: row.bind_addr,
    bindPort: String(row.bind_port),
    targetHost: row.target_host ?? "",
    targetPort: row.target_port != null ? String(row.target_port) : "",
    enabled: row.enabled,
    autoReconnect: row.auto_reconnect,
  };
}

export function ForwardPanel({ open, onClose }: ForwardPanelProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const sessions = useSessionStore((s) => s.sessions);
  const [rows, setRows] = useState<PortForwardView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const listSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const data = await vaultApi.portForwards.list(null);
      if (seq === listSeq.current) {
        setRows(data);
        setLoadError(null);
      }
    } catch (err) {
      if (seq === listSeq.current) {
        setLoadError(String(err));
      }
    }
  }, []);

  // 打开即取数 + 打开期间 2s 轮询（字节计数活性）；关闭即停。
  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  // 表单默认主机：下拉首位（空 = 提示先建主机）。
  useEffect(() => {
    if (open && formOpen && form.hostId === "" && hosts.length > 0) {
      setForm((f) => ({ ...f, hostId: String(hosts[0].id) }));
    }
  }, [open, formOpen, form.hostId, hosts]);

  if (!open) return null;

  /** 主机是否已连接（pf_start 的前置；rustId 为运行面句柄）。 */
  function rustIdOf(hostId: number): string | null {
    return (
      sessions.find((s) => s.hostId === hostId && s.rustId != null && s.status === "connected")
        ?.rustId ?? null
    );
  }

  async function handleStart(row: PortForwardView) {
    setActionError(null);
    const rustId = rustIdOf(row.host_id);
    if (rustId == null) return;
    try {
      await vaultApi.portForwards.start(row.id, rustId);
      await refresh();
    } catch (err) {
      setActionError(t("forward.actionFailed", { message: String(err) }));
    }
  }

  async function handleStop(row: PortForwardView) {
    setActionError(null);
    try {
      await vaultApi.portForwards.stop(row.id);
      await refresh();
    } catch (err) {
      setActionError(t("forward.actionFailed", { message: String(err) }));
    }
  }

  async function handleToggleEnabled(row: PortForwardView) {
    setActionError(null);
    try {
      await vaultApi.portForwards.setEnabled(row.id, !row.enabled);
      await refresh();
    } catch (err) {
      setActionError(t("forward.actionFailed", { message: String(err) }));
    }
  }

  async function handleDelete(row: PortForwardView) {
    setActionError(null);
    try {
      await vaultApi.portForwards.remove(row.id);
      if (editingId === row.id) closeForm();
      await refresh();
    } catch (err) {
      setActionError(t("forward.actionFailed", { message: String(err) }));
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, hostId: hosts[0] != null ? String(hosts[0].id) : "" });
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(row: PortForwardView) {
    setEditingId(row.id);
    setForm(formFromRow(row));
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setFormError(null);
  }

  function validateForm(): string | null {
    if (form.hostId === "") return t("forward.errHostRequired");
    if (!/^\d+$/.test(form.bindPort.trim()) || Number(form.bindPort) > 65535) {
      return t("forward.errBindPort");
    }
    if (form.kind !== "dynamic") {
      if (form.targetHost.trim() === "") return t("forward.errTargetRequired");
      if (
        !/^\d+$/.test(form.targetPort.trim()) ||
        Number(form.targetPort) < 1 ||
        Number(form.targetPort) > 65535
      ) {
        return t("forward.errTargetPort");
      }
    }
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
    const dynamic = form.kind === "dynamic";
    const input: PortForwardInput = {
      host_id: Number(form.hostId),
      kind: form.kind,
      bind_addr: form.bindAddr.trim() || "127.0.0.1",
      bind_port: Number(form.bindPort.trim()),
      target_host: dynamic ? null : form.targetHost.trim(),
      target_port: dynamic ? null : Number(form.targetPort.trim()),
      enabled: form.enabled,
      auto_reconnect: form.autoReconnect,
    };
    try {
      if (editingId != null) {
        await vaultApi.portForwards.update(editingId, input);
      } else {
        await vaultApi.portForwards.create(input);
      }
      closeForm();
      await refresh();
    } catch (submitErr) {
      setFormError(t("forward.saveFailed", { message: String(submitErr) }));
    } finally {
      setSubmitting(false);
    }
  }

  const hostById = new Map<number, Host>(hosts.map((h) => [h.id, h]));

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("forward.title")}>
      <div className="dialog forward-panel" data-testid="forward-panel">
        <div className="dialog-head">
          <h2>{t("forward.title")}</h2>
          <button className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>

        {loadError && (
          <p className="form-error" data-testid="forward-load-error">
            {t("forward.loadFailed", { message: loadError })}
          </p>
        )}
        {actionError && (
          <p className="form-error" data-testid="forward-action-error">
            {actionError}
          </p>
        )}

        {rows.length === 0 && !loadError && (
          <p className="forward-empty" data-testid="forward-empty">
            {t("forward.empty")}
          </p>
        )}

        <ul className="forward-list" data-testid="forward-list">
          {rows.map((row) => {
            const light = lightOf(row);
            const rustId = rustIdOf(row.host_id);
            const running = row.runtime != null && light !== "off";
            return (
              <li key={row.id} className="forward-row" data-testid={`forward-row-${row.id}`}>
                <span className="forward-light" data-state={light} aria-hidden="true" />
                <span className="forward-main">
                  <span className="forward-endpoint">
                    {row.bind_addr}:{row.runtime?.bound_port ?? row.bind_port}
                    <span className="forward-arrow" aria-hidden="true">
                      {" → "}
                    </span>
                    {row.kind === "dynamic"
                      ? t("forward.kindDynamic")
                      : `${row.target_host}:${row.target_port}`}
                  </span>
                  <span className="forward-meta">
                    {hostById.get(row.host_id)?.name ?? row.host_name} ·{" "}
                    {t(`forward.kind.${row.kind}`)}
                    {row.runtime != null && (
                      <>
                        {" · "}
                        <span data-testid={`forward-bytes-${row.id}`}>
                          ↑{formatBytes(row.runtime.tx_bytes)} ↓{formatBytes(row.runtime.rx_bytes)}
                        </span>
                      </>
                    )}
                    {row.runtime?.state === "error" && row.runtime.error != null && (
                      <span className="forward-err-text"> · {row.runtime.error}</span>
                    )}
                  </span>
                </span>
                <span className="forward-actions">
                  <label className="forward-flag" title={t("forward.enabledHint")}>
                    <input
                      type="checkbox"
                      data-testid={`forward-enabled-${row.id}`}
                      checked={row.enabled}
                      onChange={() => void handleToggleEnabled(row)}
                    />
                    {t("forward.enabled")}
                  </label>
                  {running ? (
                    <button
                      data-testid={`forward-stop-${row.id}`}
                      onClick={() => void handleStop(row)}
                    >
                      {t("forward.stop")}
                    </button>
                  ) : (
                    <button
                      data-testid={`forward-start-${row.id}`}
                      disabled={rustId == null}
                      title={rustId == null ? t("forward.needSession") : undefined}
                      onClick={() => void handleStart(row)}
                    >
                      {t("forward.start")}
                    </button>
                  )}
                  <button
                    data-testid={`forward-edit-${row.id}`}
                    onClick={() => openEdit(row)}
                    aria-label={t("common.edit")}
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    data-testid={`forward-delete-${row.id}`}
                    onClick={() => void handleDelete(row)}
                    aria-label={t("common.delete")}
                  >
                    {t("common.delete")}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>

        {formOpen ? (
          <form className="forward-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
            <h3>{editingId != null ? t("forward.editTitle") : t("forward.addTitle")}</h3>
            <div className="form-row">
              <label className="grow">
                <span>{t("forward.host")}</span>
                <select
                  data-testid="forward-form-host"
                  value={form.hostId}
                  onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, hostId: v })); }}
                >
                  {hosts.length === 0 && <option value="">—</option>}
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("forward.kindLabel")}</span>
                <select
                  data-testid="forward-form-kind"
                  value={form.kind}
                  onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, kind: v as ForwardKind })); }}
                >
                  <option value="local">{t("forward.kind.local")}</option>
                  <option value="remote">{t("forward.kind.remote")}</option>
                  <option value="dynamic">{t("forward.kind.dynamic")}</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label className="grow">
                <span>{t("forward.bindAddr")}</span>
                <input
                  data-testid="forward-form-bind-addr"
                  value={form.bindAddr}
                  onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, bindAddr: v })); }}
                />
              </label>
              <label>
                <span>{t("forward.bindPort")}</span>
                <input
                  data-testid="forward-form-bind-port"
                  value={form.bindPort}
                  inputMode="numeric"
                  placeholder={form.kind === "remote" ? t("forward.bindPortAuto") : ""}
                  onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, bindPort: v })); }}
                />
              </label>
            </div>
            {form.kind !== "dynamic" && (
              <div className="form-row">
                <label className="grow">
                  <span>{t("forward.targetHost")}</span>
                  <input
                    data-testid="forward-form-target-host"
                    value={form.targetHost}
                    placeholder={t("forward.targetHostPlaceholder")}
                    onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, targetHost: v })); }}
                  />
                </label>
                <label>
                  <span>{t("forward.targetPort")}</span>
                  <input
                    data-testid="forward-form-target-port"
                    value={form.targetPort}
                    inputMode="numeric"
                    onChange={(e) => { const v = e.currentTarget.value; setForm((f) => ({ ...f, targetPort: v })); }}
                  />
                </label>
              </div>
            )}
            <div className="forward-form-flags">
              <label className="forward-flag">
                <input
                  type="checkbox"
                  data-testid="forward-form-enabled"
                  checked={form.enabled}
                  onChange={(e) => { const c = e.currentTarget.checked; setForm((f) => ({ ...f, enabled: c })); }}
                />
                {t("forward.enabled")}
              </label>
              <label className="forward-flag">
                <input
                  type="checkbox"
                  data-testid="forward-form-auto-reconnect"
                  checked={form.autoReconnect}
                  onChange={(e) => { const c = e.currentTarget.checked; setForm((f) => ({ ...f, autoReconnect: c })); }}
                />
                {t("forward.autoReconnect")}
              </label>
            </div>
            {formError && (
              <p className="form-error" data-testid="forward-form-error">
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
                data-testid="forward-form-save"
                disabled={submitting}
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        ) : (
          <div className="form-actions">
            <button className="btn-accent" data-testid="forward-add" onClick={openCreate}>
              {t("forward.add")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
