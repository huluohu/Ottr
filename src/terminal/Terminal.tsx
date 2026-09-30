// 终端体验层（Task 8，A1/A8）：分屏主区 + 单会话终端 + 搜索 + 右键菜单 +
// URL 检测 + 选择即复制 + 多行/危险粘贴确认。
//
// 数据面沿用 Phase 0/Task 7 定案：PTY 输出经 attach_host_session 的二进制 Raw
// 帧推到 Channel，字节直写 xterm；击键经 write_session 直传 PTY。终端实例按
// 会话持有（切标签/pane 不丢回显缓冲），ResizeObserver 可见尺寸变化时 fit。
//
// 分屏（Task 8）：一个标签一棵 pane 树（SessionStore.trees，树叶 id = 会话 id，
// 布局/关闭/拖拽的纯函数在 split.ts）。本文件的 TerminalArea 按 bounds 渲染
// layout() 矩形与 dividers() 命中面；**全部会话的 DOM 常驻**（列表按 key 稳定
// 复用，只有 style 变化）——切标签/关 pane 不重挂 xterm，滚回不丢。
//
// 搜索（⌘F）：SearchController per 会话（SearchAddon.ts 注册表），搜索栏操作
// 「聚焦 pane」的会话；右键菜单「搜索」等价。
//
// 粘贴纪律：宿主 div 捕获阶段拦截 paste 事件（先于 xterm 的 textarea 监听），
// assessPaste（src/ai/danger.ts，Task 13 分级的单一来源）判定 none → 放行原生
// 粘贴；warn/danger → 弹确认层，确认后 term.paste() 走同一写入路径。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { registerSink, unregisterSink, useSessionStore, encodingName, isHostKeyRejection, nextEncoding, type SessionEncoding } from "../session/SessionStore";
import { useTheme, type ResolvedTheme } from "../theme/ThemeContext";
import { terminalThemes } from "../theme/terminal-themes";
import type { ITheme } from "@xterm/xterm";
import { assessPaste } from "../ai/danger";
import {
  getSearch,
  registerSearch,
  unregisterSearch,
  SearchController,
  type SearchResultSummary,
} from "./SearchAddon";
import {
  buildContextMenu,
  loadTerminalSettings,
  saveTerminalSettings,
  type ContextMenuItem,
  type MenuContext,
} from "./ContextMenu";
import { dividers, layout, leaf, type Divider, type Rect } from "./split";

/** 主题同步 xterm 配色（亮/暗两套，A10；T1 terminalThemes 消费）。入参是
 * ThemeContext 的**解析结果**（resolved，非三态 mode）——system 模式下 OS
 * 明暗切换时 resolved 变化驱动本组件 effect 重跑，终端实时换套（简报 I面：
 * useTheme().resolved → xterm theme）。结构化入参便于单测，不绑定 xterm 类。 */
export function applyTermTheme(
  term: { options: { theme?: ITheme } },
  resolved: ResolvedTheme,
): void {
  term.options.theme = terminalThemes[resolved];
}

// 会话编码状态在 SessionStore（Task 9）：T8 的临时 sessionEncoding 内存表已删，
// 右键菜单/徽标/提示条统一走 store.setSessionEncoding（Rust 侧即切即生效）。

