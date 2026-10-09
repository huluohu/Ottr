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
import { registerSink, unregisterSink, resizeSession, useSessionStore, encodingName, isHostKeyRejection, nextEncoding, type SessionEncoding } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import { vaultApi } from "../vault/api";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useTheme, terminalPaletteKey } from "../theme/ThemeContext";
import {
  resolveTerminalTheme,
  useTerminalThemeStore,
  type TerminalPaletteKey,
  type TerminalThemeSetting,
} from "../theme/terminalThemeStore";
import type { ITheme } from "@xterm/xterm";
import { assessPaste, InputDangerWatch, type DangerFinding } from "../ai/danger";
import { useAiStore } from "../ai/aiStore";
import { recordCommand } from "../history/record";
import { createCommandWatch, type IDisposable } from "./CommandWatch";
import { noteCwd, forgetCwd } from "./CwdTracker";
import {
  SudoPromptDetector,
  runSudoAutofill,
  SUDO_AUTOFILL_SETTING_KEY,
  type SudoSkipReason,
} from "./SudoAutofill";
import { registerSearch, unregisterSearch, SearchController } from "./SearchAddon";
import { createTrzszController, type TrzszController } from "./trzsz/TrzszController";
import { GhostController } from "./completion";
import { completionHistory } from "../history/cache";
import {
  buildContextMenu,
  DEFAULT_TERMINAL_FONT_FAMILY,
  loadTerminalSettings,
  saveTerminalSettings,
  type ContextMenuItem,
  type MenuContext,
} from "./ContextMenu";
import { dividers, layout, leaf, type Divider, type Rect } from "./split";
// 对话框/右键菜单/搜索栏组件自本文件拆出（2026-10-08 遗留项②）——
// 公共 API 经下方再导出保持原路径（组件测试 import 零改动）。
import { ContextMenuView } from "./ContextMenuView";
import {
  DangerHintBar,
  EncodingHintBar,
  PasteConfirmDialog,
  TrzszDropDialog,
  quotePathsForShell,
} from "./dialogs";
import { SearchBar } from "./SearchBar";
export {
  ContextMenuView,
  DangerHintBar,
  EncodingHintBar,
  PasteConfirmDialog,
  TrzszDropDialog,
  quotePathsForShell,
};

/** 主题同步 xterm 配色（theme-suite T2.3：auto 按界面主题 id 取配套色板——
 * light/dark 沿用旧亮暗两套，oled/amethyst/verdant/glass 各取内置四套；选
 * 内置画廊/自定义配色则固定取该套，与界面主题解耦）。入参是 auto 色板键
 * （terminalPaletteKey(mode, resolved)：system 已摊平为亮/暗）——system 模式
 * OS 明暗切换时键变化驱动本组件 effect 重跑，终端实时换套。结构化入参便于
 * 单测，不绑定 xterm 类。 */
export function applyTermTheme(
  term: { options: { theme?: ITheme } },
  paletteKey: TerminalPaletteKey,
  setting?: TerminalThemeSetting,
): void {
  term.options.theme = resolveTerminalTheme(
    paletteKey,
    setting ?? useTerminalThemeStore.getState(),
  );
}

// 会话编码状态在 SessionStore（Task 9）：T8 的临时 sessionEncoding 内存表已删，
// 右键菜单/徽标/提示条统一走 store.setSessionEncoding（Rust 侧即切即生效）。

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

