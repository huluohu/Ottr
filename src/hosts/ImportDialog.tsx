// ImportDialog（Task 5 Step 3 → Phase 2 Task 10 扩展）：多来源一次性导入 +
// 完成报告对话框。来源（B3 迁移导入器）：~/.ssh/config / Xshell 会话目录 /
// Tabby 配置（JSON/YAML，BL-513 补 YAML 形态）——Rust 侧四命令同构
// ImportReport，报告展示零特判。
// 报告展示（裁定 #4）：新增 N、跳过 N（ssh=通配 pattern；xshell/tabby=不可用
// 条目/文件，分列）、解析错误行列表。导入成功后刷新 store（新主机立即可见）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type ImportReport } from "../vault/api";
import { useVaultStore } from "../vault/store";

type ImportSource = "ssh" | "xshell" | "tabby";

const SOURCES: { id: ImportSource; labelKey: string }[] = [
  { id: "ssh", labelKey: "importDialog.sourceSsh" },
  { id: "xshell", labelKey: "importDialog.sourceXshell" },
  { id: "tabby", labelKey: "importDialog.sourceTabby" },
];

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useVaultStore((s) => s.refresh);
  const [source, setSource] = useState<ImportSource>("ssh");
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Tabby 无跨平台惯例位置：必须先选文件才能开始（xshell 可回落服务端默认目录）
  const startEnabled = source !== "tabby" || pickedPath !== null;

  function switchSource(next: ImportSource) {
    if (next === source) return;
    setSource(next);
    setPickedPath(null);
    setPhase("idle"); // 中途换来源：报告/错误面一并清（不同来源语义不混排）
    setReport(null);
    setErrorMessage(null);
  }

  /** 原生路径选择（plugin-dialog 动态引入——纯浏览器/测试环境缺席即按钮无效）。 */
  async function pickPath() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open(
        source === "xshell"
          ? { directory: true, title: t("importDialog.pickFolder") }
          : {
              multiple: false,
              title: t("importDialog.pickFile"),
              // BL-513：Tabby 生产配置是 YAML（~/.config/tabby/config.yaml）——
              // 对话框放行 yaml/yml，Rust 侧按内容嗅探 JSON/YAML
              filters: [{ name: "Tabby config", extensions: ["json", "yaml", "yml"] }],
            },
      );
      if (typeof picked === "string") setPickedPath(picked);
    } catch {
      // 非 Tauri 环境：无原生对话框（静默——start 按钮的 enabled 门已兜住）
    }
  }

  async function runImport() {
    setPhase("running");
    setErrorMessage(null);
    try {
      const r =
        source === "ssh"
          ? await vaultApi.importSshConfig(null)
          : source === "xshell"
            ? await vaultApi.importXshellSessions(pickedPath)
            : await vaultApi.importTabbyConfig(pickedPath as string);
      setReport(r);
      setPhase("done");
      // 导入结果对树可见（refresh 失败不影响导入本身的完成态）
      void refresh().catch(() => {});
    } catch (e) {
      setErrorMessage(String(e));
      setPhase("failed");
    }
  }

  const intro =
    source === "ssh"
      ? t("importDialog.intro")
      : source === "xshell"
        ? t("importDialog.xshellIntro")
        : t("importDialog.tabbyIntro");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("importDialog.title")}>
      <div className="dialog import-dialog" data-testid="import-dialog">
        <h2>{t("importDialog.title")}</h2>

        {/* 来源切换（B3）：ssh / xshell / tabby 三入口，radio 语义 */}
        <div className="import-sources" role="radiogroup" aria-label={t("importDialog.source")}>
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={source === s.id}
              data-active={source === s.id}
              data-testid={`import-source-${s.id}`}
              onClick={() => switchSource(s.id)}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
        <p className="dialog-intro">{intro}</p>

        {source !== "ssh" && (
          <div className="import-pick-row">
            <button type="button" data-testid="import-pick" onClick={() => void pickPath()}>
              {source === "xshell" ? t("importDialog.pickFolder") : t("importDialog.pickFile")}
            </button>
            {pickedPath && (
              <code data-testid="import-path" className="import-path">
                {pickedPath}
              </code>
            )}
          </div>
        )}

        {phase === "idle" && (
          <div className="form-actions">
            <button onClick={onClose}>{t("common.cancel")}</button>
            <button
              className="btn-accent"
              data-testid="import-start"
              disabled={!startEnabled}
              onClick={() => void runImport()}
            >
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
              {/* 跳过分列：ssh=通配 pattern；xshell/tabby=不可用条目/文件（B3 同字段换语义标签） */}
              <p>
                {source === "ssh"
                  ? t("importDialog.skippedWildcards", { count: report.skipped_wildcards })
                  : t("importDialog.skippedEntries", { count: report.skipped_wildcards })}
              </p>
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