// ---------------------------------------------------------------------------
// 单会话终端（xterm 装配 + 状态横幅 + 右键菜单 + 粘贴确认）
// ---------------------------------------------------------------------------

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** 粘贴确认弹层（导出供组件测试；verdict 由 assessPaste 现算——纯函数单源）。 */
export function PasteConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const verdict = assessPaste(text);
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return (
    <div className="overlay paste-confirm" role="dialog" aria-modal="true" aria-label={t("terminal.pasteTitle")}>
      <div className="dialog paste-dialog" data-testid="paste-confirm">
        <h2>{t("terminal.pasteTitle")}</h2>
        {verdict.findings.length > 0 && (
          <>
            <p className="paste-warning">{t("terminal.pasteDanger")}</p>
            <ul className="paste-findings" data-testid="paste-findings">
              {verdict.findings.map((f) => (
                <li key={f.kind}>
                  <code>{f.excerpt}</code>
                  {" — "}
                  {t(`ai.danger.${f.kind}`, { defaultValue: f.kind })}
                </li>
              ))}
            </ul>
          </>
        )}
        {verdict.multiline && <p>{t("terminal.pasteMultiline")}</p>}
        <pre data-testid="paste-preview">{preview}</pre>
        <div className="form-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button
            className={verdict.level === "danger" ? "btn-danger" : "btn-accent"}
            data-testid="paste-confirm-button"
            onClick={onConfirm}
          >
            {t("terminal.pasteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 编码检测提示条（Task 9，A9）：Rust detect_hint 命中 GBK 家族后展示
 * 「检测到 GBK 编码，切换？」；「切换」= acceptEncodingHint（切编码 + 同 host
 * 记一次性可关），「忽略」= dismissEncodingHint。 */
export function EncodingHintBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const hint = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.encodingHint ?? null,
  );
  if (!hint) return null;
  return (
    <div className="encoding-hint" data-testid="encoding-hint" role="status">
      <span className="encoding-hint-text">
        {t("terminal.encodingHint", { encoding: encodingName(hint) })}
      </span>
      <button
        className="encoding-hint-accept"
        data-testid="encoding-hint-accept"
        onClick={() => useSessionStore.getState().acceptEncodingHint(sessionId)}
      >
        {t("terminal.encodingHintAccept", { encoding: encodingName(hint) })}
      </button>
      <button
        className="encoding-hint-dismiss"
        aria-label={t("terminal.encodingHintDismiss")}
        data-testid="encoding-hint-dismiss"
        onClick={() => useSessionStore.getState().dismissEncodingHint(sessionId)}
      >
        ×
      </button>
    </div>
  );
}

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const prevStatus = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

  const status = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.status ?? "disconnected",
  );
  const attempt = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.attempt ?? 0,
  );
  const nextRetryAt = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.nextRetryAt ?? null,
  );
  const lastError = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.lastError ?? null,
  );

  // --- 一次性装配：term 实例 + sink 注册 + 击键接线 + 尺寸观测 ---
  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // URL 检测（A8）：WebLinksAddon 默认 handler（新窗打开链接）
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    const search = new SearchController(term);
    if (hostRef.current) {
      try {
        term.open(hostRef.current);
      } catch {
        // 布局未就绪（隐藏窗格/测试环境）不阻塞；恢复可见时 RO 会再 fit
      }
    }
    applyTermTheme(term, resolved);
    registerSink(sessionId, {
      write: (bytes) => term.write(bytes),
      getSize: () => {
        try {
          fit.fit();
        } catch {
          // 尺寸不可测（隐藏/未布局）→ xterm 默认值仍有效
        }
        return { cols: term.cols, rows: term.rows };
      },
    });
    registerSearch(sessionId, search);

    // 击键 → PTY（rustId 实时读 store；重连换会话 id 后自动跟随）
    const onData = term.onData((d) => {
      const session = useSessionStore
        .getState()
        .sessions.find((x) => x.id === sessionId);
      if (!session?.rustId) return; // 未连接：击键落空（横幅已提示状态）
      void invoke("write_session", {
        id: session.rustId,
        bytes: Array.from(new TextEncoder().encode(d)),
      }).catch(() => {});
    });

    // 选择即复制（可配，右键菜单切换；设置即时读 localStorage 免订阅）
    const onSelectionChange = term.onSelectionChange(() => {
      if (!loadTerminalSettings().copyOnSelect) return;
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      }
    });

    // 可见尺寸变化 → fit（切标签/拖分隔条/窗口缩放）。0 尺寸（隐藏）跳过。
    const ro = new ResizeObserver(() => {
      const el = hostRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // xterm 对退化尺寸抛错可忽略
      }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      onSelectionChange.dispose();
      onData.dispose();
      unregisterSearch(sessionId);
      unregisterSink(sessionId);
      term.dispose();
      termRef.current = null;
    };
    // sessionId 是组件身份（key 绑定），mode 变化走单独 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // --- 主题跟随（resolved 驱动：手动切换与 system 模式的 OS 切换都实时生效） ---
  useEffect(() => {
    if (termRef.current) applyTermTheme(termRef.current, resolved);
  }, [resolved]);

  // --- 粘贴拦截（宿主捕获阶段，先于 xterm 的 textarea 监听） ---
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text === "") return;
      if (assessPaste(text).level !== "none") {
        // warn/danger：拦下原生路径，交确认层；确认后 term.paste 同路写入
        e.preventDefault();
        e.stopPropagation();
        setPendingPaste(text);
      }
    };
    el.addEventListener("paste", onPaste, true);
    return () => el.removeEventListener("paste", onPaste, true);
  }, []);

  // --- 状态横幅（写入终端流；跳过挂载首帧的 disconnected 初值） ---
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const first = prevStatus.current === null;
    prevStatus.current = status;
    if (first && status === "connecting") {
      // 首连中（挂载即 connecting）：连接横幅
      term.writeln(`\x1b[2m[ottr] ${t("terminal.connecting")}\x1b[0m`);
      return;
    }
    if (first) return; // 恢复的静默标签（disconnected）不写历史横幅
    switch (status) {
      case "connected":
        if (attempt === 0) break; // 首连成功：shell 输出即反馈，不打横幅
        term.writeln(`\x1b[2m[ottr] ${t("terminal.reconnected")}\x1b[0m`);
        break;
      case "reconnecting": {
        const seconds = nextRetryAt ? Math.max(1, Math.round((nextRetryAt - Date.now()) / 1000)) : 0;
        term.writeln(
          `\x1b[33m[ottr] ${t("terminal.reconnecting", {
            seconds,
            attempt,
            max: useSessionStore.getState().settings.maxReconnectAttempts,
          })}\x1b[0m`,
        );
        break;
      }
      case "disconnected":
        if (lastError) {
          term.writeln(
            isHostKeyRejection(lastError)
              ? `\x1b[31m[ottr] ${t("terminal.hostKeyRejected")}\x1b[0m`
              : `\x1b[31m[ottr] ${t("terminal.connectFailed", { message: lastError })}\x1b[0m`,
          );
        }
        if (attempt === 0) {
          term.writeln(`\x1b[2m[ottr] ${t("terminal.reconnectHint")}\x1b[0m`);
        } else {
          term.writeln(
            `\x1b[31m[ottr] ${t("terminal.reconnectExhausted", {
              max: useSessionStore.getState().settings.maxReconnectAttempts,
            })}\x1b[0m`,
          );
        }
        break;
      default:
        break;
    }
    // attempt 变化（重连计数推进）不单独写横幅——reconnecting 分支已带计数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lastError]);

  // --- 右键菜单 ---
  function openContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const term = termRef.current;
    const ctx: MenuContext = {
      hasSelection: term?.hasSelection() ?? false,
      copyOnSelect: loadTerminalSettings().copyOnSelect,
      encoding: useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.encoding ?? "utf-8",
    };
    const width = 220;
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - width),
      y: Math.min(e.clientY, window.innerHeight - 320),
      items: buildContextMenu(ctx, t),
    });
  }

  function runMenuAction(id: string) {
    setMenu(null);
    const term = termRef.current;
    const store = useSessionStore.getState();
    const session = store.sessions.find((s) => s.id === sessionId);
    switch (id) {
      case "copy":
        if (term?.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        }
        break;
      case "paste":
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text !== "") requestPaste(text);
          })
          .catch(() => {});
        break;
      case "search":
        store.openSearch(sessionId);
        break;
      case "clear":
        term?.clear();
        break;
      case "splitRight":
      case "splitDown": {
        const tabId = session?.paneOf ?? sessionId;
        store.setActivePane(tabId, sessionId); // 分裂发生在右键的 pane 上
        store.splitPane(tabId, id === "splitRight" ? "row" : "column");
        break;
      }
      case "closePane":
        store.closePane(sessionId);
        break;
      case "copyOnSelect":
        saveTerminalSettings({ copyOnSelect: !loadTerminalSettings().copyOnSelect });
        break;
      default:
        if (id.startsWith("encoding:")) {
          // Task 9：切换走 store（Rust 侧 set_session_encoding 即切即生效）
          const enc = id.slice("encoding:".length) as SessionEncoding;
          store.setSessionEncoding(sessionId, enc);
        }
        break;
    }
  }

  /** 粘贴入口（菜单/确认层共用）：level=none 直接写，否则弹确认。 */
  function requestPaste(text: string) {
    const verdict = assessPaste(text);
    if (verdict.level === "none") {
      termRef.current?.paste(text);
    } else {
      setPendingPaste(text);
    }
  }

  return (
    <div className="session-term" ref={hostRef} data-session-id={sessionId} onContextMenu={openContextMenu}>
      <EncodingHintBar sessionId={sessionId} />
      {menu && (
        <>
          <div className="ctx-overlay" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <ContextMenuView x={menu.x} y={menu.y} items={menu.items} onAction={runMenuAction} testPrefix={sessionId} />
        </>
      )}
      {pendingPaste !== null && (
        <PasteConfirmDialog
          text={pendingPaste}
          onCancel={() => setPendingPaste(null)}
          onConfirm={() => {
            termRef.current?.paste(pendingPaste);
            setPendingPaste(null);
          }}
        />
      )}
    </div>
  );
}

