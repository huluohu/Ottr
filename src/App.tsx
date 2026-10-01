// App（Task 7 重构）：单页 = 顶栏 + 主机树 + 标签化终端主区。
//
// 【条件 hooks 债清偿（终审风险③）】Phase 0 的 `?spike=` early-return 发生在
// AppContent hooks 之前，属条件分支打破 hooks 顺序约定的历史债；本重构删除
// spike UI 分支（台账裁定：scripts/ 命令面保留在 Rust 侧，UI 侧分支清除），
// App 成为单一渲染路径——没有任何条件 return，hooks 顺序恒定。
// Task 4/11 的 spike 测量页（latency/throughput/keyring/notify/render）与
// 顶栏 keyring/notify 手动验证按钮随本重构消亡。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HostTree } from "./hosts/HostTree";
import { LockScreen } from "./security/LockScreen";
import { SecuritySettings } from "./security/SecuritySettings";
import { useVaultLockStore } from "./security/VaultLockStore";
import { useVaultInitGate } from "./security/VaultInitGate";
import { syncLangFromVault, setLang, useLanguage } from "./i18n";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
import { TabBar } from "./session/TabBar";
import { HostKeyDialog } from "./session/HostKeyDialog";
import { TerminalArea } from "./terminal/Terminal";
import { FilePanel } from "./files/FilePanel";
import { ForwardPanel } from "./forward/ForwardPanel";
import { JumpChainEditor } from "./hosts/JumpChainEditor";
import { DiagnosePanel } from "./ai/DiagnosePanel";
import { AISettings } from "./ai/AISettings";
import { NLCommandPanel, nlBegin } from "./ai/NLCommandPanel";
import { setAiSettingsOpener } from "./ai/aiStore";
import { initSessionEvents } from "./session/events";
import { initTransferEvents } from "./files/events";
import { initNotifyEvents } from "./notify/core";
import { NotificationCenter } from "./notify/NotificationCenter";
import { useSessionStore } from "./session/SessionStore";
import { CommandPalette } from "./palette/CommandPalette";
import { HistorySearch } from "./history/HistorySearch";
import { stripPromptPrefix } from "./history/format";
import { TitleBar } from "./titlebar/TitleBar";
import {
  isTerminalTarget,
  matchActionEvent,
  platform,
  shortcutLabel,
  warnShortcutConflicts,
  type ActionId,
} from "./shortcuts/registry";
import { ThemeProvider, useTheme, syncThemeFromVault, type ThemeMode } from "./theme/ThemeContext";
import { useVaultStore } from "./vault/store";
import type { Host } from "./vault/api";
import "./theme/tokens.css";
import "./App.css";

// 开发期哨兵：键位表冲突即 console.warn（见 registry.ts）。
warnShortcutConflicts();

// 平台口径（键位提示 / 命令面板 hint）：模块级只判一次。
const PLATFORM = platform();

// Tauri 运行时标记（标题栏只在其下渲染；纯浏览器 dev 无窗口控制可调）。
const IS_TAURI = "__TAURI_INTERNALS__" in window;

// A12：macOS 原生菜单动作回传事件（Rust menu.rs 把 ActionId 字符串转发过来）。
const MENU_ACTION_EVENT = "ottr://menu-action";

