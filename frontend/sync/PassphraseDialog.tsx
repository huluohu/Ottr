// 信封口令弹框（2026-10-29 用户需求：「设置口令改为类似立即同步那种弹出的，
// 而不是展开」）。
//
// 与「立即同步」弹框同款：叠在设置页之上、设置页不被顶掉、Esc / ✕ 关闭。
// 落盘位置 = document.body：设置壳入场/退场动画带 transform，fixed 子元素
// 留在壳内会被当成相对该壳定位（与 SyncDialog 同一坑，PR #23 已踩过）。
//
// 文案全部复用既有键（sync.passphrase.*），不新增 i18n 键。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useEscClose } from "../ui/useEscClose";
import { DialogClose } from "../ui/DialogClose";

export interface PassphraseDialogProps {
  open: boolean;
  /** 已有口令 = 改口令模式（标题/按钮文案随之变）。 */
  hasPassphrase: boolean;
  /** 保存：成功即关框；失败抛错（错误原文在框内呈现）。 */
  onSave: (passphrase: string) => Promise<void>;
  onClose: () => void;
}

export function PassphraseDialog({
  open,
  hasPassphrase,
  onSave,
  onClose,
}: PassphraseDialogProps) {
  const { t } = useTranslation();
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开清空上次输入与错误（改口令时残留旧口令是误导）
  useEffect(() => {
    if (!open) return;
    setP1("");
    setP2("");
    setErr(null);
    setBusy(false);
  }, [open]);

  // Esc = ✕（栈式：只收栈顶，本框叠在设置之上时先关本框）
  useEscClose(open, onClose);

  if (!open) return null;

  const title = hasPassphrase ? t("sync.passphrase.change") : t("sync.passphrase.set");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (p1 === "") {
      setErr(t("sync.passphrase.errEmpty"));
      return;
    }
    if (p1 !== p2) {
      setErr(t("sync.passphrase.errMismatch"));
      return;
    }
    setBusy(true);
    try {
      await onSave(p1);
      // 成功：父级负责关框与复位徽标
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErr(t("sync.errSave", { message }));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="overlay overlay-stacked"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="passphrase-dialog"
    >
      <div className="dialog pass-dialog">
        <div className="dialog-head">
          <h2>{title}</h2>
          <DialogClose onClose={onClose} testid="passphrase-dialog-close" />
        </div>
        <form className="pass-form" onSubmit={(e) => void submit(e)} noValidate data-testid="sync-passphrase-form">
          <label>
            <span>{t("sync.passphrase.new")}</span>
            <input
              type="password"
              data-testid="sync-passphrase-new"
              autoComplete="new-password"
              value={p1}
              onChange={(e) => setP1(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t("sync.passphrase.confirm")}</span>
            <input
              type="password"
              data-testid="sync-passphrase-confirm"
              autoComplete="new-password"
              value={p2}
              onChange={(e) => setP2(e.currentTarget.value)}
            />
          </label>
          {err !== null && (
            <p className="form-error" data-testid="sync-passphrase-error">
              {err}
            </p>
          )}
          <p className="settings-hint">
            {hasPassphrase ? t("sync.passphrase.changeHint") : t("sync.passphrase.hint")}
          </p>
          <div className="form-actions">
            <button type="button" data-testid="sync-passphrase-cancel" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              className="btn-accent"
              data-testid="sync-passphrase-submit"
              disabled={busy}
            >
              {title}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