/** 右键菜单渲染（含一级子菜单：编码）。纯展示：动作经 onAction(id) 上抛。 */
export function ContextMenuView({
  x,
  y,
  items,
  onAction,
  testPrefix,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onAction: (id: string) => void;
  testPrefix: string;
}) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const { t } = useTranslation();
  return (
    <div
      className="ctx-menu"
      role="menu"
      aria-label={t("terminal.menuAria")}
      style={{ left: x, top: y }}
      data-testid={`ctx-menu-${testPrefix}`}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="ctx-menu-row"
          onMouseEnter={() => setOpenSub(item.children ? item.id : null)}
        >
          <button
            role="menuitem"
            className={`ctx-menu-item${item.danger ? " danger" : ""}`}
            data-checked={item.checked === true}
            disabled={item.disabled === true}
            data-testid={`ctx-${item.id}`}
            onClick={() => {
              if (item.children) {
                setOpenSub(openSub === item.id ? null : item.id);
              } else {
                onAction(item.id);
              }
            }}
          >
            <span>{item.label}</span>
            <span className="ctx-hint">{item.children ? "›" : item.checked ? "✓" : ""}</span>
          </button>
          {item.children && openSub === item.id && (
            <div className="ctx-submenu" role="menu">
              {item.children.map((sub) => (
                <button
                  key={sub.id}
                  role="menuitem"
                  className="ctx-menu-item"
                  data-checked={sub.checked === true}
                  data-testid={`ctx-${sub.id}`}
                  onClick={() => onAction(sub.id)}
                >
                  <span>{sub.label}</span>
                  <span className="ctx-hint">{sub.checked ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分屏主区（布局渲染 + 分隔条拖拽 + 搜索栏 + ⌘F）
// ---------------------------------------------------------------------------

function SearchBar({ sessionId }: { sessionId: string }) {
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
        ×
      </button>
    </div>
  );
}

/** 分屏终端主区（App.tsx 挂载）。bounds 驱动纯布局（split.ts），分隔条拖拽
 * 回写 setPaneRatio。活动标签之外的会话窗格隐藏但常驻（缓冲不丢）。 */
export function TerminalArea() {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const trees = useSessionStore((s) => s.trees);
  const activePaneMap = useSessionStore((s) => s.activePane);
  const searchSessionId = useSessionStore((s) => s.searchSessionId);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ divider: Divider } | null>(null);
  const [bounds, setBounds] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });

  // 容器尺寸 → 布局输入（拖侧栏/窗口缩放都会触发）
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const measure = () => setBounds({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeTree = activeId != null ? (trees[activeId] ?? leaf(activeId)) : null;
  const rects = activeTree ? layout(activeTree, bounds) : new Map<string, Rect>();
  const dividerList = activeTree ? dividers(activeTree, bounds) : [];
  const focusedPane = activeId != null ? (activePaneMap[activeId] ?? activeId) : null;

  // 编码徽标（Task 9）：聚焦 pane 的当前会话编码，点击循环 utf-8→gbk→gb18030。
  const activeEncoding = useSessionStore((s) =>
    focusedPane != null
      ? (s.sessions.find((x) => x.id === focusedPane)?.encoding ?? null)
      : null,
  );

  // ⌘F / Ctrl+F 呼出聚焦 pane 的搜索；Esc 由搜索栏自处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        const store = useSessionStore.getState();
        const target =
          store.activeId != null ? (store.activePane[store.activeId] ?? store.activeId) : null;
        store.openSearch(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function startDrag(divider: Divider) {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { divider };
      // ratio 由指针在命中面内的相对位置直接换算（split.ts 内 clamp 到活口）
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current?.divider;
        const store = useSessionStore.getState();
        if (!d || store.activeId == null) return;
        const ratio =
          d.dir === "row"
            ? (ev.clientX - d.rect.x) / Math.max(1, d.rect.w)
            : (ev.clientY - d.rect.y) / Math.max(1, d.rect.h);
        store.setPaneRatio(store.activeId, d.path, ratio); // split.ts 内 clamp
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
  }

  return (
    <div className="term-area">
      <div className="term-toolbar">
        <button
          data-testid="split-right"
          disabled={activeId == null}
          onClick={() => activeId != null && useSessionStore.getState().splitPane(activeId, "row")}
        >
          {t("terminal.splitRight")}
        </button>
        <button
          data-testid="split-down"
          disabled={activeId == null}
          onClick={() => activeId != null && useSessionStore.getState().splitPane(activeId, "column")}
        >
          {t("terminal.splitDown")}
        </button>
        {activeEncoding != null && (
          <button
            className="encoding-badge"
            data-testid="encoding-badge"
            data-encoding={activeEncoding}
            aria-label={t("terminal.encodingBadgeAria", { encoding: encodingName(activeEncoding) })}
            title={t("terminal.encodingBadgeAria", { encoding: encodingName(activeEncoding) })}
            style={{ marginLeft: "auto" }}
            onClick={() =>
              useSessionStore
                .getState()
                .setSessionEncoding(focusedPane as string, nextEncoding(activeEncoding))
            }
          >
            {encodingName(activeEncoding)}
          </button>
        )}
      </div>
      <div className="term-stack" ref={stackRef} data-testid="term-stack">
        {sessions.map((session) => {
          const rect = rects.get(session.id);
          return (
            <div
              key={session.id}
              className="term-pane"
              data-active={rect != null}
              data-focused={focusedPane === session.id}
              data-testid={`term-pane-${session.id}`}
              style={
                rect
                  ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
                  : undefined
              }
              onMouseDown={() => {
                if (activeId != null) {
                  useSessionStore.getState().setActivePane(activeId, session.id);
                }
              }}
            >
              <SessionTerminal sessionId={session.id} />
            </div>
          );
        })}
        {dividerList.map((d, i) => (
          <div
            key={`divider-${i}`}
            role="separator"
            aria-label={t("terminal.splitAria")}
            aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
            className="split-divider"
            data-dir={d.dir}
            data-testid={`split-divider-${d.path.join("-") || "root"}`}
            style={{ left: d.rect.x, top: d.rect.y, width: d.rect.w, height: d.rect.h }}
            onPointerDown={startDrag(d)}
          />
        ))}
        {searchSessionId != null && <SearchBar sessionId={searchSessionId} />}
      </div>
    </div>
  );
}
