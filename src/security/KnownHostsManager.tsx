// KnownHostsManager（Phase 3 Task 6，B9 收口）：known_hosts 生命周期管理页。
//   * 列表：端点 / 信任锚指纹 / 状态（ok·changed·pending）/ 首见 / 最近变更；
//   * 手动 verify：pending 一键「信任当前指纹」；changed 走「检查」→ 真
//     ssh-keyscan 取证（known_hosts_probe）→ 新旧对照后由用户显式接受（verify
//     接管新锚）/ 信任原锚（观测集仍含锚 = 误报或超集）/ 删除；
//   * 删除 = 忘记该端点（下次连接重走 TOFU）；确认框说明后果；
//   * 「立即巡检」：known_hosts_audit_run 手动跑一轮（与后台调度同一命令核，
//     changed 落账与 security 通知由 Rust 侧统一发出）。
// 入口：凭据与密钥对话框第三页签（KeyManager 区，简报裁定 #1）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  vaultApi,
  type KnownHost,
  type KnownHostState,
} from "../vault/api";

const STATE_BADGE: Record<KnownHostState, string> = {
  ok: "kh-badge-ok",
  changed: "kh-badge-changed",
  pending: "kh-badge-pending",
};

/** 秒级 unix → 本地时间串（epoch 0 / 缺失 = —）。 */
function fmtTs(ts: number | null, neverLabel: string): string {
  if (!ts) return neverLabel;
  return new Date(ts * 1000).toLocaleString();
}

/** 「检查」取证态：changed 行 + probe 观测集（指纹归一：去重保序）。 */
interface ProbeState {
  row: KnownHost;
  seen: string[];
  error: string | null;
}

