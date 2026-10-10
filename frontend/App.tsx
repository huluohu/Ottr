// App（Task 7 重构）：单页 = 顶栏 + 主机树 + 标签化终端主区。
//
// 【条件 hooks 债清偿（终审风险③）】Phase 0 的 `?spike=` early-return 发生在
// AppContent hooks 之前，属条件分支打破 hooks 顺序约定的历史债；本重构删除
// spike UI 分支（台账裁定：scripts/ 命令面保留在 Rust 侧，UI 侧分支清除），
// App 成为单一渲染路径——没有任何条件 return，hooks 顺序恒定。
// Task 4/11 的 spike 测量页（latency/throughput/keyring/notify/render）与
// 顶栏 keyring/notify 手动验证按钮随本重构消亡。
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "./app/Sidebar";
import { Toaster } from "./ui/Toaster";
import { showToast } from "./ui/toastStore";
import { useUpdateStore } from "./update/updateStore";
import { useTranslation } from "react-i18next";
import { LockScreen } from "./security/LockScreen";
import { SecuritySettings } from "./security/SecuritySettings";
import { SyncDialog } from "./sync/SyncDialog";
// Phase 4 Task 3（C1）：exec 逐次审批确认框（事件驱动、全局挂载；McpSettings
// 对话框本体 T4 迁入右侧 dock——本任务自 App 停挂）。
import { McpApprovalDialog } from "./security/McpApprovalDialog";
import { useVaultLockStore } from "./security/VaultLockStore";
import { useVaultInitGate } from "./security/VaultInitGate";
import { VaultInitGateOverlay } from "./security/VaultInitGateOverlay";
import { syncLangFromVault, setLang, useLanguage } from "./i18n";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
import { HostKeyDialog } from "./session/HostKeyDialog";
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
import { CommandPalette } from "./palette/CommandPalette";
import { HistorySearch } from "./history/HistorySearch";
import { stripPromptPrefix } from "./history/format";
import { TitleBar } from "./titlebar/TitleBar";
// UI 批次一 Task 2/4：主区视图路由 + 右侧 dock 实体壳（workspaceStore 状态机）。
// 面板实体迁移分工：overview/batch 实体 T3 迁入主区槽位；forwards/jumpchains/
// cron/alerts/mcp 实体 T4 迁入 dock（实体渲染在 dock/DockPanel 内）。
import { MainArea } from "./workspace/MainArea";
import { DockPanel } from "./dock/DockPanel";
import { useWorkspaceStore } from "./workspace/workspaceStore";
import {
  isTerminalTarget,
  matchActionEvent,
  platform,
  warnShortcutConflicts,
  type ActionId,
} from "./shortcuts/registry";
import { ThemeProvider, useTheme, syncThemeFromVault } from "./theme/ThemeContext";
import { useTerminalThemeStore } from "./theme/terminalThemeStore";
import { useVaultStore } from "./vault/store";
import { vaultApi, type Host } from "./vault/api";
import "./theme/tokens.css";
import "./styles/index.css";

// 开发期哨兵：键位表冲突即 console.warn（见 registry.ts）。
warnShortcutConflicts();

// 平台口径（键位提示 / 命令面板 hint）：模块级只判一次。
const PLATFORM = platform();

// Tauri 运行时标记（标题栏只在其下渲染；纯浏览器 dev 无窗口控制可调）。
const IS_TAURI = "__TAURI_INTERNALS__" in window;

// A12：macOS 原生菜单动作回传事件（Rust menu.rs 把 ActionId 字符串转发过来）。
const MENU_ACTION_EVENT = "ottr://menu-action";

