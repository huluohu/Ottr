// Toast 渲染宿主（App 挂载一次）：右下角堆叠，不抢焦点、自动消失。
import { useToastStore } from "./toastStore";

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" data-testid="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          data-testid={`toast-${t.id}`}
          onClick={() => useToastStore.getState().dismiss(t.id)}
        >
          <span className="toast-message">{t.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="✕"
            onClick={(e) => {
              e.stopPropagation();
              useToastStore.getState().dismiss(t.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
