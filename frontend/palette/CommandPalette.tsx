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
import { useEscClose } from "../ui/useEscClose";
import {
  ACTIONS,
  shortcutLabel,
  type ActionDef,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { FEATURE_COMMANDS } from "../shortcuts/toolsRegistry";
import { THEME_IDS } from "../theme/ThemeContext";
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

/** 命令子组（批次三 T2；2026-10-18 入口审计重整）：语义三分——连接类（主机/
 * 会话操作）、面板类（呼出面板）、系统类（设置/安全/窗口）。组序 = 展示序；
 * 组内保持 registry 顺序。未知 id（测试注入缩表/未来新增未归组）回落 system。
 * 【2026-10-18 审计裁定】palette.toggle（面板列自己=自指噪音）与 app.quit
 * （破坏性动作不进模糊搜索直达面；菜单/托盘/汉堡仍可达）不出现在面板。 */
const COMMAND_GROUPS: readonly { id: "connection" | "panels" | "system"; ids: readonly ActionId[] }[] = [
  {
    id: "connection",
    ids: [
      "hosts.new",
      "hosts.new_group",
      "hosts.import",
      "session.splitRight",
      "session.splitDown",
      "session.tabNext",
      "session.tabPrev",
    ],
  },
  { id: "panels", ids: ["history.search", "ai.nl2cmd", "notify.center"] },
  {
    id: "system",
    ids: ["settings.open", "vault.lock", "app.closeWindow", "app.toggleFullscreen", "view.zoomIn", "view.zoomOut", "view.zoomReset"],
  },
];

/** 不入面板的注册表动作（审计裁定，见 COMMAND_GROUPS 注释）。 */
const PALETTE_EXCLUDED: readonly ActionId[] = ["palette.toggle", "app.quit", "theme.toggle", "lang.toggle"];

function groupOf(action: ActionId): "connection" | "panels" | "system" {
  for (const g of COMMAND_GROUPS) {
    if (g.ids.includes(action)) return g.id;
  }
  return "system";
}

/** 外观区（2026-10-18 审计：theme/lang 的「循环切换」语义与搜索期望错位——
 * 列具体项让用户挑，不逼人轮播）。动作字面量与 mac 视图菜单/设置页同源：
 * theme.set.<id> 前缀直派 setMode；lang.set.<locale> 直派 setLang。
 * 标签复用设置页词典（settings.themes.* / settings.langZh/langEn）。 */
const APPEARANCE_COMMANDS: readonly { key: string; labelKey: string; action: string }[] = [
  // 主题条目 = THEME_IDS 派生（registry 单源）；语言条目仍手写（两键固定）。
  ...THEME_IDS.map((id) => ({
    key: `theme-${id}`,
    labelKey: `settings.themes.${id}`,
    action: `theme.set.${id}`,
  })),
  { key: "lang-zh", labelKey: "settings.langZh", action: "lang.set.zh-CN" },
  { key: "lang-hant", labelKey: "settings.langHant", action: "lang.set.zh-Hant" },
  { key: "lang-en", labelKey: "settings.langEn", action: "lang.set.en-US" },
];

/** FEATURE_COMMANDS 里与 ACTIONS 重复的条目（面板去重：同一动作只出现一次）。
 * notify.center 两表都有；tool.import-hosts 与 hosts.import 打开同一对话框。 */
const FEATURE_DUPLICATES: readonly string[] = ["notify.center", "tool.import-hosts"];

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
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    // 聚焦等首帧渲染完（overlay 挂载后 input 才存在）。queueMicrotask 的一次
    // 性 focus() 在 WKWebView（macOS 窗口）会被吞——2026-10-13 用户实测 ⌘K
    // 打开后光标不在输入框。改 rAF 连帧重试：命中 activeElement 即停（至多
    // 10 帧，正常 1-2 帧内命中），卸载/关闭时取消。
    let raf = 0;
    let tries = 0;
    const tick = () => {
      if (document.activeElement === inputRef.current) return;
      inputRef.current?.focus();
      tries += 1;
      if (tries < 10) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
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
          if (PALETTE_EXCLUDED.includes(def.id)) continue;
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
      // 外观区（2026-10-18 审计）：主题七选 + 语言二选，列具体项不轮播
      for (const a of APPEARANCE_COMMANDS) {
        cmds.push({
          key: `app-${a.key}`,
          kind: "command",
          label: t(a.labelKey),
          hint: null,
          match: null,
          action: a.action,
          score: 0,
        });
      }
      // 工具组（2026-10-10 IA 重构）：dock 面板/视图/对话框命令统一入面板；
      // 与 ACTIONS 重复的条目跳过（2026-10-18 审计：通知中心/导入主机曾双份）
      for (const f of FEATURE_COMMANDS) {
        if (FEATURE_DUPLICATES.includes(f.id)) continue;
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
        if (PALETTE_EXCLUDED.includes(def.id)) continue;
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
        if (FEATURE_DUPLICATES.includes(f.id)) continue;
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
      for (const a of APPEARANCE_COMMANDS) {
        const label = t(a.labelKey);
        const m = fuzzyBest(q, [{ text: label, weight: 1 }]);
        if (m) {
          cmds.push({
            key: `app-${a.key}`,
            kind: "command",
            label,
            hint: null,
            match: m,
            action: a.action,
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
        // registry 条目按组归拢；tool-/app- 前缀条目有专属组节（工具/外观），
        // 不参与 registry 组匹配（groupOf 对 theme.set.* 回落 system 会双计）
        const inGroup = cmds.filter(
          (c) =>
            c.action !== undefined &&
            !c.key.startsWith("tool-") &&
            !c.key.startsWith("app-") &&
            groupOf(c.action as ActionId) === g.id,
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
      const appearance = cmds.filter((c) => c.key.startsWith("app-"));
      if (appearance.length > 0) {
        rows.push({
          kind: "section",
          key: "grp-appearance",
          label: t("palette.group_appearance"),
        });
        for (const item of appearance) {
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

  // 键盘导航（document 级，2026-10-12）：上下移动/Enter 选中**不依赖输入框
  // 焦点**——焦点落在条目按钮、遮罩或任何位置都能操作；输入框内的输入不
  // 受影响（方向键不产字符，Enter 由这里 preventDefault 防换行）。
  const navHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  navHandlerRef.current = (e: KeyboardEvent) => {
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
  };

  // 退场动画窗（评审 P1-8）：open=false 后保留挂载播镜像动画，再真卸载。
  const mount = useDelayedUnmount(open);
  // Esc 关闭走全局栈（useEscClose）：焦点不在输入框（Tab 到列表项/点面板空白）
  // 也能关，且嵌套时只关栈顶（后开的先关）——不再挂在 input 的 onKeyDown 上。
  useEscClose(open, onClose);

  // 键盘导航（document 级，评审 2026-10-12）：上下移动/Enter 选中**不依赖
  // 输入框焦点**——焦点落在条目按钮、遮罩或任何位置都能操作；输入框内的
  // 输入不受影响（方向键不产字符，Enter 由这里 preventDefault 防换行）。
  // handler 走 ref（每次渲染刷新闭包）。effect 必须挂在早退之前（hooks
  // 顺序恒定），shouldRender 守卫在内部。
  useEffect(() => {
    if (!mount.shouldRender) return;
    const h = (e: KeyboardEvent) => navHandlerRef.current(e);
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [mount.shouldRender]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, flat.length]);

  if (!mount.shouldRender) return null;

  function runItem(item: PaletteItem | undefined) {
    if (!item) return;
    if (item.kind === "command" && item.action) onAction(item.action);
    else if (item.kind === "host" && item.host) onConnect(item.host);
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
