// ExportHostsDialog（2026-10-16 用户需求：导出对齐导入类型）：四格式导出 +
// 结果对话框。格式与导入器四族一一对应（CSV / Tabby JSON / Xshell 会话目录 /
// OpenSSH config）；Rust 侧四命令同构返回（落盘路径 / 个数）。
// 口径：只出元数据不出凭据（与 CSV 既有口径一致，秘密不出库）。
// Xshell 无单文件形态（每主机一个 .xsh）→ 走目录选择；其余格式走保存对话框
// （缺省文件名按格式预填）。plugin-dialog 动态引入——纯浏览器/测试环境缺席
// 即按钮无效（同 ImportDialog 口径）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showToast } from "../ui/toastStore";
import { vaultApi } from "../vault/api";
import { useEscClose } from "../ui/useEscClose";

type ExportFormat = "csv" | "tabby" | "xshell" | "sshconfig";

const FORMATS: readonly { id: ExportFormat; labelKey: string }[] = [
  { id: "csv", labelKey: "exportDialog.formatCsv" },
  { id: "tabby", labelKey: "exportDialog.formatTabby" },
  { id: "xshell", labelKey: "exportDialog.formatXshell" },
  { id: "sshconfig", labelKey: "exportDialog.formatSshconfig" },
];

/** 保存对话框参数（filters + 缺省文件名）。Xshell 走目录选择，不在表内。 */
const SAVE_SPECS: Record<Exclude<ExportFormat, "xshell">, { defaultName: string; filterName: string; ext: string }> = {
  csv: { defaultName: "ottr-hosts.csv", filterName: "CSV", ext: "csv" },
  tabby: { defaultName: "ottr-tabby.json", filterName: "JSON", ext: "json" },
  sshconfig: { defaultName: "ottr-ssh-config", filterName: "OpenSSH config", ext: "" },
};

export function ExportHostsDialog({ onClose, closing }: { onClose: () => void; closing?: boolean }) {
  const { t } = useTranslation();
  useEscClose(true, onClose);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function runExport() {
    setPhase("running");
    setErrorMessage(null);
    try {
      if (format === "xshell") {
        // 目录选择（Xshell = 每主机一个 .xsh 的会话目录形态）
        const { open } = await import("@tauri-apps/plugin-dialog");
        const dir = await open({ directory: true, title: t("exportDialog.pickFolder") });
        if (typeof dir !== "string") {
          setPhase("idle"); // 用户取消 = 回选择态
          return;
        }
        const count = await vaultApi.exportHostsXshell(dir);
        showToast(t("exportDialog.doneCount", { count, path: dir }));
      } else {
        const spec = SAVE_SPECS[format];
        const { save } = await import("@tauri-apps/plugin-dialog");
        const target = await save({
          defaultPath: spec.defaultName,
          filters: spec.ext
            ? [{ name: spec.filterName, extensions: [spec.ext] }]
            : [{ name: spec.filterName, extensions: ["conf", "txt", "config"] }],
        });
        if (typeof target !== "string") {
          setPhase("idle");
          return;
        }
        const path =
          format === "csv"
            ? await vaultApi.exportHostsCsv(target)
            : format === "tabby"
              ? await vaultApi.exportHostsTabby(target)
              : await vaultApi.exportHostsSshConfig(target);
        showToast(t("exportDialog.donePath", { path }));
      }
      onClose();
    } catch (e) {
      setErrorMessage(String(e));
      setPhase("failed");
    }
  }

  return (
    <div
      className={`overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("exportDialog.title")}
    >
      <div className="dialog import-dialog" data-testid="export-dialog">
        <h2>{t("exportDialog.title")}</h2>

        <p className="dialog-intro">{t("exportDialog.intro")}</p>

        {/* 格式选择：与导入来源四族一一对应，radio 语义 */}
        <div className="import-sources" role="radiogroup" aria-label={t("exportDialog.format")}>
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={format === f.id}
              data-active={format === f.id}
              data-testid={`export-format-${f.id}`}
              onClick={() => setFormat(f.id)}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <p className="dialog-intro">{t(`exportDialog.${format}Intro`)}</p>

        {phase === "failed" && (
          <p className="form-error" data-testid="export-failed">
            {t("exportDialog.failed", { message: errorMessage ?? "" })}
          </p>
        )}

        <div className="form-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className="btn-accent"
            data-testid="export-start"
            disabled={phase === "running"}
            onClick={() => void runExport()}
          >
            {phase === "running" ? t("exportDialog.running") : t("exportDialog.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
