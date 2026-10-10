// 设置页「软件更新」面板（2026-10-09；2026-10-10 改造为 updateStore 消费面）：
// 状态/检查/下载安装逻辑单源在 update/updateStore.ts——本组件只渲染 phase。
// 四端「检查更新」入口（mac 菜单/汉堡/⌘K/托盘）经 updateStore.checkForUpdate
// 直接走 toast 反馈，不打开本面板（用户裁定：点检查更新不跳设置页）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "./updateStore";

export function UpdateCheck() {
  const { t } = useTranslation();
  const current = useUpdateStore((s) => s.current);
  const phase = useUpdateStore((s) => s.phase);
  const loadCurrent = useUpdateStore((s) => s.loadCurrent);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  return (
    <div data-testid="update-check">
      <label className="settings-row">
        <span className="settings-label">{t("update.currentVersion")}</span>
        <span className="settings-hint" data-testid="update-current">
          {current ?? "—"}
        </span>
      </label>
      <div className="settings-row">
        <button
          type="button"
          className="btn-accent"
          data-testid="update-check-button"
          disabled={phase.kind === "checking" || phase.kind === "downloading"}
          onClick={() => void checkForUpdate()}
        >
          {phase.kind === "checking" ? t("update.checking") : t("update.check")}
        </button>
        {phase.kind === "downloading" && (
          <span className="settings-hint" data-testid="update-progress">
            {phase.total
              ? t("update.downloadingOf", {
                  received: Math.round(phase.received / 1024),
                  total: Math.round(phase.total / 1024),
                })
              : t("update.downloading")}
          </span>
        )}
      </div>
      {phase.kind === "uptodate" && (
        <p className="settings-hint" data-testid="update-uptodate">
          {t("update.upToDate")}
        </p>
      )}
      {phase.kind === "available" && (
        <div className="wizard-step" data-testid="update-available">
          <p className="dialog-intro">
            {t("update.available", { version: phase.version })}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn-accent"
              data-testid="update-install"
              onClick={() => void downloadAndInstall()}
            >
              {t("update.downloadInstall")}
            </button>
          </div>
        </div>
      )}
      {phase.kind === "installed" && (
        <p className="settings-hint" data-testid="update-installed">
          {t("update.installed")}
        </p>
      )}
      {phase.kind === "error" && (
        <p className="form-error" data-testid="update-error">
          {phase.message}
        </p>
      )}
    </div>
  );
}
