// HistorySearch（Task 15，spec §5 文本层消费方③）：⌘R 统一历史搜索面板。
//
// 「历史」页签：消费 history 表（跨主机「在哪跑过 docker logs」）：查询框
// （FTS trigram / LIKE 兜底在 Rust 层分派，前端免分派）+ host 过滤下拉 +
// 结果列表（命令预览 / 主机名 / 退出码徽标 / 时间）。回车 = 命令插入当前
// 聚焦终端（onInsert 上抛，App 侧剥提示符 + write_session 不带回车——T13
// 惯例，落在输入行由用户确认执行）。
//
// 「纪要」页签（Phase 2 Task 7，B1）：消费 session_summaries 表（会话收尾时
// AI 自动生成的纪要，密文存储、list 单点出库）：列表（主机 / 时间 / 命令数
// 徽标 / 摘要全文）——只读复盘面，无插入语义（Enter 不动作）。
//
// 骨架复用 CommandPalette 的 overlay/交互范式：↑↓ 循环导航、Enter 执行（仅
// 历史页签）、Esc 关闭、点击遮罩关闭；搜索走 vaultApi.history.search（防抖
// 200ms，同 HostTree 搜索惯例）；无虚拟滚动刻意为之（T5 台账：条目量级不需要）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Host, HistoryEntry, SummaryEntry } from "../vault/api";
import { vaultApi } from "../vault/api";
import { useDebouncedValue } from "../hosts/useDebouncedValue";
import { historyPreview, historyTime } from "./format";
import { shortcutLabel } from "../shortcuts/registry";
import type { Platform } from "../shortcuts/registry";

export interface HistorySearchProps {
  open: boolean;
  onClose: () => void;
  /** 主机映射源（host_id → 主机名；vault store 全量）。 */
  hosts: Host[];
  /** 回车选定：上抛**原样入库文本**（提示符剥离在 App 侧写终端前做）。 */
  onInsert: (command: string) => void;
  /** 平台（键位提示口径）；测试注入。 */
  plat?: Platform;
}

/** 面板页签（历史命令 / 会话纪要）。 */
export type HistoryPanelTab = "history" | "summaries";

/** 退出码徽标的语义类（0 = 成功 / 非 0 = 失败 / null = 未上报）。 */
export function exitBadgeClass(exitCode: number | null): string {
  if (exitCode === null) return "history-badge exit-none";
  return exitCode === 0 ? "history-badge exit-ok" : "history-badge exit-fail";
}

export function HistorySearch({
  open,
  onClose,
  hosts,
  onInsert,
  plat = "mac",
}: HistorySearchProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<HistoryPanelTab>("history");
  const [query, setQuery] = useState("");
  const [hostId, setHostId] = useState<number | null>(null);
  const [results, setResults] = useState<HistoryEntry[]>([]);
  const [summaries, setSummaries] = useState<SummaryEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 键入防抖 200ms（同 HostTree 搜索惯例）；host 过滤即切即查。
  const debouncedQuery = useDebouncedValue(query, 200);

  // 打开时重置并聚焦 + 立即拉最近记录（面板初始态 = 空 query 历史页签）。
  useEffect(() => {
    if (open) {
      setTab("history");
      setQuery("");
      setHostId(null);
      setActiveIndex(0);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    if (tab === "history") {
      void vaultApi.history
        .search(debouncedQuery, hostId, 50)
        .then((rows) => {
          // 异形响应（后端降级/代理层注入）按空处理，不白屏
          if (alive) setResults(Array.isArray(rows) ? rows : []);
        })
        .catch(() => {
          // 检索失败（后端不可达等）：空结果，不阻塞面板
          if (alive) setResults([]);
        });
    } else {
      void vaultApi.summaries
        .list(hostId, 50)
        .then((rows) => {
          if (alive) setSummaries(Array.isArray(rows) ? rows : []);
        })
        .catch(() => {
          if (alive) setSummaries([]);
        });
    }
    return () => {
      alive = false;
    };
  }, [open, tab, debouncedQuery, hostId]);

  // 结果收缩时把光标夹回有效区。
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const hostName = (id: number): string =>
    hosts.find((h) => h.id === id)?.name ?? t("history.unknownHost");

  function runItem(entry: HistoryEntry | undefined) {
    if (!entry) return;
    onInsert(entry.command);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && tab === "history") {
      e.preventDefault();
      runItem(results[activeIndex]);
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} data-testid="history-search">
      <div
        className="palette history"
        role="dialog"
        aria-modal="true"
        aria-label={t("history.title")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="history-toolbar">
          <div className="history-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className="history-tab"
              data-active={tab === "history"}
              aria-selected={tab === "history"}
              data-testid="history-tab"
              onClick={() => {
                setTab("history");
                setActiveIndex(0);
              }}
            >
              {t("history.tabHistory")}
            </button>
            <button
              type="button"
              role="tab"
              className="history-tab"
              data-active={tab === "summaries"}
              aria-selected={tab === "summaries"}
              data-testid="summary-tab"
              onClick={() => {
                setTab("summaries");
                setActiveIndex(0);
              }}
            >
              {t("history.tabSummaries")}
            </button>
          </div>
          {tab === "history" && (
            <input
              ref={inputRef}
              className="palette-input"
              value={query}
              placeholder={t("history.placeholder")}
              aria-label={t("history.title")}
              data-testid="history-input"
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setActiveIndex(0);
              }}
            />
          )}
          <select
            className="history-select"
            aria-label={t("history.hostFilter")}
            data-testid="history-host-filter"
            value={hostId ?? ""}
            onChange={(e) => {
              setHostId(e.currentTarget.value === "" ? null : Number(e.currentTarget.value));
              setActiveIndex(0);
            }}
          >
            <option value="">{t("history.hostAll")}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        {tab === "history" ? (
          <ul className="palette-list" data-testid="history-list">
            {results.length === 0 && <li className="palette-empty">{t("history.empty")}</li>}
            {results.map((entry, i) => (
              <li key={entry.id}>
                <button
                  className="palette-item history-item"
                  data-active={i === activeIndex}
                  data-testid="history-item"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => runItem(entry)}
                >
                  <span className="history-main">
                    <code className="history-cmd" title={entry.command}>
                      {historyPreview(entry.command)}
                    </code>
                    <span className="history-meta">
                      <span className="history-host">{hostName(entry.host_id)}</span>
                      <span className={exitBadgeClass(entry.exit_code)} data-testid="history-exit">
                        {entry.exit_code ?? "—"}
                      </span>
                      <span className="history-time">{historyTime(entry.ts)}</span>
                    </span>
                  </span>
                  <kbd className="palette-hint">{shortcutLabel("history.search", plat)}</kbd>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="palette-list" data-testid="summary-list">
            {summaries.length === 0 && (
              <li className="palette-empty">{t("history.emptySummaries")}</li>
            )}
            {summaries.map((entry) => (
              <li key={entry.id}>
                <div className="palette-item summary-item" data-testid="summary-item">
                  <span className="summary-text">{entry.summary}</span>
                  <span className="history-meta">
                    <span className="history-host">{hostName(entry.host_id)}</span>
                    <span className="history-badge exit-none" data-testid="summary-count">
                      {t("history.commands", { count: entry.command_count })}
                    </span>
                    <span className="history-time">{historyTime(entry.ts)}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {tab === "history" && <div className="history-hint">{t("history.insertHint")}</div>}
      </div>
    </div>
  );
}
