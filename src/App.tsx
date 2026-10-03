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
import { SyncDialog } from "./sync/SyncDialog";
// Phase 4 Task 3（C1）：exec 逐次审批确认框（事件驱动、全局挂载；McpSettings
// 对话框本体 T4 迁入右侧 dock——本任务自 App 停挂）。
import { McpApprovalDialog } from "./security/McpApprovalDialog";
import { useVaultLockStore } from "./security/VaultLockStore";
import { useVaultInitGate } from "./security/VaultInitGate";
import { syncLangFromVault, setLang, useLanguage } from "./i18n";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
import { HostKeyDialog } from "./session/HostKeyDialog";
import { AISettings } from "./ai/AISettings";
import { NLCommandPanel, nlBegin } from "./ai/NLCommandPanel";
import { setAiSettingsOpener } from "./ai/aiStore";
import { onSessionEnded } from "./ai/summary";
import { setSessionEndHook, useSessionStore } from "./session/SessionStore";
import { initSessionEvents } from "./session/events";
import { initTransferEvents } from "./files/events";
import { initNotifyEvents } from "./notify/core";
import { initAlertEngine } from "./notify/rules";
import { remountChannels } from "./notify/channelRegistry";
import { initMonitorEvents } from "./monitor/events";
import { initBatchEvents } from "./batch/events";
// cron 定时任务（Phase 4 Task 1，缺口①）：任务中心面板 + ottr://cron-run 接线
// （事件源在 Rust 调度器——宿主裁定见 commands/cron.rs；TS 侧管通知分发）。
import { initCronEvents } from "./cron/events";
import { NotificationCenter } from "./notify/NotificationCenter";
import { CommandPalette } from "./palette/CommandPalette";
import { HistorySearch } from "./history/HistorySearch";
import { stripPromptPrefix } from "./history/format";
import { TitleBar } from "./titlebar/TitleBar";
// UI 批次一 Task 2：主区视图路由 + 右侧 dock 槽位（workspaceStore 状态机）。
// 面板实体迁移分工：overview/batch 实体 T3 迁入主区槽位；forwards/jumpchains/
// cron/alerts/mcp 实体 T4 迁入 dock——本任务两处都只有占位骨架。
import { MainArea } from "./workspace/MainArea";
import { DockContainer } from "./workspace/DockContainer";
import { useWorkspaceStore } from "./workspace/workspaceStore";
import {
  isTerminalTarget,
  matchActionEvent,
  platform,
  shortcutLabel,
  warnShortcutConflicts,
  type ActionId,
} from "./shortcuts/registry";
import { ThemeProvider, useTheme, syncThemeFromVault, type ThemeMode } from "./theme/ThemeContext";
import { useTerminalThemeStore } from "./theme/terminalThemeStore";
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

