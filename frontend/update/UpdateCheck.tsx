// 设置页「软件更新」面板（2026-10-09；2026-10-10 改造为 updateStore 消费面；
// 2026-10-13 v2 重排）：紧凑单行状态条——检查按钮与状态文案/动作同行，
// 发现新版为 accent 弱底单行条（文案左、按钮右），替代原 wizard-step 大空盒。
// 版本号不在本组件显示（关于卡已有，去重复）。便携版（exe 旁 portable.flag）
// 检查入口就地换手动指引 + 「打开下载页」直达 Releases（更新 = 手动换包）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "./updateStore";

export function UpdateCheck() {
  const { t } = useTranslation();
  const portable = useUpdateStore((s) => s.portable);
  const phase = useUpdateStore((s) => s.phase);
  const loadCurrent = useUpdateStore((s) => s.loadCurrent);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const restartNow = useUpdateStore((s) => s.restartNow);

  useEffect(() => {
    loadCurrent();
  }, [loadCurrent]);

  return (
    <div data-testid="update-check">
      {portable === true ? (
        // 便携版：无安装器/updater 签名件，检查更新没有意义——指引 + 直达
        // Releases 链接（html 链接与关于卡仓库链接同模式，系统浏览器打开）。
        <p className="settings-hint" data-testid="update-portable-hint">
          {t("update.portableHint")}{" "}
          <a
            href="https://github.com/huluohu/Ottr/releases/latest"
            target="_blank"
            rel="noreferrer"
            data-testid="update-portable-link"
          >
            {t("update.openDownloadPage")}
          </a>
        </p>
      ) : (
        <>
          {/* 单行状态条：检查按钮 + 当前状态/动作（下载进度/已最新/装完重启/错误） */}
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
            {phase.kind === "uptodate" && (
              <span className="settings-hint" data-testid="update-uptodate">
                {t("update.upToDate")}
              </span>
            )}
            {/* 装完：提示 + 「立即重启」就地生效（restartNow 的 invoke 永不
                resolve——Rust 侧 AppHandle::restart diverges，预期形态）。 */}
            {phase.kind === "installed" && (
              <>
                <span className="settings-hint" data-testid="update-installed">
                  {t("update.installed")}
                </span>
                <button
                  type="button"
                  className="btn-accent"
                  data-testid="update-restart"
                  onClick={restartNow}
                >
                  {t("update.restartNow")}
                </button>
              </>
            )}
            {phase.kind === "error" && (
              <span className="form-error" data-testid="update-error">
                {phase.message}
              </span>
            )}
          </div>
          {/* 发现新版：accent 弱底单行条（文案左、安装钮右），一行解决不铺开 */}
          {phase.kind === "available" && (
            <div className="update-available" data-testid="update-available">
              <span>{t("update.available", { version: phase.version })}</span>
              <button
                type="button"
                className="btn-accent"
                data-testid="update-install"
                onClick={() => void downloadAndInstall()}
              >
                {t("update.downloadInstall")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
