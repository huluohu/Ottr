// 设置页「软件更新」面板（2026-10-09，用户要求完成检查更新功能）：
// 经 @tauri-apps/plugin-updater 的 check() 查 latest.json（endpoints/pubkey
// 见 tauri.conf.json plugins.updater），发现新版即 downloadAndInstall()（带
// 下载进度），装完提示手动重启（不引 process 插件，保持依赖面小）。
import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { useTranslation } from "react-i18next";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update; version: string }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "installed" }
  | { kind: "error"; message: string };

export function UpdateCheck() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    getVersion()
      .then(setCurrent)
      .catch(() => setCurrent(null)); // 非 Tauri 环境：仅隐藏版本号
  }, []);

  // 四端入口（mac 菜单/汉堡/⌘K/托盘 的「检查更新」）经 ottr:update-check
  // 事件触发本面板的就地检查——复用同一 UX（进度/安装/重启提示）。
  useEffect(() => {
    const onEvt = () => void checkForUpdate();
    window.addEventListener("ottr:update-check", onEvt);
    return () => window.removeEventListener("ottr:update-check", onEvt);
  });

  async function checkForUpdate() {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setPhase({ kind: "available", update, version: update.version });
      } else {
        setPhase({ kind: "uptodate" });
      }
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function downloadAndInstall(update: Update) {
    setPhase({ kind: "downloading", received: 0, total: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setPhase({ kind: "downloading", received: 0, total: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          setPhase((p) =>
            p.kind === "downloading"
              ? { kind: "downloading", received: p.received + event.data.chunkLength, total: p.total }
              : p,
          );
        } else if (event.event === "Finished") {
          setPhase({ kind: "installed" });
        }
      });
      setPhase({ kind: "installed" });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

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
              onClick={() => void downloadAndInstall(phase.update)}
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
