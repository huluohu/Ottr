// DialogClose（2026-10-14 用户反馈）：对话框右上关闭钮的统一形态——
// 放大的 ✕（32px 命中面）+ 左侧「Esc 关闭」键帽提示（行业惯例：Raycast/
// Linear/Arc 一族都用 kbd 键帽标注 esc 语义）。所有走 useEscClose 的弹框
// 语义一致：Esc = ✕ 同一 onClose。
import { useTranslation } from "react-i18next";

interface DialogCloseProps {
  onClose: () => void;
  /** 测试锚点（沿用各弹框既有 testid，防测试面漂移）。 */
  testid?: string;
  /** 悬停提示（如在途任务「关闭将放弃」等提示）。 */
  title?: string;
}

export function DialogClose({ onClose, testid, title }: DialogCloseProps) {
  const { t } = useTranslation();
  return (
    <span className="dialog-close-group">
      <span className="dialog-esc-hint" aria-hidden="true">
        <kbd>Esc</kbd>
        {t("common.close")}
      </span>
      <button
        type="button"
        className="dialog-close"
        data-testid={testid}
        aria-label={t("common.close")}
        title={title}
        onClick={onClose}
      >
        ✕
      </button>
    </span>
  );
}
