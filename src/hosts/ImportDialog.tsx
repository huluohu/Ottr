// ImportDialog（Task 5 Step 3）：~/.ssh/config 一次性导入 + 完成报告对话框。
// 报告展示（裁定 #4）：新增 N、跳过 N（通配/重复分列）、解析错误行列表。
// 导入成功后刷新 store（新主机立即可见于树）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type ImportReport } from "../vault/api";
import { useVaultStore } from "../vault/store";

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useVaultStore((s) => s.refresh);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function runImport() {
    setPhase("running");
    setErrorMessage(null);
    try {
      const r = await vaultApi.importSshConfig(null);
      setReport(r);
      setPhase("done");
      // 导入结果对树可见（refresh 失败不影响导入本身的完成态）
      void refresh().catch(() => {});
    } catch (e) {
      setErrorMessage(String(e));
      setPhase("failed");
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("importDialog.title")}>
      <div className="dialog import-dialog" data-testid="import-dialog">
        <h2>{t("importDialog.title")}</h2>
        <p className="dialog-intro">{t("importDialog.intro")}</p>

        {phase === "idle" && (
          <div className="form-actions">
            <button onClick={onClose}>{t("common.cancel")}</button>
            <button className="btn-accent" data-testid="import-start" onClick={() => void runImport()}>
              {t("importDialog.start")}
            </button>
          </div>
        )}

        {phase === "running" && <p data-testid="import-running">{t("importDialog.running")}</p>}

        {phase === "failed" && (
          <>
            <p className="form-error" data-testid="import-failed">
              {t("importDialog.failed", { message: errorMessage ?? "" })}
            </p>
            <div className="form-actions">
              <button onClick={onClose}>{t("common.close")}</button>
              <button className="btn-accent" onClick={() => void runImport()}>
                {t("common.retry")}
              </button>
            </div>
          </>
        )}

        {phase === "done" && report && (
          <>
            <div className="import-report" data-testid="import-report">
              <p className={report.added > 0 ? "report-added" : undefined}>
                {report.added > 0
                  ? t("importDialog.added", { count: report.added })
                  : t("importDialog.addedZero")}
              </p>
              <p>{t("importDialog.skippedWildcards", { count: report.skipped_wildcards })}</p>
              <p>{t("importDialog.skippedDuplicates", { count: report.skipped_duplicates })}</p>
              {report.errors.length > 0 ? (
                <>
                  <p className="report-errors-title">
                    {t("importDialog.errors", { count: report.errors.length })}
                  </p>
                  <ul className="report-errors" data-testid="import-errors">
                    {report.errors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>{t("importDialog.noErrors")}</p>
              )}
            </div>
            <div className="form-actions">
              <button className="btn-accent" data-testid="import-close" onClick={onClose}>
                {t("common.done")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
