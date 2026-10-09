// 终端搜索栏（自 Terminal.tsx 拆出）：⌘F 面板，操作「聚焦 pane」的会话。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../session/SessionStore";
import { getSearch, type SearchResultSummary } from "./SearchAddon";

export function SearchBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<SearchResultSummary | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function doSearch(dir: "next" | "prev") {
    if (query === "") return;
    const ctrl = getSearch(sessionId);
    if (!ctrl) return;
    const found = dir === "next" ? ctrl.findNext(query) : ctrl.findPrevious(query);
    setSummary(
      ctrl.lastResult ?? (found ? null : { resultIndex: -1, resultCount: 0 }),
    );
  }

  function close() {
    getSearch(sessionId)?.close();
    useSessionStore.getState().openSearch(null);
  }

  return (
    <div className="search-bar" data-testid="search-bar" role="search">
      <input
        ref={inputRef}
        value={query}
        placeholder={t("terminal.searchPlaceholder")}
        data-testid="search-input"
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            doSearch(e.shiftKey ? "prev" : "next");
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <button data-testid="search-prev" aria-label={t("terminal.searchPrev")} onClick={() => doSearch("prev")}>
        ↑
      </button>
      <button data-testid="search-next" aria-label={t("terminal.searchNext")} onClick={() => doSearch("next")}>
        ↓
      </button>
      <span className="search-count" data-testid="search-count">
        {summary === null
          ? ""
          : summary.resultCount > 0 && summary.resultIndex >= 0
            ? `${summary.resultIndex + 1}/${summary.resultCount}`
            : t("terminal.searchNoResult")}
      </span>
      <button data-testid="search-close" aria-label={t("common.close")} onClick={close}>
        ✕
      </button>
    </div>
  );
}
