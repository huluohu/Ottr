// KnownHostsManager（Phase 3 Task 6，B9 收口）：known_hosts 生命周期管理页。
//   * 列表：端点 / 信任锚指纹 / 状态（ok·changed·pending）/ 首见 / 最近变更；
//   * 手动 verify：pending 一键「信任当前指纹」；changed 走「检查」→ 真
//     ssh-keyscan 取证（known_hosts_probe）→ 新旧对照后由用户显式接受（verify
//     接管新锚）/ 信任原锚（观测集仍含锚 = 误报或超集）/ 删除；
//   * 删除 = 忘记该端点（下次连接重走 TOFU）；确认框说明后果；
//   * 「立即巡检」：known_hosts_audit_run 手动跑一轮（与后台调度同一命令核，
//     changed 落账与 security 通知由 Rust 侧统一发出）；
//   * 「导入 known_hosts」（2026-11-02）：从本地 known_hosts 批量落地信任锚
//     ——原生文件对话框选文件，或用默认路径 ~/.ssh/known_hosts；导入报告
//     （新增/跳过重复/跳过冲突/错误）就地展示，冲突显著提示（既有端点未被
//     覆盖，仍会弹确认）。
// 入口：凭据与密钥对话框第三页签（KeyManager 区，简报裁定 #1）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEscClose } from "../ui/useEscClose";
import {
  vaultApi,
  type KnownHost,
  type KnownHostState,
  type KnownHostsImportReport,
} from "../vault/api";
import { InfoHint } from "../ui/InfoHint";

const STATE_BADGE: Record<KnownHostState, string> = {
  ok: "kh-badge-ok",
  changed: "kh-badge-changed",
  pending: "kh-badge-pending",
};

/** Rust 侧「文件不存在」错误码前缀（desktop/src/vault/hosts.rs 同名字面量）。
 *  命中即展示本地化的「未找到文件」提示，而不是把原始路径当导入失败抛给用户。 */
const FILE_NOT_FOUND_CODE = "known_hosts_file_not_found";

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
  // 导入面（2026-11-02）：报告 + 导入中态。
  const [importReport, setImportReport] = useState<KnownHostsImportReport | null>(null);
  const [importing, setImporting] = useState(false);
  // 取证对话框与删除确认互斥弹出，Esc 收当前层（probe 优先）。
  useEscClose(probe != null || confirmDelete != null, () => {
    if (probe != null) setProbe(null);
    else setConfirmDelete(null);
  });

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

  /** 导入本地 known_hosts（path=null → Rust 侧默认 ~/.ssh/known_hosts）。 */
  async function runImport(path: string | null) {
    setImporting(true);
    setError(null);
    try {
      const report = await vaultApi.knownHosts.import(path);
      setImportReport(report);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  /** 原生文件选择（plugin-dialog 动态引入——纯浏览器/测试环境缺席即静默）。
   *  选到文件才发起导入；取消（null）不发请求。 */
  async function pickAndImport() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        title: t("knownHosts.importChoose"),
      });
      if (typeof picked === "string") await runImport(picked);
    } catch {
      // 非 Tauri 环境：无原生对话框（静默——用户可改用「默认路径」按钮）
    }
  }

  return (
    <section aria-label={t("knownHosts.title")} data-testid="known-hosts-manager">
      <div className="kh-toolbar">
        <h3>{t("knownHosts.title")}</h3>
        <InfoHint text={t("knownHosts.hint")} />
        <button
          type="button"
          data-testid="kh-audit-now"
          disabled={auditing}
          onClick={() => void runAudit()}
        >
          {auditing ? t("knownHosts.auditing") : t("knownHosts.auditNow")}
        </button>
        {/* 导入本地 known_hosts（2026-11-02）：选文件 / 用默认路径两条入口 */}
        <button
          type="button"
          data-testid="kh-import"
          disabled={importing}
          onClick={() => void pickAndImport()}
        >
          {t("knownHosts.import")}
        </button>
        <button
          type="button"
          data-testid="kh-import-default"
          disabled={importing}
          onClick={() => void runImport(null)}
        >
          {t("knownHosts.importUseDefault")}
        </button>
      </div>
      <p className="settings-hint" data-testid="kh-import-hint">
        {t("knownHosts.importHint")} {t("knownHosts.importSkippedHashed")}
      </p>
      {importReport && (
        // role="status"（隐含 aria-live=polite）：导入是**异步**结果，读屏用户
        // 点了按钮后必须能听到「导了多少 / 跳了多少」——否则这条主流程对读屏
        // 用户完全不可见（只有视觉用户看得到报告块）。
        <div data-testid="kh-import-report" role="status" aria-live="polite">
          {importReport.errors.some((e) => e.startsWith(FILE_NOT_FOUND_CODE)) ? (
            <p className="tree-status" data-testid="kh-import-notfound">
              {t("knownHosts.importNotFound")}
            </p>
          ) : (
            <p className="tree-status" data-testid="kh-import-result">
              {t("knownHosts.importDone", {
                added: importReport.added,
                duplicate: importReport.skippedDuplicate,
                conflict: importReport.skippedConflict,
              })}
            </p>
          )}
          {/* 跳过条目的去向必须交代（真机 2026-11-02 实测：设备真实
              known_hosts 37 条全是 hashed，报告只说「新增 0 条」会让用户
              分不清「文件空的 / 全是 hashed / 路径指错」）。 */}
          {(importReport.skippedHashed > 0 || importReport.skippedOther > 0) && (
            <p className="settings-hint" data-testid="kh-import-skipped">
              {t("knownHosts.importSkipped", {
                hashed: importReport.skippedHashed,
                other: importReport.skippedOther,
              })}
            </p>
          )}
          {importReport.skippedConflict > 0 && (
            <p className="form-error" data-testid="kh-import-conflict">
              {t("knownHosts.importConflictNotice")}
            </p>
          )}
          {importReport.errors.length > 0 && (
            <ul className="kh-seen" data-testid="kh-import-errors">
              {importReport.errors.map((e, i) => (
                <li key={`${e}-${i}`}>
                  {e.startsWith(FILE_NOT_FOUND_CODE) ? t("knownHosts.importNotFound") : e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
                <InfoHint text={t("knownHosts.probeHint")} />
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