// ---------------------------------------------------------------------------
// 单会话终端（xterm 装配 + 状态横幅 + 右键菜单 + 粘贴确认）
// ---------------------------------------------------------------------------

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { mode: themeMode, resolved } = useTheme();
  // 终端 auto 色板键（theme-suite T2.3）：具体主题 id 直取，system 摊平为亮/暗。
  const paletteKey = terminalPaletteKey(themeMode, resolved);
  // 终端配色选择（Phase 2 Task 9，B2）：selection/custom 任一变化都重跑主题 effect
  // （换画廊套即时生效；自定义主题被重导入覆盖时 custom 引用变化同样刷新）。
  const termSelection = useTerminalThemeStore((s) => s.selection);
  const termCustom = useTerminalThemeStore((s) => s.custom);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const trzszRef = useRef<TrzszController | null>(null);
  const ghostRef = useRef<GhostController | null>(null);
  const prevStatus = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<string[] | null>(null);
  // B11 危险输入提醒：观察面（限频器）+ 当前输入行缓冲 + 展示中的命中
  const inputWatchRef = useRef<InputDangerWatch | null>(null);
  const lineBufRef = useRef("");
  const [dangerHint, setDangerHint] = useState<DangerFinding | null>(null);
  // B9 sudo 检测器复位柄（状态迁移/重连时清历史缓冲——旧提示文本不得跨连接命中）
  const sudoResetRef = useRef<(() => void) | null>(null);

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

  // 缺陷 34：连接成立即把当前真实尺寸下发给 PTY——ResizeObserver 只在布局
  // 变化时触发（首挂载早于 rustId 落地，attach 拿到的可能是未布局的退化尺寸
  // 2×1），没有这条「connected 转换下发」，退化 PTY 会终身保持（提示符/回显
  // 缺失的另一半根因）。重连（disconnected→connected）同样经此重发。
  useEffect(() => {
    if (status !== "connected") return;
    const term = termRef.current;
    if (!term) return;
    resizeSession(sessionId, term.cols, term.rows);
  }, [status, sessionId]);

  // 设置页字体/字号变更（外观分节广播 ottr://terminal-settings）→ 活动终端
  // 实时应用 + 重排版（新终端创建时同样读取）。null = 恢复默认值——
  // **必须无条件赋值**：xterm options 赋空/默认才回得去，按 truthiness 跳过
  // 会让「系统默认」选项在运行中失效（切回默认不还原）。
  useEffect(() => {
    const apply = () => {
      const term = termRef.current;
      if (!term) return;
      const s = loadTerminalSettings();
      term.options.fontFamily = s.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
      term.options.fontSize = s.fontSize ?? 13;
      try {
        fitRef.current?.fit();
      } catch {
        // 尺寸不可测（隐藏/未布局）忽略，RO 会兜
      }
    };
    window.addEventListener("ottr://terminal-settings", apply);
    return () => window.removeEventListener("ottr://terminal-settings", apply);
  }, []);

  // --- 一次性装配：term 实例 + sink 注册 + 击键接线 + 尺寸观测 ---
  useEffect(() => {
    // B8：allowProposedApi 开启——ghost text 的 registerDecoration 是 xterm
    // proposed API（未开则抛 "You must set the allowProposedApi option"）；
    // 对既有面零行为变化，只解锁装饰 API。字体族/字号读终端设置
    // （设置页外观分节，2026-10-09）。
    const termSettings = loadTerminalSettings();
    const term = new XTerm({
      cursorBlink: true,
      fontSize: termSettings.fontSize ?? 13,
      fontFamily: termSettings.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // URL 检测（A8）：WebLinksAddon 默认 handler（新窗打开链接）
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    fitRef.current = fit;
    const search = new SearchController(term);
    if (hostRef.current) {
      try {
        term.open(hostRef.current);
      } catch {
        // 布局未就绪（隐藏窗格/测试环境）不阻塞；恢复可见时 RO 会再 fit
      }
    }
    applyTermTheme(term, paletteKey);
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
    // B9 sudo 密码自动填充（默认关）：PTY 出口旁路检测 `[sudo] password for`，
    // 命中 → gate（设置开 + 主密码模式）→ host 绑定 password 凭据 → 前置延迟
    // （等 sudo tcsetattr，见 SudoAutofill FILL_DELAY_MS）→ writeToSession 填充。
    const sudoDetector = new SudoPromptDetector();
    const sudoDecoder = new TextDecoder("utf-8"); // 提示是 ASCII；GBK 流的 ASCII 段同字节
    async function sudoAutofillEnabled(): Promise<boolean> {
      // 主密码模式限定（裁定：keyring 模式即使键为 true 也不生效——显式解锁
      // 语义是这条安全功能的前提）；settings 不可达 = 安全侧默认关。
      if (useVaultLockStore.getState().mode !== "password") return false;
      try {
        return (await vaultApi.settings.get<boolean>(SUDO_AUTOFILL_SETTING_KEY)) === true;
      } catch {
        return false;
      }
    }
    /** 取密链：session → host → 绑定凭据；仅 password 类（key/totp/ftp 不适用）。 */
    async function sudoAutofillSecret(): Promise<{ secret: string | null; reason: SudoSkipReason | null }> {
      const session = useSessionStore.getState().sessions.find((x) => x.id === sessionId);
      if (!session) return { secret: null, reason: "no-host" };
      const { hosts, credentials } = useVaultStore.getState();
      const host = hosts.find((h) => h.id === session.hostId);
      const cred =
        host?.credential_id != null
          ? credentials.find((c) => c.id === host.credential_id)
          : undefined;
      if (!cred) return { secret: null, reason: "no-credential" };
      if (cred.kind !== "password") return { secret: null, reason: "not-password" };
      try {
        const secret = await vaultApi.credentials.reveal(cred.id, "secret");
        return { secret, reason: null };
      } catch {
        return { secret: null, reason: "no-credential" };
      }
    }
    function warnSudo(): void {
      term.writeln(`\x1b[33m[ottr] ${t("terminal.sudoAutofillUnavailable")}\x1b[0m`);
    }
    async function fireSudoAutofill(): Promise<void> {
      if (!(await sudoAutofillEnabled())) return; // 默认关：完全静默
      const { secret, reason } = await sudoAutofillSecret();
      if (secret === null) {
        // 配置了填充但取不到可用的密码凭据：明说（不是静默吞）
        if (reason === "no-host" || reason === "no-credential" || reason === "not-password") {
          warnSudo();
        }
        return;
      }
      await runSudoAutofill({
        getSecret: async () => secret,
        fill: writeToSession,
        onSkip: warnSudo,
      });
    }
    function observeSudoOutput(bytes: Uint8Array): void {
      const text = sudoDecoder.decode(bytes, { stream: true });
      if (text && sudoDetector.feed(text, Date.now())) void fireSudoAutofill();
    }
    sudoResetRef.current = () => sudoDetector.reset();
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
      write: (bytes) => {
        observeSudoOutput(bytes); // B9 sudo 提示检测（旁路，不改流）
        trzsz.processServerOutput(bytes);
      },
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
          // 缺陷 45：integrated=false（D-only 无完整集成）= 文本实为输出行——
          // 历史入库（record.ts 内再判）与补全缓存同门停用（宁缺勿污）。
          if (!ev.integrated) return;
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
    ghost.setColor(
      resolveTerminalTheme(paletteKey, useTerminalThemeStore.getState()).brightBlack ?? "#808080",
    ); // 语义令牌：ANSI 注释灰（跟随当前终端配色，非固定品牌值）
    ghostRef.current = ghost;

    // 击键 → B11 危险输入观察（旁路，不消费）→ ghost 前置语义 → trzsz 过滤器 →
    // PTY（传输态库吞键入；空闲透传）
    const onData = term.onData((d) => {
      observeDangerInput(d);
      if (ghost.handleData(d)) return; // Tab 采纳/Esc 忽略已消费，不进 PTY
      trzsz.processTerminalInput(d);
    });

    // B11 输入侧防呆：维护「当前输入行」缓冲（shell 拥有行编辑，这里只见
    // 本会话键入的字符——↑召回/Tab 补全不可见，由确认交互兜底）并逐键 classify；
    // red/yellow 命中 → 行内提醒（同类 30s 限频）；回车清行撤提醒。
    function observeDangerInput(d: string) {
      if (d === "\r" || d === "\n") {
        lineBufRef.current = "";
        setDangerHint(null);
        return;
      }
      if (d === "\x7f" || d === "\b") {
        lineBufRef.current = lineBufRef.current.slice(0, -1);
        return;
      }
      if (d.startsWith("\x1b")) return; // 方向键等控制序列（无文本语义）
      lineBufRef.current = (lineBufRef.current + d).slice(-2000);
      inputWatchRef.current ??= new InputDangerWatch();
      const finding = inputWatchRef.current.observe(lineBufRef.current, Date.now());
      if (finding) setDangerHint(finding);
    }

    // 选择即复制（可配，右键菜单切换；设置即时读 localStorage 免订阅）
    const onSelectionChange = term.onSelectionChange(() => {
      if (!loadTerminalSettings().copyOnSelect) return;
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      }
    });

    // 可见尺寸变化 → fit（切标签/拖分隔条/窗口缩放）。0 尺寸（隐藏）跳过。
    let degenerateTries = 0;
    let observed = false;
    const ro = new ResizeObserver(() => refitNow());
    const ensureObserved = () => {
      if (!observed && hostRef.current) {
        ro.observe(hostRef.current);
        observed = true;
      }
    };
    const refitNow = () => {
      const el = hostRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      ensureObserved();
      try {
        fit.fit();
      } catch {
        return; // 退化尺寸抛错：留待延迟/焦点重测
      }
      trzsz.setTerminalColumns(term.cols); // 进度条按列宽重绘
      // 缺陷 34：fit 后把真实尺寸下发给 PTY（2×1 退化 attach 尺寸的修复面；
      // 同尺寸去重在 SessionStore.resizeSession 内）。
      resizeSession(sessionId, term.cols, term.rows);
      // 退化尺寸（<4 列）而容器其实有宽度 → 布局/字体未稳，rAF 重测（≤8 次）：
      // 会话恢复后首测 1 列竖排（用户实测）即此类一次性退化且 RO 此后不再触发。
      if (term.cols < 4 && el.clientWidth > 40 && degenerateTries < 8) {
        degenerateTries += 1;
        requestAnimationFrame(() => refitNow());
      }
    };
    ensureObserved();

    // 布局迟到兜底（2026-10-09 用户实测：会话恢复后终端列宽塌成 1 列竖排）：
    // 首测退化（容器尚无宽度/字体未量完）后 RO 可能因容器尺寸不再变化而
    // 永不再触发——挂焦点/可见性/延迟重测，直到拿到非退化尺寸。
    const late = [250, 900, 2000].map((ms) => setTimeout(refitNow, ms));
    const onWinFocus = () => refitNow();
    const onVis = () => {
      if (document.visibilityState === "visible") refitNow();
    };
    window.addEventListener("focus", onWinFocus);
    document.addEventListener("visibilitychange", onVis);

    return () => {
      late.forEach((t) => clearTimeout(t));
      window.removeEventListener("focus", onWinFocus);
      document.removeEventListener("visibilitychange", onVis);
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

  // --- 主题跟随（resolved 驱动：手动切换与 system 模式的 OS 切换都实时生效；
  //     B2：终端配色选择（画廊/自定义/auto）变化同样实时生效） ---
  useEffect(() => {
    const setting: TerminalThemeSetting = { selection: termSelection, custom: termCustom };
    if (termRef.current) applyTermTheme(termRef.current, paletteKey, setting);
    // B8：ghost 灰字随主题换（ANSI brightBlack = 注释灰语义令牌）
    ghostRef.current?.setColor(resolveTerminalTheme(paletteKey, setting).brightBlack ?? "#808080");
  }, [paletteKey, termSelection, termCustom]);

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
    sudoResetRef.current?.(); // B9：旧连接的 sudo 提示缓冲随之作废
    const first = prevStatus.current === null;
    prevStatus.current = status;
    if (first && status === "connecting") {
      // 首连中（挂载即 connecting）：连接横幅（T12 验收小修：i18n 插值参数
      // 漏传导致 {{host}} 字面量直出——hostName 缺席时退回空串）
      const host = useSessionStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.hostName;
      term.writeln(`\x1b[2m[ottr] ${t("terminal.connecting", { host: host ?? "" })}\x1b[0m`);
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
      {dangerHint && <DangerHintBar finding={dangerHint} onDismiss={() => setDangerHint(null)} />}
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


// ---------------------------------------------------------------------------
// 分屏主区（布局渲染 + 分隔条拖拽 + 搜索栏 + ⌘F）
// ---------------------------------------------------------------------------


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
              // 生产环境主机（B11）：红色边框防呆（CSS [data-production]）
              data-production={session.isProduction ? "true" : undefined}
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
