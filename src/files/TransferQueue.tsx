// TransferQueue（Task 10，A5）：传输队列渲染。活动条目进度条 + 取消；
// 失败/取消条目重试（journal 续传）；收尾条目可清除。纯渲染 + store 动作，
// 状态机逻辑在 TransferStore（独立 vitest）。
import { useTranslation } from "react-i18next";
import { fileNameOf, formatBytes } from "./api";
import { sortQueueItems, useTransferStore, type TransferItem } from "./TransferStore";

function statusLabel(item: TransferItem, t: (k: string) => string): string {
  switch (item.status) {
    case "active":
      return item.cancelling ? t("files.queue.cancelling") : t("files.queue.active");
    case "done":
      return t("files.queue.done");
    case "failed":
      return t("files.queue.failed");
    case "cancelled":
      return t("files.queue.cancelled");
  }
}

export function TransferQueue() {
  const { t } = useTranslation();
  const items = useTransferStore((s) => s.items);
  const cancel = useTransferStore((s) => s.cancel);
  const retry = useTransferStore((s) => s.retry);
  const dismiss = useTransferStore((s) => s.dismiss);

  if (items.length === 0) return null;
  const ordered = sortQueueItems(items);

  return (
    <div className="file-queue" data-testid="transfer-queue" aria-label={t("files.queue.title")}>
      <div className="file-queue-title">{t("files.queue.title")}</div>
      {ordered.map((item) => {
        const pct =
          item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0;
        return (
          <div
            key={item.transferId}
            className="queue-item"
            data-testid={`queue-item-${item.transferId}`}
            data-status={item.status}
            title={item.error ?? undefined}
          >
            <span className="queue-kind" aria-hidden>
              {item.kind === "download" ? "↓" : "↑"}
            </span>
            <span className="queue-name" title={item.remotePath}>
              {item.kind === "download"
                ? t("files.queue.downloadOf", { name: fileNameOf(item.remotePath) })
                : t("files.queue.uploadOf", { name: fileNameOf(item.localPath) })}
            </span>
            <div
              className="queue-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="queue-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="queue-meta">
              {formatBytes(item.transferred)}/{formatBytes(item.total)}
            </span>
            <span className={`queue-status`} data-status={item.status}>
              {statusLabel(item, t)}
            </span>
            {item.status === "active" && (
              <button
                className="queue-act"
                disabled={item.cancelling}
                onClick={() => void cancel(item.transferId).catch(() => {})}
                aria-label={t("files.queue.cancelAria", {
                  name: fileNameOf(item.remotePath),
                })}
              >
                {t("common.cancel")}
              </button>
            )}
            {(item.status === "failed" || item.status === "cancelled") && (
              <button
                className="queue-act"
                onClick={() => void retry(item.transferId).catch(() => {})}
                aria-label={t("files.queue.retryAria", { name: fileNameOf(item.remotePath) })}
              >
                {t("common.retry")}
              </button>
            )}
            {item.status !== "active" && (
              <button
                className="queue-act"
                onClick={() => dismiss(item.transferId)}
                aria-label={t("files.queue.dismissAria", { name: fileNameOf(item.remotePath) })}
              >
                {t("common.close")}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
