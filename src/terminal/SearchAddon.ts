// 搜索接线（Task 8，A8）：SearchAddon 的 per-会话控制器 + 模块级注册表。
// 会话（标签/分屏 pane）与控制器同生命周期：SessionTerminal 装配时注册、
// 卸载时注销；搜索栏（TerminalArea）按「活动 pane」的会话 id 取控制器操作。
// 加一层间接的原因：搜索栏在布局树里、终端实例在 pane 里，两者只共享会话 id。
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";

/** 搜索结果摘要（-1 = 命中数超上限或无结果）。 */
export interface SearchResultSummary {
  resultIndex: number;
  resultCount: number;
}

export class SearchController {
  private addon: SearchAddon | null = null;
  /** 最近一次查询词（Enter 循环跳转时复用，无需重输）。 */
  lastQuery: string | null = null;
  lastResult: SearchResultSummary | null = null;

  constructor(private readonly term: XTerm) {}

  private ensure(): SearchAddon | null {
    if (this.addon === null) {
      const addon = new SearchAddon({
        highlightLimit: 500,
      });
      try {
        this.term.loadAddon(addon);
      } catch {
        return null; // 终端已 dispose（竞态）→ 本次搜索落空
      }
      this.addon = addon;
      addon.onDidChangeResults?.((e) => {
        this.lastResult = { resultIndex: e.resultIndex, resultCount: e.resultCount };
      });
    }
    return this.addon;
  }

  private options() {
    return {
      decorations: {
        matchOverviewRuler: "#f59e0b",
        activeMatchColorOverviewRuler: "#14b8a6",
      },
    };
  }

  /** 向下查找。query 为空 / addon 不可用 → false（无操作）。 */
  findNext(query: string): boolean {
    const addon = this.ensure();
    if (!addon || query === "") return false;
    this.lastQuery = query;
    return addon.findNext(query, this.options());
  }

  findPrevious(query: string): boolean {
    const addon = this.ensure();
    if (!addon || query === "") return false;
    this.lastQuery = query;
    return addon.findPrevious(query, this.options());
  }

  /** 关闭搜索：清高亮与选中（输入框的开关由 UI 状态管）。 */
  close(): void {
    if (this.addon) {
      try {
        this.addon.clearDecorations();
      } catch {
        // 已 dispose 竞态，忽略
      }
    }
    try {
      this.term.clearSelection();
    } catch {
      // 同上
    }
  }

  dispose(): void {
    this.addon?.dispose();
    this.addon = null;
  }
}

// --- 注册表（同 SessionStore 的 sinks 形态：非响应式、模块级） ---------------

const controllers = new Map<string, SearchController>();

export function registerSearch(sessionId: string, controller: SearchController): void {
  controllers.set(sessionId, controller);
}
export function unregisterSearch(sessionId: string): void {
  controllers.get(sessionId)?.dispose();
  controllers.delete(sessionId);
}
/** 活动 pane 的会话 id → 控制器（未挂载/已关闭 → undefined，搜索栏禁用）。 */
export function getSearch(sessionId: string): SearchController | undefined {
  return controllers.get(sessionId);
}
