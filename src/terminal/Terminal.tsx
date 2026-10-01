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
//
// trzsz（Phase 2 Task 4，B10 下半）：TrzszFilter 挂在**本地数据出口**——PTY 输出
// 经 sink.write 进 controller（空闲透传 / 传输态拦截协议帧），击键经 onData 进
// controller（传输态吞键入，Ctrl-C 即中止）；文件选择走 tauri-plugin-dialog，
// 本地文件 IO 走 trzsz fs 垫片（trzsz/fsShim.ts → commands/trzsz_fs.rs）。终端区
// 拖拽文件 → 询问「trz 上传 / 插入路径」（TrzszDropDialog）。
//
// 智能补全（Phase 2 Task 8，B8）：fish 风格 ghost text——GhostController 挂在
// onData **前置位**（先于 trzsz）：有 ghost 时 Tab 拦截采纳（补全剩余文本走
// writeToSession 同一出口）、Esc 忽略；无 ghost 一切透传 shell。渲染是 xterm
// decoration 纯视觉层（PTY 零污染）；建议来源 = 历史缓存（history/cache.ts，
// history_search 空 query 复用 + onCommandFinished 增量）+ 内置命令表
// （terminal/completion.ts 纯引擎）。开关在右键菜单（默认开）。
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useAiStore } from "../ai/aiStore";
import { recordCommand } from "../history/record";
import { createCommandWatch, type IDisposable } from "./CommandWatch";
import { noteCwd, forgetCwd } from "./CwdTracker";
import {
  getSearch,
  registerSearch,
  unregisterSearch,
  SearchController,
  type SearchResultSummary,
} from "./SearchAddon";
import { createTrzszController, type TrzszController } from "./trzsz/TrzszController";
import { GhostController } from "./completion";
import { completionHistory } from "../history/cache";
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

/** 终端区拖拽落点对话框（Phase 2 Task 4，B10 下半）：文件拖入终端 pane 后询问
 * 「trz 上传」（TrzszController.uploadFiles，远端须装 trzsz）或「插入路径」
 * （单引号转义后 term.paste，与 SFTP 上传无关的纯文本插入）。 */
