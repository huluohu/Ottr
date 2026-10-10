// CommandPalette（A12，Task 14）：⌘K/Ctrl+K 命令面板——命令 + 主机统一模糊搜索。
//
// T5↔T14 台账裁定的收口：QuickConnect（⌘K 雏形）重命名并入本组件——主机数据源
// 改由父层直供（vault store 全量在内存，无需 IPC/防抖），搜索语义由 Rust FTS
// 换成客户端模糊（fuzzy.ts），并扩全命令（registry.ts ACTIONS）。
//
// 交互：输入即过滤（命令区 + 主机区两段，扁平 activeIndex 连续导航），↑↓ 循环、
// Enter 执行、Esc 关闭、点击遮罩关闭；命中字符 <mark> 高亮。
// 无虚拟滚动刻意为之（T5 台账同款裁定：条目量级不需要）。
//
// 【UI 批次三 T2（审计 ⌘K 19/20）】命令区按语义分三组（连接与会话 / 面板与 AI /
// 系统），空查询（浏览态）显示组节标题、条目按组聚拢；过滤态退扁平相关度排序
// （组标题隐藏——检索时相关性优先于分类）。每条目带类型图标（命令/主机两型
// 内联 SVG，stroke currentColor 随主题）。分组是展示层裁定，收在面板本地：
// registry 是键位单一来源（T14 纪律），菜单/汉堡渲染不受影响。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Host } from "../vault/api";
import { useDelayedUnmount } from "../ui/useDelayedUnmount";
import {
  ACTIONS,
  shortcutLabel,
  type ActionDef,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { FEATURE_COMMANDS } from "../shortcuts/toolsRegistry";
import { fuzzyBest, highlightRanges, type FuzzyResult } from "./fuzzy";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 主机数据源（vault store 全量；空库 = 仅命令区）。 */
  hosts: Host[];
  onConnect: (host: Host) => void;
  onAction: (action: string) => void;
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
  action?: string;
  host?: Host;
  score: number;
}

/** 命令子组（批次三 T2）：语义三分——连接类（主机/会话操作）、面板类（三个
 * 呼出面板）、系统类（设置/外观/安全/退出）。组序 = 展示序；组内保持 registry
 * 顺序。未知 id（测试注入缩表/未来新增未归组）回落 system，不炸渲染。 */
const COMMAND_GROUPS: readonly { id: "connection" | "panels" | "system"; ids: readonly ActionId[] }[] = [
  { id: "connection", ids: ["hosts.new", "session.splitRight", "session.splitDown"] },
  { id: "panels", ids: ["palette.toggle", "history.search", "ai.nl2cmd"] },
  {
    id: "system",
    ids: ["settings.open", "theme.toggle", "lang.toggle", "vault.lock", "app.quit"],
  },
];

function groupOf(action: ActionId): "connection" | "panels" | "system" {
  for (const g of COMMAND_GROUPS) {
    if (g.ids.includes(action)) return g.id;
  }
  return "system";
}

/** 空查询（浏览态）的命令行模型：组节标题与条目交错，flat = 扁平导航下标。 */
type CommandRow =
  | { kind: "section"; key: string; label: string }
  | { kind: "item"; key: string; item: PaletteItem; flat: number };

/** 条目类型图标（内联 SVG，stroke currentColor 随主题；decorative——节标题已
 * 有语义文本，aria 隐藏）。unicode 备选因跨平台字形不一致弃用。 */