export function KnownHostsManager() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<KnownHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auditMsg, setAuditMsg] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KnownHost | null>(null);

  const refresh = useCallback(() => {
    return vaultApi.knownHosts
      .list()
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(hostKey: string, fn: () => Promise<unknown>) {
    setBusyKey(hostKey);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyKey(null);
    }
  }

  /** pending → 信任当前锚（verify 回 ok；TOFU 留痕转正）。 */
  const verifyAnchor = (row: KnownHost) =>
    act(row.host_key, () => vaultApi.knownHosts.verify(row.host_key, row.fingerprint));

  /** changed → 真探测取证后交用户裁定（绝不静默接管新锚）。 */
  async function check(row: KnownHost) {
    setBusyKey(row.host_key);
    setError(null);
    try {
      const seen = await vaultApi.knownHosts.probe(row.host_key);
      setProbe({ row, seen: [...new Set(seen)], error: null });
    } catch (e) {
      // 进程失败（如本机无 ssh-keyscan）：展示为取证失败，不替用户判定
      setProbe({ row, seen: [], error: String(e) });
    } finally {
      setBusyKey(null);
    }
  }

  async function runAudit() {
    setAuditing(true);
    setError(null);
    setAuditMsg(null);
    try {
      const outcome = await vaultApi.knownHosts.auditRun();
      setAuditMsg(
        t("knownHosts.auditResult", {
          checked: outcome.checked,
          changed: outcome.changed.length,
        }),
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAuditing(false);
    }
  }

  return (
    <section aria-label={t("knownHosts.title")} data-testid="known-hosts-manager">
      <div className="kh-toolbar">
        <h3>{t("knownHosts.title")}</h3>
        <button
          type="button"
          data-testid="kh-audit-now"
          disabled={auditing}
          onClick={() => void runAudit()}
        >
          {auditing ? t("knownHosts.auditing") : t("knownHosts.auditNow")}
        </button>
      </div>
      <p className="settings-hint">{t("knownHosts.hint")}</p>
      {auditMsg && (
        <p className="tree-status" data-testid="kh-audit-result">
          {auditMsg}
        </p>
      )}
      {error && (
        <p className="form-error" data-testid="kh-error">
          {error}
        </p>
      )}

      {rows === null ? (
        <p className="settings-hint">{t("knownHosts.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="settings-hint" data-testid="kh-empty">
          {t("knownHosts.empty")}
        </p>
      ) : (
        <table className="kh-table" data-testid="kh-table">
          <thead>
            <tr>
              <th>{t("knownHosts.endpoint")}</th>
              <th>{t("knownHosts.fingerprint")}</th>
              <th>{t("knownHosts.state")}</th>
              <th>{t("knownHosts.firstSeen")}</th>
              <th>{t("knownHosts.changedAt")}</th>
              <th aria-label={t("knownHosts.actions")} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.host_key} data-testid={`kh-row-${row.host_key}`}>
                <td>
                  <code>{row.host_key}</code>
                </td>
                <td>
                  <code className="kh-fp">{row.fingerprint}</code>
                </td>
                <td>
                  <span className={`kh-badge ${STATE_BADGE[row.state]}`} data-testid={`kh-state-${row.host_key}`}>
                    {t(`knownHosts.state_${row.state}`)}
                  </span>
                </td>
                <td className="kh-ts">{fmtTs(row.first_seen, "—")}</td>
                <td className="kh-ts">{fmtTs(row.changed_at, t("knownHosts.never"))}</td>
                <td className="kh-actions">
                  {row.state === "pending" && (
                    <button
                      type="button"
                      data-testid={`kh-verify-${row.host_key}`}
                      disabled={busyKey === row.host_key}
                      onClick={() => void verifyAnchor(row)}
                    >
                      {t("knownHosts.verify")}
                    </button>
                  )}
                  {row.state === "changed" && (
                    <button
                      type="button"
                      data-testid={`kh-check-${row.host_key}`}
                      disabled={busyKey === row.host_key}
                      onClick={() => void check(row)}
                    >
                      {t("knownHosts.check")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="kh-danger"
                    data-testid={`kh-delete-${row.host_key}`}
                    disabled={busyKey === row.host_key}
                    onClick={() => setConfirmDelete(row)}
                  >
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* changed 取证对话框：新旧对照 + 显式裁定 */}
      {probe && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={t("knownHosts.probeTitle")}>
          <div className="dialog kh-probe-dialog" data-testid="kh-probe-dialog">
            <h2>{t("knownHosts.probeTitle")}</h2>
            <p className="dialog-intro">
              {t("knownHosts.probeEndpoint", { endpoint: probe.row.host_key })}
            </p>
            <p>
              <span className="km-label">{t("knownHosts.probeAnchor")}</span>{" "}
              <code data-testid="kh-probe-anchor">{probe.row.fingerprint}</code>
            </p>
            {probe.error ? (
              <p className="form-error" data-testid="kh-probe-error">
                {t("knownHosts.probeFailed", { message: probe.error })}
              </p>
            ) : probe.seen.length === 0 ? (
              <p className="settings-hint" data-testid="kh-probe-none">
                {t("knownHosts.probeNone")}
              </p>
            ) : (
              <>
                <p className="settings-hint">{t("knownHosts.probeHint")}</p>
                <ul className="kh-seen" data-testid="kh-probe-seen">
                  {probe.seen.map((fp) => (
                    <li key={fp}>
                      <code>{fp}</code>
                      <button
                        type="button"
                        data-testid={`kh-trust-${fp}`}
                        onClick={() => {
                          const target = probe.row;
                          setProbe(null);
                          void act(target.host_key, () =>
                            vaultApi.knownHosts.verify(target.host_key, fp),
                          );
                        }}
                      >
                        {fp === probe.row.fingerprint
                          ? t("knownHosts.trustAnchor")
                          : t("knownHosts.trustNew")}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="form-actions">
              <button type="button" data-testid="kh-probe-close" onClick={() => setProbe(null)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认：删除 = 忘记该端点，下次连接重走 TOFU */}
      {confirmDelete && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={t("knownHosts.deleteTitle")}>
          <div className="dialog kh-delete-dialog" data-testid="kh-delete-dialog">
            <h2>{t("knownHosts.deleteTitle")}</h2>
            <p className="dialog-intro" data-testid="kh-delete-hint">
              {t("knownHosts.deleteHint", { endpoint: confirmDelete.host_key })}
            </p>
            <div className="form-actions">
              <button type="button" data-testid="kh-delete-cancel" onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-danger"
                data-testid="kh-delete-confirm"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void act(target.host_key, () => vaultApi.knownHosts.remove(target.host_key));
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