export function TrzszDropDialog({
  paths,
  onUpload,
  onInsert,
  onCancel,
}: {
  paths: string[];
  onUpload: () => void;
  onInsert: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const names = paths.map((p) => p.split("/").pop() ?? p).join("、");
  return (
    <div className="overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="dialog trzsz-drop-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("terminal.trzszDropAria")}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="trzsz-drop-dialog"
      >
        <h2>{t("terminal.trzszDropTitle")}</h2>
        <p data-testid="trzsz-drop-files">{t("terminal.trzszDropHint", { count: paths.length, names })}</p>
        <div className="form-actions">
          <button onClick={onCancel}>{t("common.cancel")}</button>
          <button data-testid="trzsz-drop-insert" onClick={onInsert}>
            {t("terminal.trzszDropInsert")}
          </button>
          <button className="btn-accent" data-testid="trzsz-drop-upload" onClick={onUpload}>
            {t("terminal.trzszDropUpload")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 拖拽路径 → shell 安全插入形态（单引号包裹，内部 ' 转义为 '\''）。 */
export function quotePathsForShell(paths: string[]): string {
  return paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
}

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const trzszRef = useRef<TrzszController | null>(null);
  const ghostRef = useRef<GhostController | null>(null);
  const prevStatus = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<string[] | null>(null);

  // 白名单登记/撤销（Fix round 1 I-1）：scope = 前端会话 id；对话框与拖拽上传
  // 返回路径后登记，传输收尾/上传 settle/会话卸载撤销。Rust 侧七命令入口统一校验。
  const grantTrzsz = useCallback(
    (paths: string[], kind: "file" | "dir") =>
      invoke("trzsz_grant", { scope: sessionId, paths, kind }).catch(() => undefined),
    [sessionId],
  );
  const revokeTrzsz = useCallback(
    () => invoke("trzsz_revoke", { scope: sessionId }).catch(() => undefined),
    [sessionId],
  );

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
    // B8：allowProposedApi 开启——ghost text 的 registerDecoration 是 xterm
    // proposed API（未开则抛 "You must set the allowProposedApi option"）；
    // 对既有面零行为变化，只解锁装饰 API。
    const term = new XTerm({ cursorBlink: true, fontSize: 13, allowProposedApi: true });
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
    // trzsz 过滤器（B10 下半）：先于 sink 装配——PTY 出口与击键都经它中转。
    // write_session 沿用原 onData 体（rustId 实时读 store；重连自动跟随）。
    // 击键出口单点化：trzsz 透传与 ghost Tab 采纳共用同一写入闭包。
    const writeToSession = (input: string | Uint8Array): void => {
      const session = useSessionStore
        .getState()
        .sessions.find((x) => x.id === sessionId);
      if (!session?.rustId) return; // 未连接：击键落空（横幅已提示状态）
      const bytes =
        typeof input === "string" ? new TextEncoder().encode(input) : input;
      void invoke("write_session", {
        id: session.rustId,
        bytes: Array.from(bytes),
      }).catch(() => {});
    };
    const trzsz = createTrzszController({
      writeToTerminal: (output) => term.write(output),
      sendToServer: writeToSession,
      chooseSendFiles: async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const picked = await open({
            multiple: true,
            title: t("terminal.trzszDropUpload"),
          });
          const paths = Array.isArray(picked) ? picked : picked ? [picked] : undefined;
          if (paths) await grantTrzsz(paths, "file");
          return paths;
        } catch {
          return undefined; // 对话框失败按取消处理（= 拒绝传输，服务端安全收尾）
        }
      },
      chooseSaveDirectory: async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const picked = await open({
            directory: true,
            title: t("terminal.trzszDropTitle"),
          });
          if (typeof picked === "string") await grantTrzsz([picked], "dir");
          return typeof picked === "string" ? picked : undefined;
        } catch {
          return undefined;
        }
      },
      onTransfersSettled: () => {
        void revokeTrzsz();
      },
      onError: (message) => {
        // 典型失败：远端未装 trzsz（uploadFiles 3s 无魔串「Upload does not start」）
        const text = message.includes("Upload does not start")
          ? t("terminal.trzszUploadNoStart")
          : t("terminal.trzszUploadFailed", { message });
        term.writeln(`\x1b[33m[ottr] ${text}\x1b[0m`);
      },
    });
    trzszRef.current = trzsz;
    registerSink(sessionId, {
      write: (bytes) => trzsz.processServerOutput(bytes),
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

    // T13 报错即诊：OSC133 命令边界监听（shell 集成片段发 A/C/D 标记）；
    // D;code≠0 → aiStore.onCommandFailed（ai.enabled 总开关在 store 内现读）。
    // T15 历史入库：onCommandFinished（全量命令完成，含 exit 0）→ history_insert
    // （fire-and-forget，见 src/history/record.ts）。B8：同一事件流增量喂补全缓存。
    const firstSession = useSessionStore
      .getState()
      .sessions.find((x) => x.id === sessionId);
    if (firstSession) void completionHistory.ensure(firstSession.hostId); // 补全历史冷启动拉取
    let watch: IDisposable | null = null;
    try {
      watch = createCommandWatch(term, {
        // B8：新提示符 = 旧输入行消失，ghost 全量清态
        onPromptStart: () => ghostRef.current?.reset(),
        onCommandDone: ({ exitCode, command }) => {
          const session = useSessionStore
            .getState()
            .sessions.find((x) => x.id === sessionId);
          if (!session) return;
          useAiStore.getState().onCommandFailed({
            kind: "diagnose",
            sessionId,
            rustId: session.rustId,
            hostId: session.hostId,
            hostName: session.hostName,
            exitCode,
            command,
          });
        },
        onCommandFinished: (ev) => {
          const session = useSessionStore
            .getState()
            .sessions.find((x) => x.id === sessionId);
          if (!session) return;
          noteCwd(sessionId, ev.cwd); // B1 ⌘J：OSC7 cwd 活值记账（null 不覆盖）
          recordCommand({ hostId: session.hostId, sessionId }, ev);
          completionHistory.append(session.hostId, ev.command); // B8：MRU 喂缓存
        },
      });
    } catch {
      // parser 不可用（测试环境极简 fake）不阻塞终端装配
    }

    // B8 智能补全（fish 风格 ghost text）：decoration 视觉层 + onData 前置按键
    // 语义（有 ghost 拦 Tab 采纳/Esc 忽略/打字刷新）；采纳写入走 writeToSession
    // 同一出口。挂起面（I-2）：设置关或 trzsz 传输态 → enabled()=false →
    // handleData 全透传零渲染（Tab 归 trzsz 管辖，采纳不旁路传输态拦截）。
    // alt buffer（C-1）在控制器内判 buffer.active.type。
    const ghost = new GhostController(term, {
      sources: () => {
        const s = useSessionStore
          .getState()
          .sessions.find((x) => x.id === sessionId);
        return s
          ? completionHistory.sources(s.hostId)
          : { hostHistory: [], globalHistory: [] };
      },
      enabled: () =>
        loadTerminalSettings().completionEnabled && !trzsz.isTransferring(),
      onAccept: writeToSession,
    });
    ghost.setColor(terminalThemes[resolved].brightBlack ?? "#808080"); // 语义令牌：ANSI 注释灰
    ghostRef.current = ghost;

    // 击键 → ghost 前置语义 → trzsz 过滤器 → PTY（传输态库吞键入；空闲透传）
    const onData = term.onData((d) => {
      if (ghost.handleData(d)) return; // Tab 采纳/Esc 忽略已消费，不进 PTY
      trzsz.processTerminalInput(d);
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
      trzsz.setTerminalColumns(term.cols); // 进度条按列宽重绘
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      onSelectionChange.dispose();
      onData.dispose();
      watch?.dispose();
      ghost.dispose();
      ghostRef.current = null;
      trzsz.dispose();
      trzszRef.current = null;
      void revokeTrzsz(); // 会话关闭兜底撤销（I-1：授权不活过终端实例）
      unregisterSearch(sessionId);
      unregisterSink(sessionId);
      forgetCwd(sessionId);
      term.dispose();
      termRef.current = null;
    };
    // sessionId 是组件身份（key 绑定），mode 变化走单独 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // --- 主题跟随（resolved 驱动：手动切换与 system 模式的 OS 切换都实时生效） ---
  useEffect(() => {
    if (termRef.current) applyTermTheme(termRef.current, resolved);
    // B8：ghost 灰字随主题换（ANSI brightBlack = 注释灰语义令牌）
    ghostRef.current?.setColor(terminalThemes[resolved].brightBlack ?? "#808080");
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

  // --- 终端区拖拽（B10 下半 Step 2）：Tauri onDragDropEvent 落点命中本 pane →
  // 询问「trz 上传 / 插入路径」；非 Tauri 环境（测试）拖拽能力缺席即缺席。
  useEffect(() => {
    if (!hostRef.current) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const off = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload as unknown as {
            type: "enter" | "over" | "drop" | "leave";
            paths?: string[];
            position: { x: number; y: number };
          };
          if (p.type !== "drop") return;
          // 物理像素 → 逻辑像素；落点须命中本会话的终端 pane
          const x = p.position.x / (window.devicePixelRatio || 1);
          const y = p.position.y / (window.devicePixelRatio || 1);
          const hit = document.elementFromPoint(x, y)?.closest("[data-session-id]");
          if (hit?.getAttribute("data-session-id") !== sessionId) return;
          const paths = p.paths ?? [];
          if (paths.length > 0) setPendingDrop(paths);
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // 非 Tauri 环境：拖拽能力缺席不阻塞终端
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  // --- 状态横幅（写入终端流；跳过挂载首帧的 disconnected 初值） ---
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    ghostRef.current?.reset(); // 状态迁移（断连/重连中）输入行语义失效 → 清 ghost
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
      completionEnabled: loadTerminalSettings().completionEnabled,
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
      case "explain":
        // T13 选中解释：选区文本 → AI 面板单轮（不受 ai.enabled 管，显式动作）
        if (term?.hasSelection()) {
          useAiStore.getState().openExplain({
            kind: "explain",
            sessionId,
            hostId: session?.hostId ?? null,
            hostName: session?.hostName ?? "",
            text: term.getSelection(),
          });
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
        // 设置全量覆写：先读后写（新字段不丢，Task 8 起 TerminalSettings 多字段）
        saveTerminalSettings({
          ...loadTerminalSettings(),
          copyOnSelect: !loadTerminalSettings().copyOnSelect,
        });
        break;
      case "completion":
        saveTerminalSettings({
          ...loadTerminalSettings(),
          completionEnabled: !loadTerminalSettings().completionEnabled,
        });
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
      {pendingDrop !== null && (
        <TrzszDropDialog
          paths={pendingDrop}
          onCancel={() => setPendingDrop(null)}
          onUpload={() => {
            const paths = pendingDrop;
            setPendingDrop(null);
            // 拖拽路径无对话框，授权在此登记；上传结束（含失败）即撤销
            void grantTrzsz(paths, "file")
              .then(() => trzszRef.current?.uploadFiles(paths))
              .finally(() => {
                void revokeTrzsz();
              });
          }}
          onInsert={() => {
            const text = quotePathsForShell(pendingDrop);
            setPendingDrop(null);
            termRef.current?.paste(text); // 走 onData → trzsz → write_session 同路
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
