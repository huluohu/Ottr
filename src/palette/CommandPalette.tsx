// CommandPalette（A12，Task 14）：⌘K/Ctrl+K 命令面板——命令 + 主机统一模糊搜索。
//
// T5↔T14 台账裁定的收口：QuickConnect（⌘K 雏形）重命名并入本组件——主机数据源
// 改由父层直供（vault store 全量在内存，无需 IPC/防抖），搜索语义由 Rust FTS
// 换成客户端模糊（fuzzy.ts），并扩全命令（registry.ts ACTIONS）。
//
// 交互：输入即过滤（命令区 + 主机区两段，扁平 activeIndex 连续导航），↑↓ 循环、
// Enter 执行、Esc 关闭、点击遮罩关闭；命中字符 <mark> 高亮。
// 无虚拟滚动刻意为之（T5 台账同款裁定：条目量级不需要）。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Host } from "../vault/api";
import {
  ACTIONS,
  shortcutLabel,
  type ActionDef,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { fuzzyBest, highlightRanges, type FuzzyResult } from "./fuzzy";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 主机数据源（vault store 全量；空库 = 仅命令区）。 */
  hosts: Host[];
  onConnect: (host: Host) => void;
  onAction: (action: ActionId) => void;
  /** 平台（键位提示口径）；默认自动检测，测试注入。 */
  plat?: Platform;
  /** 命令表；默认 registry ACTIONS（测试可注入缩表）。 */
  actions?: readonly ActionDef[];
}

interface PaletteItem {
  key: string;
  kind: "command" | "host";
  /** 主展示文本（高亮目标）。 */
  label: string;
  subtitle?: string;
  hint?: string | null;
  match: FuzzyResult | null; // 主字段命中（高亮）；次字段命中时为 null（不高亮主字段）
  action?: ActionId;
  host?: Host;
  score: number;
}

/** 主机条目检索字段与权重：名称 > 地址 > 用户名 > 标签。 */
function hostMatch(query: string, host: Host): FuzzyResult | null {
  return fuzzyBest(query, [
    { text: host.name, weight: 1 },
    { text: host.address, weight: 0.8 },
    { text: host.username ?? "", weight: 0.6 },
    { text: host.tags.join(" "), weight: 0.5 },
  ]);
}

/** 高亮切分：命中段 <mark> 包裹（match=null 不切分）。 */
function Highlighted({ text, match }: { text: string; match: FuzzyResult | null }) {
  if (!match || match.indices.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of highlightRanges(match.indices)) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={range.start}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function CommandPalette({
  open,
  onClose,
  hosts,
  onConnect,
  onAction,
  plat = "mac",
  actions = ACTIONS,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // 打开时重置并聚焦（面板反复开关是主路径）。
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 聚焦等首帧渲染完（overlay 挂载后 input 才存在）。
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // 过滤 + 排序（渲染即纯计算：命令区按序在前，主机区按得分降序）。
  const { commandItems, hostItems } = useMemo(() => {
    const q = query.trim();
    const cmds: PaletteItem[] = [];
    if (q.length === 0) {
      for (const def of actions) {
        cmds.push({
          key: `cmd-${def.id}`,
          kind: "command",
          label: t(def.labelKey),
          hint: shortcutLabel(def.id, plat),
          match: null,
          action: def.id,
          score: 0,
        });
      }
    } else {
      for (const def of actions) {
        const label = t(def.labelKey);
        const m = fuzzyBest(q, [
          { text: label, weight: 1 },
          { text: def.id, weight: 0.5 },
        ]);
        if (m) {
          // 主字段（i18n 标签）命中才高亮；id 命中不高亮（英文 id 对用户是噪音）
          const primary = fuzzyBest(q, [{ text: label, weight: 1 }]);
          cmds.push({
            key: `cmd-${def.id}`,
            kind: "command",
            label,
            hint: shortcutLabel(def.id, plat),
            match: primary,
            action: def.id,
            score: m.score,
          });
        }
      }
      cmds.sort((a, b) => b.score - a.score);
    }
    const hsts: PaletteItem[] = [];
    if (q.length === 0) {
      for (const host of hosts) {
        hsts.push({
          key: `host-${host.id}`,
          kind: "host",
          label: host.name,
          subtitle: `${host.username ? `${host.username}@` : ""}${host.address}:${host.port}`,
          match: null,
          host,
          score: 0,
        });
      }
    } else {
      for (const host of hosts) {
        const m = hostMatch(q, host);
        if (m) {
          hsts.push({
            key: `host-${host.id}`,
            kind: "host",
            label: host.name,
            subtitle: `${host.username ? `${host.username}@` : ""}${host.address}:${host.port}`,
            match: fuzzyBest(q, [{ text: host.name, weight: 1 }]),
            host,
            score: m.score,
          });
        }
      }
      hsts.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    }
    return { commandItems: cmds, hostItems: hsts };
  }, [query, actions, hosts, plat, t]);

  const flat = useMemo(() => [...commandItems, ...hostItems], [commandItems, hostItems]);

  // 过滤结果收缩时把光标夹回有效区。
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  // 键盘导航时把活动项滚进可视区（jsdom 无 scrollIntoView，探测后调用）。
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, flat.length]);

  if (!open) return null;

  function runItem(item: PaletteItem | undefined) {
    if (!item) return;
    if (item.kind === "command" && item.action) onAction(item.action);
    else if (item.kind === "host" && item.host) onConnect(item.host);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(flat[activeIndex]);
    }
  }

  function renderItem(item: PaletteItem, idx: number) {
    if (item.kind === "command") {
      return (
        <button
          className="palette-item"
          data-active={idx === activeIndex}
          onMouseEnter={() => setActiveIndex(idx)}
          onClick={() => runItem(item)}
        >
          <span className="host-name">
            <Highlighted text={item.label} match={item.match} />
          </span>
          {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
        </button>
      );
    }
    return (
      <button
        className="palette-item"
        data-active={idx === activeIndex}
        onMouseEnter={() => setActiveIndex(idx)}
        onClick={() => runItem(item)}
      >
        <span className="host-name">
          <Highlighted text={item.label} match={item.match} />
        </span>
        <span className="host-subtitle">{item.subtitle}</span>
      </button>
    );
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} data-testid="command-palette">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.title")}
          data-testid="palette-input"
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <ul className="palette-list" ref={listRef}>
          {flat.length === 0 && <li className="palette-empty">{t("palette.empty")}</li>}
          {commandItems.length > 0 && (
            <li className="palette-section" aria-hidden="true">
              {t("palette.commands")}
            </li>
          )}
          {commandItems.map((item, i) => (
            <li key={item.key}>{renderItem(item, i)}</li>
          ))}
          {hostItems.length > 0 && (
            <li className="palette-section" aria-hidden="true">
              {t("palette.hosts")}
            </li>
          )}
          {hostItems.map((item, i) => (
            <li key={item.key}>{renderItem(item, commandItems.length + i)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