function PaletteIcon({ type }: { type: "command" | "host" }) {
  return type === "command" ? (
    <svg
      className="palette-icon"
      data-icon="command"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {/* 终端提示符：方框 + >_ */}
      <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" />
      <path
        d="M4 4.8L6.2 7 4 9.2M7.6 9.4h2.4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      className="palette-icon"
      data-icon="host"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {/* 服务器：两段机箱 + 指示点 */}
      <rect x="1.5" y="2" width="11" height="4.2" rx="1.2" fill="none" stroke="currentColor" />
      <rect x="1.5" y="7.8" width="11" height="4.2" rx="1.2" fill="none" stroke="currentColor" />
      <circle cx="3.9" cy="4.1" r="0.9" fill="currentColor" />
      <circle cx="3.9" cy="9.9" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** 主机条目检索字段与权重：名称 > 地址 > 备注 > 用户名 > 标签。
 *  备注（notes）2026-10-10 并入——侧栏树内搜索框移除后其「按备注找主机」
 *  能力由全局搜索承接（用户裁定：查找统一走 ⌘K）。 */
function hostMatch(query: string, host: Host): FuzzyResult | null {
  return fuzzyBest(query, [
    { text: host.name, weight: 1 },
    { text: host.address, weight: 0.8 },
    { text: host.notes ?? "", weight: 0.7 },
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

  // 过滤 + 排序（渲染即纯计算）：空查询 = 浏览态（命令按组聚拢，registry 序）；
  // 有查询 = 过滤态（命令/主机各按得分降序扁平排，组语义让位相关性）。
  const { commandItems, commandRows, hostItems } = useMemo(() => {
    const q = query.trim();
    const cmds: PaletteItem[] = [];
    if (q.length === 0) {
      // 浏览态：按组序展出（groupOf 全函数兜底——未知 id 落 system，条目恒齐全）
      for (const g of COMMAND_GROUPS) {
        for (const def of actions) {
          if (groupOf(def.id) !== g.id) continue;
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
      }
      // 工具组（2026-10-10 IA 重构）：dock 面板/视图/对话框命令统一入面板
      for (const f of FEATURE_COMMANDS) {
        cmds.push({
          key: `tool-${f.id}`,
          kind: "command",
          label: t(f.labelKey),
          hint: null,
          match: null,
          action: f.id,
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
      for (const f of FEATURE_COMMANDS) {
        const label = t(f.labelKey);
        const m = fuzzyBest(q, [{ text: label, weight: 1 }]);
        if (m) {
          cmds.push({
            key: `tool-${f.id}`,
            kind: "command",
            label,
            hint: null,
            match: m,
            action: f.id,
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
    // 浏览态再补组节标题行（过滤态无行模型——扁平渲染）；flat 下标与命令区
    // 渲染序一致（cmds 已按组序构建），主机区接着命令区连续编号。
    const rows: CommandRow[] = [];
    if (q.length === 0) {
      let cursor = 0;
      for (const g of COMMAND_GROUPS) {
        const inGroup = cmds.filter(
          (c) => c.action !== undefined && groupOf(c.action as ActionId) === g.id && !c.key.startsWith("tool-"),
        );
        if (inGroup.length === 0) continue;
        rows.push({ kind: "section", key: `grp-${g.id}`, label: t(`palette.group_${g.id}`) });
        for (const item of inGroup) {
          rows.push({ kind: "item", key: item.key, item, flat: cursor++ });
        }
      }
      const tools = cmds.filter((c) => c.key.startsWith("tool-"));
      if (tools.length > 0) {
        rows.push({ kind: "section", key: "grp-tools", label: t("palette.group_tools") });
        for (const item of tools) {
          rows.push({ kind: "item", key: item.key, item, flat: cursor++ });
        }
      }
    }
    return { commandItems: cmds, commandRows: rows, hostItems: hsts };
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

  // 退场动画窗（评审 P1-8）：open=false 后保留挂载播镜像动画，再真卸载。
  const mount = useDelayedUnmount(open);
  if (!mount.shouldRender) return null;

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
    const icon = <PaletteIcon type={item.kind} />;
    if (item.kind === "command") {
      return (
        <button
          className="palette-item"
          data-active={idx === activeIndex}
          onMouseEnter={() => setActiveIndex(idx)}
          onClick={() => runItem(item)}
        >
          {icon}
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
        {icon}
        <span className="host-name">
          <Highlighted text={item.label} match={item.match} />
        </span>
        <span className="host-subtitle">{item.subtitle}</span>
      </button>
    );
  }

  return (
    <div
      className={`palette-overlay${mount.closing ? " closing" : ""}`}
      onMouseDown={onClose}
      data-testid="command-palette"
    >
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
          {/* 浏览态（rows 模型）下「命令」总头与组节头相邻会出现空总头——
              组节头已承载结构，总头仅在过滤态扁平列表时渲染（评审 P0-4）。 */}
          {commandItems.length > 0 && commandRows.length === 0 && (
            <li className="palette-section" aria-hidden="true">
              {t("palette.commands")}
            </li>
          )}
          {/* 浏览态：组节标题与条目交错（行模型）；过滤态：扁平相关度序 */}
          {(commandRows.length > 0
            ? commandRows.map((row) =>
                row.kind === "section" ? (
                  <li key={row.key} className="palette-section palette-subsection" aria-hidden="true">
                    {row.label}
                  </li>
                ) : (
                  <li key={row.key}>{renderItem(row.item, row.flat)}</li>
                ),
              )
            : commandItems.map((item, i) => <li key={item.key}>{renderItem(item, i)}</li>)
          )}
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