// --- 顶栏下拉菜单（Phase 5 T1 顶栏收纳） --------------------------------------
//
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
  // T11（A7）：安全底座——锁定遮罩盖全屏（password 模式）；设置入口在应用菜单（⌘,）。
  const lockPhase = useVaultLockStore((s) => s.phase);
  const hosts = useVaultStore((s) => s.hosts);
  const storeError = useVaultStore((s) => s.error);
  // 会话面（Task 7）：HostTree 双击/面板连接开标签。标签条 + 终端主区的
  // 渲染面已随 UI 批次一 Task 2 迁入 workspace/MainArea（读 session store）。
  const openTab = useSessionStore((s) => s.openTab);
  // UI 批次一 Task 2：工作区视图/dock 动作（主区路由在 workspace/MainArea，
  // dock 壳在 dock/DockPanel；互斥语义见 workspace/types.ts）。
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
  // 检查更新（四端入口）：就地检查 + toast 反馈，不打开设置页（用户裁定）。
  const updatePhase = useUpdateStore((s) => s.phase);
  const updateCheckFn = useUpdateStore((s) => s.checkForUpdate);
  const updateInstallFn = useUpdateStore((s) => s.downloadAndInstall);
  const updateLoadCurrent = useUpdateStore((s) => s.loadCurrent);
  const { t: tUpdate } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 托盘状态行会话计数同步（menu_set_tray_status；非 Tauri 环境 no-op）。
  const sessionCount = useSessionStore((s) => s.sessions.length);
  useEffect(() => {
    if (!IS_TAURI) return;
    invoke("menu_set_tray_status", { count: sessionCount }).catch(() => {});
  }, [sessionCount]);
  useEffect(() => {
    updateLoadCurrent();
  }, [updateLoadCurrent]);
  // 定向打开设置分区（AI 跳转/检查更新入口）；null = 默认安全区。
  const [settingsPane, setSettingsPane] = useState<null | import("./security/SecuritySettings").SettingsPane>(null);
  const openSettingsToPane = (pane: "ai" | "about") => {
    setSettingsPane(pane);
    setSettingsOpen(true);
  };
  // Phase 5 Task 4：同步对话框（设置页「立即同步」+ 顶栏工具菜单两个入口）。
  const [syncOpen, setSyncOpen] = useState(false);
  // T13：AI 设置对话框（诊断面板 noProvider/noKey 引导、顶栏 AI 按钮两个入口）
  // 【UI 批次一 Task 2】原面板开关 setState（alertSettings/forwards/jumpChains/
  // overview/procs/batch/cron/mcp/filesOpen）已收口进 workspaceStore——主区视图
  // 走 MainArea 路由，工具面板走 dock/DockPanel；T3/T4 迁实体。
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

  // 新建分组信号（File 菜单/汉堡 hosts.new_group → HostTree 分组态；计数即触发）
  const [newGroupSignal, setNewGroupSignal] = useState(0);
  // theme-suite T1：工具菜单「导出主机 CSV」反馈（2026-10-10 起）——
  // 顶部行内状态条废弃（用户反馈路径直接糊在页面顶部太丑），改右下角
  // Toast（ui/toastStore，6 秒自动消失，成功 info / 失败 error）。

  /** 工具动作单一来源（2026-10-08 菜单栏启用批次）：顶栏「工具」下拉与
   * macOS 原生「工具」菜单（ottr://menu-action 的 tool.<key>）同一分派——
   * 两入口永不分叉（用户口径：同类功能在两处必须同步）。 */
  // 检查更新统一入口：打开设置「关于」分区 + 触发一次就地检查（复用
  // UpdateCheck 全 UX：进度/安装/重启提示——不另造反馈面）。四端入口
  // （palette/汉堡/mac 菜单/托盘）与设置关于分区共用。
  const openAboutUpdate = useCallback(() => {
    setSettingsPane("about");
    setSettingsOpen(true);
    window.dispatchEvent(new CustomEvent("ottr:update-check"));
  }, []);

  const runToolAction = useCallback(
    (key: string) => {
      switch (key) {
        case "update.check": openAboutUpdate(); break;
        case "notify-center": openDock("notifications"); break;
        case "credentials": setCredentialsOpen(true); break;
        case "alerts": openDock("alerts"); break;
        case "mcp": openDock("mcp"); break;
        case "forwards": openDock("forwards"); break;
        case "jump-chains": openDock("jumpchains"); break;
        case "overview": openMainView("overview"); break;
        case "batch": openMainView("batch"); break;
        case "cron": openDock("cron"); break;
        case "sync": setSyncOpen(true); break;
        case "export-hosts-csv": void exportHostsCsvFromMenu(); break;
      }
    },
    // 依赖面 = useState setter（恒稳定）+ zustand store 动作（恒稳定）+
    // exportHostsCsvFromMenu（仅捕获稳定 setter），空数组无 staleness。
    [],
  );

  async function exportHostsCsvFromMenu() {
    // 原生保存对话框选落盘路径（同 ImportDialog 的 plugin-dialog 动态引入
    // 口径）；用户取消 = 静默返回；成功/失败经行内反馈条（6s）告知结果。
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        defaultPath: "ottr-hosts.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!target) return;
      const path = await vaultApi.exportHostsCsv(target);
      showToast(path);
    } catch (e) {
      showToast(String(e), "error");
    }
  }

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
    // AI 设置入口（诊断面板「去设置」）：设置对话框落「AI」分区（2026-10-10
    // AI 设置并入设置页，独立对话框退役）。
    setAiSettingsOpener(() => setSettingsPane("ai"));
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
    (action: string) => {
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
        case "hosts.new_group":
          // 信号计数：HostTree useEffect 监听展开分组输入（连续触发也生效）。
          setNewGroupSignal((n) => n + 1);
          break;
        case "notify.center":
          openDock("notifications");
          break;
        case "hosts.import":
          setImportOpen(true);
          break;
        case "settings.open":
          setSettingsPane(null);
          setSettingsOpen(true);
          break;
        case "update.check": {
          if (updatePhase.kind === "checking" || updatePhase.kind === "downloading") break;
          void updateCheckFn();
          showToast(tUpdate("update.checking"), "info");
          const unsubPhase = useUpdateStore.subscribe((st) => {
            const k = st.phase.kind;
            if (k === "uptodate") {
              showToast(tUpdate("update.upToDate"), "info");
              unsubPhase();
            } else if (k === "available") {
              showToast(
                tUpdate("update.available", { version: st.phase.version }),
                "info",
              );
              showToast(tUpdate("update.downloading"), "info");
              void updateInstallFn();
            } else if (k === "downloading") {
              unsubPhase(); // 下载中的进度不再逐条 toast（安静下载）
            } else if (k === "installed") {
              showToast(tUpdate("update.installed"), "info");
              unsubPhase();
            } else if (k === "error") {
              showToast(st.phase.message, "error");
              unsubPhase();
            }
          });
          break;
        }
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

  // 原生菜单主题勾选跟随（2026-10-08 菜单栏启用批次）：mode 单一来源在此，
  // 菜单 checkmark 是纯显示面——变化即同步（幂等；非 Tauri 环境跳过）。
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    invoke("menu_set_theme", { themeId: themeMode }).catch(() => {});
  }, [themeMode, setMode]);

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
          const action = e.payload;
          // 原生菜单扩展面（2026-10-08）：主题七选（theme.set.<id>）与工具
          // 菜单（tool.<key>）不在 registry ActionId 内，按前缀直派单一来源。
          if (action.startsWith("theme.set.")) {
            setMode(action.slice("theme.set.".length) as Parameters<typeof setMode>[0]);
            return;
          }
          if (action.startsWith("tool.")) {
            runToolAction(action.slice("tool.".length));
            return;
          }
          handleAction(action as ActionId);
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
      <div className="app-body">
        {/* 应用级侧栏（2026-10-10 壳层重构）：快捷连接 + 主机区（树） +
            功能导航 + 设置，单列三段式；宽度仍由 resizer 持有。 */}
        <Sidebar
          style={{ width: sidebarWidth }}
          newGroupSignal={newGroupSignal}
          selectedId={selectedId}
          onSelect={(host) => setSelectedId(host.id)}
          onOpen={(host) => openTab(host)}
          onEdit={(host) => setForm({ mode: "edit", host })}
          onAdd={(groupId) => setForm({ mode: "new", groupId })}
          onQuickConnect={() => setPaletteOpen(true)}
          onOpenCredentials={() => setCredentialsOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
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
        {/* 空态快捷卡（ui-batch2 T3，审计 A4）：三入口动作全为既有语义——
            新建主机 = HostTree onAdd 同款 setForm({mode:"new"})；⌘K =
            顶栏 palette 按钮同款 setPaletteOpen(true)。 */}
        <MainArea
          storeError={storeError}
          selected={selected}
          onOpenAiSettings={() => openSettingsToPane("ai")}
          onAddHost={() => setForm({ mode: "new", groupId: null })}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        {/* 右侧 dock 槽位（UI 批次一 Task 2 骨架 / Task 4 实体）：工具面板统一
            停靠壳（单槽互斥，openDock 换值即替换）；五工具面板实体渲染其中。 */}
        <DockPanel />
      </div>
      {/* 应用内 Toast（2026-10-10 交互统一）：右下角堆叠，CSV 导出等结果反馈。 */}
      <Toaster />

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
        initialPane={settingsPane}
        onClose={() => setSettingsOpen(false)}
        onOpenSyncDialog={() => setSyncOpen(true)}
      />
      {/* Phase 5 Task 4：同步流程对话框（在设置对话框之后渲染 = 叠于其上）。 */}
      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
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
      {/* Task 16.5 vault 初始化门遮罩（BL-208 F3 迁入 security/VaultInitGateOverlay：
          loading/failed 两态；failed = alertdialog 语义 + 退出按钮即聚焦（键盘可达），
          z 序在锁屏之上——初始化未完成时锁屏状态机尚未启动，两者互斥）。 */}
      <VaultInitGateOverlay phase={initPhase} error={initError} />
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
        onOpenSettings={() => openSettingsToPane("ai")}
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
