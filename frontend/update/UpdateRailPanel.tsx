// 图标轨更新面板（2026-10-26 用户需求「点击有新版本后弹出新版本面板，显示
// 新版本信息，支持下载并安装」）：贴更新钮右侧弹出，随 updateStore 的
// phase 换内容，贯穿有新版 → 下载中 → 已安装待重启 → 失败重试全程——
// 下载无论从本面板、「检查更新」toast 还是设置页发起，这里都能看到进度。
//
// 面板不渲染 HTML：发布说明经 releaseNotes.parseReleaseNotes 拆成纯文本块。
// 「在 GitHub 查看」= 该版本 Release 页（系统浏览器，同关于卡仓库链接模式）。
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "./updateStore";
import { parseReleaseNotes } from "./releaseNotes";

export interface UpdateRailPanelProps {
  /** 锚定位置（fixed；与 Otty 弹层同一算法：底边对齐钮、左缘贴轨右侧）。 */
  pos: { bottom: number; left: number };
  onClose: () => void;
}

function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function UpdateRailPanel({ pos, onClose }: UpdateRailPanelProps) {
  const { t, i18n } = useTranslation();
  const phase = useUpdateStore((s) => s.phase);
  const info = useUpdateStore((s) => s.info);
  const current = useUpdateStore((s) => s.current);
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const restartNow = useUpdateStore((s) => s.restartNow);
  const blocks = useMemo(
    () => (info ? parseReleaseNotes(info.body, info.version) : []),
    [info],
  );
  if (!info) return null;

  const version = info.version;
  const releaseUrl = `https://github.com/huluohu/Ottr/releases/tag/v${version}`;
  const date = formatDate(info.date, i18n.language);
  const kind = phase.kind;

  const title =
    kind === "downloading"
      ? t("update.panelDownloading", { version })
      : kind === "installed"
        ? t("update.panelInstalled", { version })
        : kind === "error"
          ? t("update.panelFailed")
          : kind === "checking"
            ? t("update.checking")
            : t("update.available", { version });

  const pct =
    kind === "downloading" && phase.total != null && phase.total > 0
      ? Math.min(100, Math.floor((phase.received / phase.total) * 100))
      : null;

  const githubLink = (
    <a
      href={releaseUrl}
      target="_blank"
      rel="noreferrer"
      className="update-pop-link"
      data-testid="update-pop-github"
    >
      {t("update.viewOnGitHub")}
    </a>
  );

  return (
    <div
      className="rail-pop update-pop"
      role="dialog"
      aria-label={title}
      data-testid="update-pop"
      data-phase={kind}
      style={{ bottom: pos.bottom, left: pos.left }}
    >
      <div className="update-pop-head">
        <strong className="update-pop-title" data-testid="update-pop-title">
          {title}
        </strong>
        <span className="update-pop-meta" data-testid="update-pop-meta">
          {current ? t("update.panelCurrent", { version: current }) : null}
          {current && date ? " · " : null}
          {date}
        </span>
      </div>

      {(kind === "available" || kind === "checking") && blocks.length > 0 && (
        <div className="update-pop-notes" data-testid="update-pop-notes">
          {blocks.map((b, i) =>
            b.kind === "heading" ? (
              <div key={i} className="update-pop-h">
                {b.text}
              </div>
            ) : b.kind === "bullet" ? (
              <div key={i} className="update-pop-li">
                {b.text}
              </div>
            ) : (
              <p key={i} className="update-pop-p">
                {b.text}
              </p>
            ),
          )}
        </div>
      )}

      {kind === "downloading" && (
        <div className="update-pop-progress" data-testid="update-pop-progress">
          <div className="update-pop-bar" aria-hidden>
            <div
              className="update-pop-bar-fill"
              data-indeterminate={pct == null ? "true" : undefined}
              style={pct == null ? undefined : { ["--progress" as string]: pct / 100 }}
            />
          </div>
          <span className="update-pop-progress-text">
            {pct != null && phase.total != null
              ? t("update.panelProgress", {
                  received: Math.round(phase.received / 1024),
                  total: Math.round(phase.total / 1024),
                  pct,
                })
              : t("update.downloading")}
          </span>
        </div>
      )}

      {kind === "installed" && (
        <p className="update-pop-p" data-testid="update-pop-installed">
          {t("update.installed")}
        </p>
      )}

      {kind === "error" && (
        <p className="form-error update-pop-error" data-testid="update-pop-error">
          {phase.message}
        </p>
      )}

      <div className="update-pop-actions">
        {kind === "installed" ? (
          <>
            <button type="button" data-testid="update-pop-later" onClick={onClose}>
              {t("update.later")}
            </button>
            <button
              type="button"
              className="btn-accent"
              data-testid="update-pop-restart"
              onClick={restartNow}
            >
              {t("update.restartNow")}
            </button>
          </>
        ) : (
          <>
            {githubLink}
            {kind === "available" && (
              <button
                type="button"
                className="btn-accent"
                data-testid="update-pop-install"
                onClick={() => void downloadAndInstall()}
              >
                {t("update.downloadInstall")}
              </button>
            )}
            {kind === "error" && (
              <button
                type="button"
                className="btn-accent"
                data-testid="update-pop-retry"
                onClick={() => void checkForUpdate()}
              >
                {t("update.retry")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