// 主题三态（A10 沿用）：Phase 5 T1 顶栏收纳后由三联按钮改为单按钮下拉——
// 按钮面显示当前模式，菜单内三选一（亮 / 暗 / 跟随系统）。
const THEME_MODES: { value: ThemeMode; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

// --- 顶栏下拉菜单（Phase 5 T1 顶栏收纳） --------------------------------------
//
// 通用壳：按钮 + 弹出菜单。交互契约对齐 NotificationCenter（mousedown 在外
// 收起）+ Esc 收起；选中条目即收起并执行 onSelect。纯呈现——条目与动作全部
// 由调用方注入。条目去向两族：对话框族仍走 HomeLayout 就地 setState（凭据/
// AI/同步）；工作区族（总览/批量→主区视图，转发/跳板链/定时任务/告警/MCP→
// 右侧 dock）走 workspaceStore——registry ActionId 面零变化（T14 守卫不动）。

interface TopbarMenuItem {
  key: string;
  label: string;
  testid?: string;
  /** 主题菜单用：当前模式高亮（data-active，勾选语义）。 */
  active?: boolean;
  onSelect: () => void;
}

function TopbarMenu({
  label,
  ariaLabel,
  items,
  buttonTestid,
  menuTestid,
}: {
  label: string;
  ariaLabel: string;
  items: TopbarMenuItem[];
  buttonTestid: string;
  menuTestid: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="topbar-menu" ref={rootRef}>
      <button
        data-testid={buttonTestid}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span className="topbar-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="topbar-menu-list" data-testid={menuTestid} role="menu" aria-label={ariaLabel}>
          {items.map((item) => (
            <button
              key={item.key}
              role="menuitem"
              data-testid={item.testid}
              data-active={item.active === true}
              aria-checked={item.active === true}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 主题单按钮下拉（Phase 5 T1）：按钮面 = 当前模式名，菜单 = 三模式三选一。 */
function ThemeMenu() {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();
  const current = THEME_MODES.find((m) => m.value === mode) ?? THEME_MODES[2];
  return (
    <TopbarMenu
      label={t(current.labelKey)}
      ariaLabel={t("settings.theme")}
      buttonTestid="topbar-theme"
      menuTestid="topbar-theme-menu"
      items={THEME_MODES.map(({ value, labelKey }) => ({
        key: value,
        label: t(labelKey),
        testid: `topbar-theme-${value}`,
        active: mode === value,
        onSelect: () => setMode(value),
      }))}
    />
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
  // 会话面（Task 7）：HostTree 双击/面板连接开标签。标签条 + 终端主区的
  // 渲染面已随 UI 批次一 Task 2 迁入 workspace/MainArea（读 session store）。
  const openTab = useSessionStore((s) => s.openTab);
  // UI 批次一 Task 2：工作区视图/dock 动作（主区路由在 workspace/MainArea，
  // dock 壳在 workspace/DockContainer；互斥语义见 workspace/types.ts）。
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  const openDock = useWorkspaceStore((s) => s.openDock);
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
  // Phase 5 Task 4：同步对话框（设置页「立即同步」+ 顶栏工具菜单两个入口）。
  const [syncOpen, setSyncOpen] = useState(false);
  // T13：AI 设置对话框（诊断面板 noProvider/noKey 引导、顶栏 AI 按钮两个入口）
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  // 【UI 批次一 Task 2】原面板开关 setState（alertSettings/forwards/jumpChains/
  // overview/procs/batch/cron/mcp/filesOpen）已收口进 workspaceStore——主区视图
  // 走 MainArea 路由，工具面板走 DockContainer；T3/T4 迁实体。
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
      // B2 主题生态（Phase 2 Task 9）：终端配色选择/自定义清单同点对齐（真源
      // vault settings `ui.terminalTheme`；缓存镜像先行防闪烁，此处到达后覆盖）。
      void useTerminalThemeStore.getState().syncFromVault();
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
      // Phase 3 Task 1（B4 上半）：监控采样事件接线（ottr://monitor → store）。
      await initMonitorEvents();
      // Phase 3 Task 4（B6）：批量结果事件接线（ottr://batch-result → store）。
      await initBatchEvents();
      // Phase 4 Task 1（缺口①）：cron 运行事件接线（ottr://cron-run → store
      // + notify(kind=cron)；调度器在 Rust 侧先行，晚挂只漏启动窗口期事件）。
      await initCronEvents();
      // Phase 3 Task 3（B5）：告警规则引擎接线（订阅 ottr://monitor 评估 +
      // 进程快照轮询）+ 外部渠道挂载（notify_channels → core.channels）。
      // 都在事件源之后挂（晚挂只漏启动窗口期采样）；挂载失败各自静默降级。
      await initAlertEngine();
      void remountChannels();
      useSessionStore.getState().restoreTabs(useVaultStore.getState().hosts);
    })();
  }, [initPhase]);

  // T13：设置页路由钩子注入（aiStore 错误面「去设置」按钮 → 打开 AI 设置）
  useEffect(() => {
    setAiSettingsOpener(() => setAiSettingsOpen(true));
    return () => setAiSettingsOpener(null);
  }, []);

  // Phase 2 Task 7（B1 会话纪要）：会话收尾钩子注入——closeTab / disconnect /
  // 重连耗尽时异步生成纪要（onSessionEnded fire-and-forget，失败静默不反噬）。
  useEffect(() => {
    setSessionEndHook(onSessionEnded);
    return () => setSessionEndHook(null);
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
        <div className="topbar-spacer" />
        {/* Phase 5 T1 顶栏收纳：低频面板入口收进「工具」下拉；高频入口
            （⌘K 面板 / 通知铃 / 设置 / 主题）保留在栏面。顺序 = 用户口径：
            凭据/告警/MCP/AI/端口转发/跳板链/总览/批量执行/定时任务（AI 助手
            原为栏面按钮，为「每个原入口都可达」一并收纳于此）。
            【UI 批次一 Task 2】工作区族条目改调 workspaceStore：总览/批量 →
            openMainView（主区互斥视图，T3 迁实体）；端口转发/跳板链/定时任务/
            告警/MCP → openDock（右侧 dock 单槽，T4 迁实体）。registry 动作 ID
            零新增零删除。 */}
        <TopbarMenu
          label={t("topbar.tools")}
          ariaLabel={t("topbar.tools")}
          buttonTestid="topbar-tools"
          menuTestid="topbar-tools-menu"
          items={[
            {
              key: "credentials",
              label: t("credentials.openButton"),
              testid: "menu-open-credentials",
              onSelect: () => setCredentialsOpen(true),
            },
            {
              key: "alerts",
              label: t("alert.sectionTitle"),
              testid: "menu-open-alert-settings",
              onSelect: () => openDock("alerts"),
            },
            {
              key: "mcp",
              label: t("mcp.title"),
              testid: "menu-open-mcp-settings",
              onSelect: () => openDock("mcp"),
            },
            {
              key: "ai",
              label: t("ai.title"),
              testid: "menu-open-ai-settings",
              onSelect: () => setAiSettingsOpen(true),
            },
            {
              key: "forwards",
              label: t("forward.title"),
              testid: "menu-open-forwards",
              onSelect: () => openDock("forwards"),
            },
            {
              key: "jump-chains",
              label: t("jump.title"),
              testid: "menu-open-jump-chains",
              onSelect: () => openDock("jumpchains"),
            },
            {
              key: "overview",
              label: t("overview.title"),
              testid: "menu-open-overview",
              onSelect: () => openMainView("overview"),
            },
            {
              key: "batch",
              label: t("batch.title"),
              testid: "menu-open-batch",
              onSelect: () => openMainView("batch"),
            },
            {
              key: "cron",
              label: t("cron.title"),
              testid: "menu-open-cron",
              onSelect: () => openDock("cron"),
            },
            {
              key: "sync",
              label: t("sync.sectionTitle"),
              testid: "menu-open-sync",
              onSelect: () => setSyncOpen(true),
            },
          ]}
        />
        <NotificationCenter />
        <button
          className="topbar-debug"
          data-testid="open-settings"
          aria-label={t("settings.title")}
          onClick={() => setSettingsOpen(true)}
        >
          {t("settings.title")}
        </button>
        <ThemeMenu />
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
        {/* 主区视图路由（UI 批次一 Task 2）：mainView 状态机五视图切换；终端
            隐藏常驻不变量在 MainArea 内执行（非 terminal 视图 visibility 隐藏，
            运行中会话不卸载）。 */}
        <MainArea
          storeError={storeError}
          selected={selected}
          onOpenAiSettings={() => setAiSettingsOpen(true)}
        />
        {/* 右侧 dock 槽位（UI 批次一 Task 2）：工具面板统一停靠壳（单槽互斥，
            openDock 换值即替换）；占位骨架，T4 迁实体面板。 */}
        <DockContainer />
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
      <SecuritySettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenSyncDialog={() => setSyncOpen(true)}
      />
      {/* Phase 5 Task 4：同步流程对话框（在设置对话框之后渲染 = 叠于其上）。 */}
      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
      <AISettings open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />
      {/* 【UI 批次一 Task 2】原对话框面板（AlertSettings/ForwardPanel/
          JumpChainEditor/OverviewPage/BatchPanel/CronPanel/McpSettings）已停挂——
          实体 T4 迁入右侧 dock（alerts/forwards/jumpchains/cron/mcp）、T3 迁入
          主区视图（overview/batch）；工具菜单条目现在打开对应 workspace 槽位。 */}
      {/* Phase 4 Task 3（C1）：exec 逐次审批确认框（事件驱动，无事件即不渲染）——
          与 McpSettings 对话框本体分离，MCP 实体迁 dock（T4）后照常全局挂载。 */}
      <McpApprovalDialog />
      {/* A12 命令面板（T5 QuickConnect 并入收口）：主机 + 命令统一搜索。
          动作经 handleAction 分派；连主机即开标签。 */}
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
