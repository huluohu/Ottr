// Toast 渲染宿主（App 挂载一次）：右下角堆叠，不抢焦点、自动消失。
import { useTranslation } from "react-i18next";
import { useToastStore } from "./toastStore";

export function Toaster() {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" data-testid="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          data-testid={`toast-${toast.id}`}
          onClick={() => useToastStore.getState().dismiss(toast.id)}
        >
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label={t("common.close")}
            onClick={(e) => {
              e.stopPropagation();
              useToastStore.getState().dismiss(toast.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
