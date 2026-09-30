// QuickConnect（Task 5 ⌘K 面板雏形）：主机模糊搜索 + 键盘选择。
// 台账裁定 T5↔T14：本组件即命令面板的 host 数据源，Task 14 扩全命令时
// 重命名并入 palette——刻意不做命令注册表/虚拟滚动等过度建设。
// 搜索语义复用 Rust 层分派（空查询全量、≥3 字符 FTS、<3 字符 LIKE）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type Host } from "../vault/api";
import { useDebouncedValue } from "./useDebouncedValue";

export interface QuickConnectProps {
  open: boolean;
  onClose: () => void;
  onSelect: (host: Host) => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function QuickConnect({ open, onClose, onSelect }: QuickConnectProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [results, setResults] = useState<Host[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  // 打开时聚焦并重置（palette 反复开关是主路径）
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    vaultApi.hosts
      .search(debounced.trim())
      .then((rows) => {
        if (searchSeq.current === seq) {
          setResults(rows);
          setActiveIndex(0);
        }
      })
      .catch(() => {
        if (searchSeq.current === seq) setResults([]);
      });
  }, [debounced, open]);

  if (!open) return null;

  function select(host: Host | undefined) {
    if (!host) return;
    onSelect(host);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(results[activeIndex]);
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} data-testid="quick-connect">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("quickConnect.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={t("quickConnect.placeholder")}
          aria-label={t("quickConnect.title")}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="palette-list">
          {results.length === 0 && <li className="palette-empty">{t("quickConnect.empty")}</li>}
          {results.map((host, idx) => (
            <li key={host.id}>
              <button
                className="palette-item"
                data-active={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => select(host)}
              >
                <span className="host-name">{host.name}</span>
                <span className="host-subtitle">
                  {host.username ? `${host.username}@` : ""}
                  {host.address}:{host.port}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
