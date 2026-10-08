// 终端对话框与提示条（自 Terminal.tsx 拆出，2026-10-08 遗留项②）：
// 粘贴确认 / 编码提示 / 危险输入提醒 / trzsz 拖放询问 + 路径引用纯函数。
// 公共 API 经 Terminal.tsx 再导出保持原路径不变。
import { useTranslation } from "react-i18next";
import { useSessionStore, encodingName } from "../session/SessionStore";
import { assessPaste, type DangerFinding } from "../ai/danger";

/** 粘贴确认弹层（导出供组件测试；verdict 由 assessPaste 现算——纯函数单源）。 */
export function PasteConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const verdict = assessPaste(text);
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return (
    <div className="overlay paste-confirm" role="dialog" aria-modal="true" aria-label={t("terminal.pasteTitle")}>
      <div className="dialog paste-dialog" data-testid="paste-confirm">
        <h2>{t("terminal.pasteTitle")}</h2>
        {verdict.findings.length > 0 && (
          <>
            <p className="paste-warning">{t("terminal.pasteDanger")}</p>
            <ul className="paste-findings" data-testid="paste-findings">
              {verdict.findings.map((f) => (
                <li key={f.kind}>
                  <code>{f.excerpt}</code>
                  {" — "}
                  {t(`ai.danger.${f.kind}`, { defaultValue: f.kind })}
                </li>
              ))}
            </ul>
          </>
        )}
        {verdict.multiline && <p>{t("terminal.pasteMultiline")}</p>}
        <pre data-testid="paste-preview">{preview}</pre>
        <div className="form-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className={verdict.level === "danger" ? "btn-danger" : "btn-accent"}
            data-testid="paste-confirm-button"
            onClick={onConfirm}
          >
            {t("terminal.pasteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 编码检测提示条（Task 9，A9）：Rust detect_hint 命中 GBK 家族后展示
 * 「检测到 GBK 编码，切换？」；「切换」= acceptEncodingHint（切编码 + 同 host
 * 记一次性可关），「忽略」= dismissEncodingHint。 */
export function EncodingHintBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const hint = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.encodingHint ?? null,
  );
  if (!hint) return null;
  return (
    <div className="encoding-hint" data-testid="encoding-hint" role="status">
      <span className="encoding-hint-text">
        {t("terminal.encodingHint", { encoding: encodingName(hint) })}
      </span>
      <button
        className="encoding-hint-accept"
        data-testid="encoding-hint-accept"
        onClick={() => useSessionStore.getState().acceptEncodingHint(sessionId)}
      >
        {t("terminal.encodingHintAccept", { encoding: encodingName(hint) })}
      </button>
      <button
        className="encoding-hint-dismiss"
        aria-label={t("terminal.encodingHintDismiss")}
        data-testid="encoding-hint-dismiss"
        onClick={() => useSessionStore.getState().dismissEncodingHint(sessionId)}
      >
        ×
      </button>
    </div>
  );
}

/** 危险输入提醒条（Phase 2 Task 11，B11）：当前输入行命中 danger red/yellow
 * 档时行内提示（限频由 InputDangerWatch 管）；回车执行/手动关闭即撤。 */
export function DangerHintBar({
  finding,
  onDismiss,
}: {
  finding: DangerFinding;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="danger-hint" data-testid="danger-hint" role="alert">
      <span className="danger-hint-title">{t("terminal.dangerInputTitle")}</span>
      <span className="danger-hint-text">
        {t("terminal.dangerInputHint", {
          rule: t(`ai.danger.${finding.kind}`, { defaultValue: finding.kind }),
          excerpt: finding.excerpt,
        })}
      </span>
      <button
        data-testid="danger-hint-dismiss"
        aria-label={t("terminal.dangerInputDismiss")}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

/** 终端区拖拽落点对话框（Phase 2 Task 4，B10 下半）：文件拖入终端 pane 后询问
 * 「trz 上传」（TrzszController.uploadFiles，远端须装 trzsz）或「插入路径」
 * （单引号转义后 term.paste，与 SFTP 上传无关的纯文本插入）。 */
export function TrzszDropDialog({
  paths,
  onUpload,
  onInsert,
  onCancel,
}: {
  paths: string[];
  onUpload: () => void;
  onInsert: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const names = paths.map((p) => p.split("/").pop() ?? p).join("、");
  return (
    <div className="overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="dialog trzsz-drop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("terminal.trzszDropAria")}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="trzsz-drop-dialog"
      >
        <h2>{t("terminal.trzszDropTitle")}</h2>
        <p data-testid="trzsz-drop-files">{t("terminal.trzszDropHint", { count: paths.length, names })}</p>
        <div className="form-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button data-testid="trzsz-drop-insert" onClick={onInsert}>
            {t("terminal.trzszDropInsert")}
          </button>
          <button className="btn-accent" data-testid="trzsz-drop-upload" onClick={onUpload}>
            {t("terminal.trzszDropUpload")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 拖拽路径 → shell 安全插入形态（单引号包裹，内部 ' 转义为 '\''）。 */
export function quotePathsForShell(paths: string[]): string {
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
}