// 主题切换器（A10）：手动验证入口 + Task 8 设置页前的临时控件。
const THEME_MODES: { value: ThemeMode; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();
  return (
    <div className="theme-switch" role="group" aria-label={t("settings.theme")}>
      {THEME_MODES.map(({ value, labelKey }) => (
        <button
          key={value}
          data-active={mode === value}
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

// --- 主页布局 ----------------------------------------------------------------

type FormState = { mode: "new"; groupId: number | null } | { mode: "edit"; host: Host } | null;

/** 左栏宽（裁定 #2：暂记 localStorage，settings 表落地后迁移）。 */
const SIDEBAR_KEY = "ottr.layout.sidebarWidth";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
}

function HomeLayout() {
  const { t } = useTranslation();
  // T11（A7）：安全底座——锁定遮罩盖全屏（password 模式）；设置对话框入口在顶栏。
  const lockPhase = useVaultLockStore((s) => s.phase);
  const hosts = useVaultStore((s) => s.hosts);
  const storeError = useVaultStore((s) => s.error);
  // 会话面（Task 7）：标签条 + 分屏终端主区（Task 8） + host key 确认框
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const openTab = useSessionStore((s) => s.openTab);
  // A12：面板动作需要当前主题/语言（toggle 循环用）
  const { mode: themeMode, setMode } = useTheme();
  const { lang } = useLanguage();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // T15：⌘R 历史搜索面板（registry history.search；终端内放行 PTY 见 registry）
  const [historyOpen, setHistoryOpen] = useState(false);
  // Phase 2 B1（Task 6）：⌘J NL→命令输入条（registry ai.nl2cmd；全局直呼，
  // 终端内也命中——begin 的 cwd 锚点在 nlBegin 里按聚焦 pane 查 CwdTracker）
  const [nlOpen, setNlOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // T13：AI 设置对话框（诊断面板 noProvider/noKey 引导、顶栏 AI 按钮两个入口）
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  // Phase 2 Task 1（B7）：端口转发中心（顶栏入口——转发是全局配置面：
  // 面板列全部主机的转发、运行态跨标签可见；绑定主机经表单下拉选择）。
  const [forwardsOpen, setForwardsOpen] = useState(false);
  // Phase 2 Task 2（B7 下半）：跳板链编辑器（顶栏入口——链是全局配置面，
  // 主机经 HostForm 的链下拉绑定）。
  const [jumpChainsOpen, setJumpChainsOpen] = useState(false);
  // Task 16.5 就绪门：vault 后台初始化（钥匙链访问）完成前不发首批 vault 命令
  // （State 未 manage 时命令被 Tauri 拒绝）。纯浏览器 dev / vitest 无 Tauri
  // 运行时，初始值即 ready 直通——门只在真 Tauri 环境生效。
  const initPhase = useVaultInitGate((s) => (IS_TAURI ? s.phase : "ready"));
  const initError = useVaultInitGate((s) => s.error);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_KEY);
      if (raw !== null) return clampSidebarWidth(Number(raw));
    } catch {
      // localStorage 不可用 → 默认宽度
    }
    return 280;
  });
  const resizing = useRef(false);

  // Task 16.5 就绪门取数（仅 Tauri）：先挂事件监听、后查 vault_init_status
  // （两端夹逼无漏窗，见 VaultInitGate 模块文档）。
  useEffect(() => {
    if (!IS_TAURI) return;
    void useVaultInitGate.getState().init();
  }, []);

  // 首屏（vault 就绪后走 T11 既有启动链）：锁定状态机 → vault 数据 → 会话事件
  // 监听 → 标签恢复（不自动连接，安全考虑见 SessionStore.restoreTabs）。恢复依
  // 赖 hosts 就位，故排在 refresh 之后。T11：锁定状态机先查 status（password 模
  // 式锁定时 refresh 会被 Locked 门卫拒，错误横幅由遮罩盖住，解锁后用户手动重试
  // 即可——锁屏优先是预期行为）。
  useEffect(() => {
    if (initPhase !== "ready") return;
    void (async () => {
      await useVaultLockStore.getState().init();
      void syncLangFromVault();
      // T17 F1（T16.5 转办）：主题真源对齐/迁移同样必须等 vault 就绪——
      // ThemeProvider 挂载期调用会被未 manage 的 State 拒绝而静默降级缓存。
      void syncThemeFromVault();
      try {
        await useVaultStore.getState().refresh();
      } catch {
        // 失败由 store.error 驱动主区错误横幅；恢复跳过（无主机可查）
      }
      await initSessionEvents();
      await initTransferEvents();
      // T12（spec §7）：通知管线接线（transfer-end / session-closed → 中心）。
      // 在事件源初始化之后挂（管线订阅既有事件，顺序无依赖，晚挂只漏启动窗口期事件）。
      await initNotifyEvents();
      useSessionStore.getState().restoreTabs(useVaultStore.getState().hosts);
    })();
  }, [initPhase]);

  // T13：设置页路由钩子注入（aiStore 错误面「去设置」按钮 → 打开 AI 设置）
  useEffect(() => {
    setAiSettingsOpener(() => setAiSettingsOpen(true));
    return () => setAiSettingsOpener(null);
  }, []);

  // A12 动作收口：面板 / 全局快捷键 / （Task 14 后续提交）原生菜单事件、
  // 汉堡菜单——一处 action 多入口，全部汇到 handleAction。
  const handleAction = useCallback(
    (action: ActionId) => {
      switch (action) {
        case "palette.toggle":
          setPaletteOpen((v) => !v);
          break;
        case "history.search":
          setHistoryOpen((v) => !v);
          break;
        case "ai.nl2cmd":
          // 打开 = 清场 + 聚焦 pane 的 cwd 锚点（OSC7 活值）；关闭 = 顺带清场
          // （在途请求 abort，panel 卸载后 store 不留尾巴）。副作用在 updater
          // 外（StrictMode 下 updater 可能双调）。
          nlBegin();
          setNlOpen((v) => !v);
          break;
        case "hosts.new":
          setForm({ mode: "new", groupId: null });
          break;
        case "settings.open":
          setSettingsOpen(true);
          break;
        case "theme.toggle":
          setMode(themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light");
          break;
        case "lang.toggle":
          setLang(lang === "zh-CN" ? "en-US" : "zh-CN");
          break;
        case "session.splitRight":
        case "session.splitDown": {
          const s = useSessionStore.getState();
          if (s.activeId) s.splitPane(s.activeId, action === "session.splitRight" ? "row" : "column");
          break;
        }
        case "vault.lock":
          void useVaultLockStore.getState().lock();
          break;
        case "app.quit":
          // 真退出（不走 close-to-tray 拦截路径）；非 Tauri 环境静默。
          invoke("quit_app").catch(() => {});
          break;
      }
    },
    [themeMode, setMode, lang],
  );

  // 全局快捷键：registry 驱动（⌘K 面板 / ⌘N 新建主机 / ⌘, 设置 / 分屏…，
  // win/linux 同键位 Ctrl 系）。面板 input 内的 Esc/↑↓/Enter 由组件自管。
  // 评审 M-4 终端聚焦守卫：target 在终端容器内时只放行 terminalSafe 动作
  // （Shift 系分屏 + ⌘K），其余不拦截——Ctrl+D（EOF）等控制键原样到 PTY。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchActionEvent(e, PLATFORM, isTerminalTarget(e.target));
      if (action) {
        e.preventDefault();
        handleAction(action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleAction]);

  // A12：macOS 原生菜单 → 前端动作（设置/新建主机/分屏/面板）。Rust 侧已就
  // 地处理退出与缩放，这里只收前端动作；纯浏览器 dev 无菜单不挂监听。
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listen<string>(MENU_ACTION_EVENT, (e) => {
          handleAction(e.payload as ActionId);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        // 监听失败不阻塞（菜单动作缺失属降级，不打断主功能）
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleAction]);

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      if (resizing.current) setSidebarWidth(clampSidebarWidth(startWidth + ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      resizing.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const finalWidth = clampSidebarWidth(startWidth + ev.clientX - startX);
      setSidebarWidth(finalWidth);
      try {
        localStorage.setItem(SIDEBAR_KEY, String(finalWidth));
      } catch {
        // 持久化失败不阻塞
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const selected = hosts.find((h) => h.id === selectedId) ?? null;
  const terminalMode = sessions.length > 0;
  // 文件面板（Task 10，A5）：主区视图切换（终端 | 文件）。全局开关——面板跟随
  // 活动标签；终端以 visibility 隐藏常驻（xterm 缓冲不丢，同 pane 惯例）。
  const [filesOpen, setFilesOpen] = useState(false);
  const activeSession =
    sessions.find((s) => s.id === activeId) ??
    sessions.find((s) => s.paneOf === activeId) ??
    null;
  const rootSession = activeSession
    ? (sessions.find((s) => s.id === (activeSession.paneOf ?? activeSession.id)) ?? null)
    : null;
  // FTP/FTPS 会话（Phase 2 Task 5）：无 PTY 终端——主区强制文件视图
  // （filesOnly），「终端」切换按钮隐藏；SSH 会话维持双视图切换。
  const filesOnly =
    rootSession?.protocol === "ftp" || rootSession?.protocol === "ftps";
  const filesVisible = filesOpen || filesOnly;

  return (
    <div className="app-shell">
      {/* A12：Win/Linux 自绘标题栏（decorations:false 的窗口壳；mac 不渲染走
          原生红绿灯 + 系统菜单栏）。动作收口同一 handleAction。 */}
      {PLATFORM !== "mac" && IS_TAURI && (
        <TitleBar plat={PLATFORM} onAction={handleAction} />
      )}
      <header className="topbar">
        <span className="topbar-title">Ottr</span>
        <button className="topbar-palette" data-testid="open-palette" onClick={() => setPaletteOpen(true)}>
          {t("palette.title")} <kbd>{shortcutLabel("palette.toggle", PLATFORM)}</kbd>
        </button>
        <button className="topbar-debug" data-testid="open-credentials" onClick={() => setCredentialsOpen(true)}>
          {t("credentials.openButton")}
        </button>
        <button
          className="topbar-debug"
          data-testid="open-settings"
          aria-label={t("settings.title")}
          onClick={() => setSettingsOpen(true)}
        >
          {t("settings.title")}
        </button>
        <button
          className="topbar-debug"
          data-testid="open-ai-settings"
          aria-label={t("ai.settings.title")}
          onClick={() => setAiSettingsOpen(true)}
        >
          {t("ai.title")}
        </button>
        <button
          className="topbar-debug"
          data-testid="open-forwards"
          aria-label={t("forward.title")}
          onClick={() => setForwardsOpen(true)}
        >
          {t("forward.title")}
        </button>
        <button
          className="topbar-debug"
          data-testid="open-jump-chains"
          aria-label={t("jump.title")}
          onClick={() => setJumpChainsOpen(true)}
        >
          {t("jump.title")}
        </button>
        <div className="topbar-spacer" />
        <NotificationCenter />
        <ThemeSwitch />
      </header>
      <div className="app-body">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <HostTree
            selectedId={selectedId}
            onSelect={(host) => setSelectedId(host.id)}
            onOpen={(host) => openTab(host)}
            onEdit={(host) => setForm({ mode: "edit", host })}
            onAdd={(groupId) => setForm({ mode: "new", groupId })}
            onImport={() => setImportOpen(true)}
          />
        </aside>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startResize}
          data-testid="sidebar-resizer"
        />
        {terminalMode ? (
          <main className="main-area terminal-mode" data-testid="main-area">
            <div className="tabbar-row">
              <TabBar />
              <div className="view-switch" role="group" aria-label={t("files.viewSwitch")}>
                {!filesOnly && (
                  <button
                    data-testid="view-terminal"
                    data-active={!filesOpen}
                    aria-pressed={!filesOpen}
                    onClick={() => setFilesOpen(false)}
                  >
                    {t("files.viewTerminal")}
                  </button>
                )}
                <button
                  data-testid="view-files"
                  data-active={filesVisible}
                  aria-pressed={filesVisible}
                  onClick={() => setFilesOpen(true)}
                >
                  {t("files.viewFiles")}
                </button>
              </div>
            </div>
            {/* 终端隐藏常驻（Task 10）：visibility 而非卸载——xterm 缓冲/滚动回看不丢。
                T13：AI 诊断面板 = 终端视图的右侧栏（文件视图让位——面板依赖终端选区）。 */}
            <div className="term-main-row">
              {/* data-terminal = 终端聚焦守卫的判定容器（评审 M-4）：覆盖全部
                  pane（含 xterm 隐藏 textarea），文件视图/AI 面板在其外不受守卫。 */}
              <div
                className="term-area-holder"
                data-hidden={filesVisible}
                data-terminal=""
              >
                <TerminalArea />
              </div>
              {!filesVisible && <DiagnosePanel onOpenSettings={() => setAiSettingsOpen(true)} />}
            </div>
            {filesVisible && rootSession && <FilePanel session={rootSession} />}
          </main>
        ) : (
          <main className="main-area" data-testid="main-area">
            {storeError && (
              <p className="main-error" data-testid="store-error">
                {t("mainArea.loadFailed", { message: storeError })}
              </p>
            )}
            {selected ? (
              <section className="main-placeholder">
                <p className="placeholder-caption">{t("mainArea.selected")}</p>
                <h2>{selected.name}</h2>
                <p className="placeholder-mono">
                  {selected.username ? `${selected.username}@` : ""}
                  {selected.address}:{selected.port}
                </p>
                <p>{t("mainArea.openHint")}</p>
              </section>
            ) : (
              <section className="main-placeholder">
                <p>{t("mainArea.placeholder")}</p>
              </section>
            )}
          </main>
        )}
      </div>

      {form && (
        <HostForm
          host={form.mode === "edit" ? form.host : null}
          defaultGroupId={form.mode === "new" ? form.groupId : null}
          onClose={() => setForm(null)}
        />
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      {credentialsOpen && <CredentialsDialog onClose={() => setCredentialsOpen(false)} />}
      <SecuritySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AISettings open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />
      {/* Phase 2 Task 1（B7 上半）：端口转发中心（顶栏入口对话框）。 */}
      <ForwardPanel open={forwardsOpen} onClose={() => setForwardsOpen(false)} />
      {/* Phase 2 Task 2（B7 下半）：跳板链编辑器（顶栏入口对话框）。 */}
      <JumpChainEditor open={jumpChainsOpen} onClose={() => setJumpChainsOpen(false)} />
      <HostKeyDialog />
      {/* T11 锁定遮罩：盖在一切之上（最后渲染保证 z 序）；boot 阶段不遮防闪烁。 */}
      {lockPhase === "locked" && <LockScreen />}
      {/* Task 16.5 vault 初始化门遮罩（LockScreen 同款 overlay，z 序在锁屏之上——
          初始化未完成时锁屏状态机尚未启动，两者互斥）。loading 期主壳无数据、
          无命令在途；failed 语义 = 旧的「setup 失败即启动失败」，只是主窗已可见：
          全屏错误面 + 退出按钮（真退出绕过关窗到托盘拦截）。 */}
      {initPhase === "initializing" && (
        <div className="overlay lock-screen" data-testid="vault-init-loading" role="status">
          <div className="dialog lock-card">
            <h2>Ottr</h2>
            <p className="dialog-intro">{t("security.vaultInit.loading")}</p>
          </div>
        </div>
      )}
      {initPhase === "failed" && (
        <div className="overlay lock-screen" data-testid="vault-init-failed" role="alert">
          <div className="dialog lock-card">
            <h2>{t("security.vaultInit.failedTitle")}</h2>
            <p className="form-error" data-testid="vault-init-error">
              {initError}
            </p>
            <p className="dialog-intro">{t("security.vaultInit.failedHint")}</p>
            <div className="form-actions">
              <button
                type="button"
                className="btn-accent"
                data-testid="vault-init-quit"
                onClick={() => invoke("quit_app").catch(() => {})}
              >
                {t("security.vaultInit.quit")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* A12 命令面板（T5 QuickConnect 并入收口）：主机 + 命令统一搜索。
          动作经 handleAction 分派；连主机即开标签。 */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        hosts={hosts}
        onConnect={(host) => {
          openTab(host);
          setPaletteOpen(false);
        }}
        onAction={(action) => {
          setPaletteOpen(false);
          handleAction(action);
        }}
        plat={PLATFORM}
      />
      {/* T15 历史搜索面板（⌘R）：跨主机命令历史 FTS 检索；回车把命令写进当前
          聚焦 pane（剥提示符前缀——CommandWatch 提取含提示符原文；不带换行，
          落在输入行由用户确认执行）。 */}
      <HistorySearch
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        hosts={hosts}
        onInsert={(command) => {
          useSessionStore.getState().insertToFocusedPane(stripPromptPrefix(command));
          setHistoryOpen(false);
        }}
        plat={PLATFORM}
      />
      {/* Phase 2 B1（Task 6）⌘J NL→命令输入条：底部锚定；生成结果走公共
          InsertRow 的 danger 三档确认插终端（聚焦 pane 的 rustId 面板内解析）。 */}
      <NLCommandPanel
        open={nlOpen}
        onClose={() => setNlOpen(false)}
        onOpenSettings={() => setAiSettingsOpen(true)}
      />
    </div>
  );
}

/** ThemeProvider 挂在最外层：单一渲染路径（spike 分支已删，hooks 顺序恒定）。 */
export default function App() {
  return (
    <ThemeProvider>
      <HomeLayout />
    </ThemeProvider>
  );
}
