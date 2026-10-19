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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./app/Sidebar";
import { IconRail } from "./app/IconRail";
import { Toaster } from "./ui/Toaster";
import { initRipple } from "./ui/ripple";
import { useModalStore, type ModalId } from "./ui/modalStore";
import { useDelayedUnmount, useDelayedValue } from "./ui/useDelayedUnmount";
import { runUpdateCheckToasts } from "./update/updateToasts";
import { LockScreen } from "./security/LockScreen";
import { SecuritySettings } from "./security/SecuritySettings";
import { SyncDialog } from "./sync/SyncDialog";
// Phase 4 Task 3（C1）：exec 逐次审批确认框（事件驱动、全局挂载；McpSettings
// 对话框本体 T4 迁入右侧 dock——本任务自 App 停挂）。
import { McpApprovalDialog } from "./security/McpApprovalDialog";
import { useVaultLockStore } from "./security/VaultLockStore";
import { useVaultInitGate } from "./security/VaultInitGate";
import { VaultInitGateOverlay } from "./security/VaultInitGateOverlay";
import { LANGS, syncLangFromVault, setLang, useLanguage, type Lang } from "./i18n";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { ExportHostsDialog } from "./hosts/ExportHostsDialog";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
import { HostKeyDialog } from "./session/HostKeyDialog";
import { NLCommandPanel, nlBegin } from "./ai/NLCommandPanel";
import { setAiSettingsOpener, useAiStore } from "./ai/aiStore";
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
import { OttyMoments } from "./ui/otty/OttyMoments";
import { syncOttyFromVault } from "./ui/otty/ottyStore";
import { useTerminalFocus } from "./terminal/terminalFocus";
// UI 批次一 Task 2/4：主区视图路由 + 右侧 dock 实体壳（workspaceStore 状态机）。
// 面板实体迁移分工：overview/batch 实体 T3 迁入主区槽位；forwards/jumpchains/
// 六工具面板实体渲染在 workspace/ToolDialog（2026-10-12 dock 退役改弹框）。
import { MainArea } from "./workspace/MainArea";
import { useWorkspaceStore } from "./workspace/workspaceStore";
import { workspaceViewOf } from "./workspace/workspaceViews";
import {
  isTerminalTarget,
  matchActionEvent,
  platform,
  warnShortcutConflicts,
  type ActionId,
} from "./shortcuts/registry";
import { ThemeProvider, useTheme, syncThemeFromVault } from "./theme/ThemeContext";
import { useTerminalThemeStore } from "./theme/terminalThemeStore";
import { createSplitDedupe } from "./shortcuts/splitDedupe";
import { initAutoCheck } from "./update/autoCheck";
import { useVaultStore } from "./vault/store";
import { type Host } from "./vault/api";
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
// 分屏动作去重（2026-10-14 用户反馈「视图菜单分屏点一次触发两次」）：macOS
// 菜单事件链路存在偶发双发（muda 加速器/事件桥层），分屏是非幂等动作——
// 同方向 250ms 内的重复事件直接丢弃。其余菜单动作皆幂等，不做去重。
const passSplitAction = createSplitDedupe();

// --- 顶栏下拉菜单（Phase 5 T1 顶栏收纳） --------------------------------------
//
// --- 主页布局 ----------------------------------------------------------------

type FormState = { mode: "new"; groupId: number | null } | { mode: "edit"; host: Host } | null;

/** 左栏宽（裁定 #2：暂记 localStorage，settings 表落地后迁移）。 */
const SIDEBAR_KEY = "ottr.layout.sidebarWidth";
/** 主机面板折叠胶囊（2026-10-16 视觉重设计 M3 ⌘\）：同款 localStorage 口径。 */
const SIDEBAR_COLLAPSED_KEY = "ottr.layout.sidebarCollapsed";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;
/** 折叠胶囊恒定宽（可拖拽域之外；展开恢复记忆宽度）。 */
const SIDEBAR_CAPSULE_WIDTH = 64;

function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
}

function HomeLayout() {
  // T11（A7）：安全底座——锁定遮罩盖全屏（password 模式）；设置入口在应用菜单（⌘,）。
  const hosts = useVaultStore((s) => s.hosts);
  // 会话面（Task 7）：HostTree 双击/面板连接开标签。标签条 + 终端主区的
  // 渲染面已随 UI 批次一 Task 2 迁入 workspace/MainArea（读 session store）。
  const openTab = useSessionStore((s) => s.openTab);
  // UI 批次一 Task 2：工作区视图/dock 动作（主区路由在 workspace/MainArea，
  // 弹框壳在 workspace/ToolDialog；单槽语义见 workspaceStore.ts）。
  // 2026-10-16 总览标签化：总览入口统一走 openOverview（开置顶标签 + 激活）。
  const openOverview = useWorkspaceStore((s) => s.openOverview);
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  // A12：面板动作需要当前主题/语言（toggle 循环用）
  const { mode: themeMode, setMode } = useTheme();
  const { lang } = useLanguage();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const lockPhase = useVaultLockStore((s) => s.phase);
  const lockView = useDelayedUnmount(lockPhase === "locked");
  // 锁定态不是失败（2026-10-18 用户反馈）：锁屏已在说明一切，vault 命令因
  // 锁定报的错不该再以「数据加载失败」红横幅出现。锁定期间一律吞掉 store
  // 错误；解锁后的 refresh 会清 error，无需回放历史错误。
  const storeError = useVaultStore((s) => (lockPhase === "locked" ? null : s.error));
  const [form, setForm] = useState<FormState>(null);
  // 全局弹窗唯一槽位（2026-10-14 用户裁定「同时只能有一个弹框」）：开/关全走
  // modalStore，open(id) 顶掉当前弹窗；form/settingsPane 只是渲染载荷。
  const activeModal = useModalStore((s) => s.active);
  const openModal = useModalStore((s) => s.open);
  const closeModal = useModalStore((s) => s.close);
  /** id 是否持有唯一槽位（渲染门）。 */
  const owned = (id: ModalId) => activeModal === id;
  // 浮层退场动画窗（评审 P1-8）：关闭期保留挂载并下发 closing，CSS 播完镜像
  // 动画再由 hook 真卸载（时长 ≥ --dur-fast 100ms）。渲染门加
  // `activeModal === null`：被新弹窗顶掉时立即销毁（不播退场、不留叠影），
  // 正常关闭（此刻槽位已空）照常播完动画。
  const formView = useDelayedValue(form);
  const importOpen = activeModal === "importHosts";
  const importView = useDelayedUnmount(importOpen);
  const exportOpen = activeModal === "exportHosts";
  const exportView = useDelayedUnmount(exportOpen);
  const credentialsOpen = activeModal === "credentials";
  const credentialsView = useDelayedUnmount(credentialsOpen);
  // 定向打开设置分区（AI 跳转/检查更新入口）；null = 默认通用区。
  const [settingsPane, setSettingsPane] = useState<null | import("./security/SecuritySettings").SettingsPane>(null);
  const openSettingsToPane = useCallback(
    (pane: import("./security/SecuritySettings").SettingsPane | null) => {
      setSettingsPane(pane);
      openModal("settings");
    },
    [openModal],
  );
  // 托盘状态行会话计数同步（menu_set_tray_status；非 Tauri 环境 no-op）。
  const sessionCount = useSessionStore((s) => s.sessions.length);
  useEffect(() => {
    if (!IS_TAURI) return;
    invoke("menu_set_tray_status", { count: sessionCount }).catch(() => {});
  }, [sessionCount]);
  // TEMP-SCREENSHOT（配图重采驱动，采完即删）：?shot=<target> 控制面板；
  // 改代码后 touch main.tsx 强制整页重载。

  // T13：AI 设置对话框（诊断面板 noProvider/noKey 引导、顶栏 AI 按钮两个入口）
  // 【UI 批次一 Task 2】原面板开关 setState（alertSettings/forwards/jumpChains/
  // overview/procs/batch/cron/mcp/filesOpen）已收口进 workspaceStore——主区视图
  // 走 MainArea 路由，工具面板走 workspace/ToolDialog 弹框；T3/T4 迁实体。
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
  // 折叠胶囊（⌘\，2026-10-16 M3）：折叠态恒 64px，resizer 隐藏（可拖拽域外）。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // 持久化失败不阻塞切换
      }
      return next;
    });
  }, []);
  const resizing = useRef(false);

  // 新建分组信号（File 菜单/汉堡 hosts.new_group → HostTree 分组态；计数即触发）
  const [newGroupSignal, setNewGroupSignal] = useState(0);
  // theme-suite T1：工具菜单「导出主机 CSV」反馈（2026-10-10 起）——
  // 顶部行内状态条废弃（用户反馈路径直接糊在页面顶部太丑），改右下角
  // Toast（ui/toastStore，6 秒自动消失，成功 info / 失败 error）。

  /** 工具动作单一来源（2026-10-08 菜单栏启用批次）：各工具菜单入口与
   * macOS 原生「工具」菜单（ottr://menu-action 的 tool.<key>）同一分派——
   * 多入口永不分叉（用户口径：同类功能在多处必须同步）。
   * 2026-10-14 设置类收敛：mcp（单一家 = 设置页 MCP 分区）与 sync（单一家 =
   * 设置页同步分区）自工具清单退役——工具菜单不再有设置概念项，本表同步
   * 删除对应 case（清单见 shortcuts/toolsRegistry.ts）。
   * 2026-10-16 用户需求：导入/导出主机进工具面（原 import 只在文件菜单、
   * export 只出 CSV）；导出升级为四格式对话框。 */
  const runToolAction = useCallback(
    (key: string) => {
      switch (key) {
        case "notify-center": openMainView("notifications"); break;
        case "credentials": openModal("credentials"); break;
        case "alerts":
          // 2026-10-16 IA 重构：告警已在设置「告警」分区（AlertSettings 双入口
          // 归位设置）——图标轨/工具菜单改跳转，弹框副本退役。
          openSettingsToPane("alerts");
          break;
        // monitor/plugins 退役（2026-10-18 用户裁定）：会话子页签不进全局面
        // 工具清单——入口 = 会话语境的视图切换器（MainArea）。
        case "forwards": openMainView("forwards"); break;
        case "jump-chains": openMainView("jumpchains"); break;
        case "overview": openOverview(); break;
        case "batch": openMainView("batch"); break;
        case "cron": openMainView("cron"); break;
        case "export-hosts":
        case "hosts.export":
          // hosts.export = 文件菜单/⌘K 正名（2026-10-19 归位文件菜单）；
          // export-hosts 旧工具键保留兼容（Rust 侧历史事件）。
          openModal("exportHosts");
          break;
        case "import-hosts": openModal("importHosts"); break;
      }
    },
    // 依赖面 = useState setter（恒稳定）+ zustand store 动作（恒稳定），无 staleness。
    [],
  );

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
      // 自动检查更新（2026-10-13 用户需求）：vault 就绪后读 update.check_mode
      // （off 默认 / startup / interval 24h）；便携版在模块内整体禁用。
      void initAutoCheck();
      // Otty 情感时刻开关（2026-10-16 M3）：vault 真源 ui.ottyMoments 对齐
      // （默认开；设置页外观分区可一键关——报告红线②）。
      void syncOttyFromVault();
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
      // 默认落地总览（2026-10-14 用户裁定「打开 app 默认进总览」）：库内有主机
      // 且启动后无会话标签 → 打开即落总览页（2026-10-16 总览标签化：走
      // openOverview，置顶标签同步在场）。空库保留欢迎页（首启引导更完整）；
      // restoreTabs 恢复了会话则留在终端面（用户要的是恢复的会话，不是总览）。
      const ws = useWorkspaceStore.getState();
      if (
        useVaultStore.getState().hosts.length > 0 &&
        useSessionStore.getState().sessions.length === 0 &&
        ws.mainView === "terminal"
      ) {
        ws.openOverview();
      }
    })();
  }, [initPhase]);

  // 首会话落地终端（默认总览的配套不变量）：默认视图改总览后，从主机树/
  // 面板/⌘K 发起的连接要把用户带回终端面（总览卡片与实体导航本就显式
  // openMainView("terminal")，此处兜住其余连接入口）。只在 0 → >0 的首会话
  // 切——用户在文件/进程视图再开一条连接不被拽走（旧行为保留）。
  const prevSessionCount = useRef(sessionCount);
  useEffect(() => {
    const prev = prevSessionCount.current;
    prevSessionCount.current = sessionCount;
    if (prev === 0 && sessionCount > 0) openMainView("terminal");
    // 对位不变量（2026-10-16 用户需求④「关闭所有标签页后回到首屏」）：会话
    // 清零时复位两个会截胡欢迎页的残留——①mainView 停在总览等非终端视图
    // （总览标签还开着则激活它：剩余标签的自然顺位；批量页不拽走，进行中的
    // 批量执行不打断，关掉自然回欢迎页）；②左树选中态顶着「已选中占位」面
    // （双击开标签前的单击选中残留）。
    if (prev > 0 && sessionCount === 0) {
      const ws = useWorkspaceStore.getState();
      if (ws.overviewOpen) ws.openOverview();
      else if (ws.mainView !== "batch") ws.openMainView("terminal");
      setSelectedId(null);
    }
  }, [sessionCount, openMainView]);

  // 融合式标题栏双击缩放（2026-10-16 用户反馈：拖拽面双击不放大/缩小）：
  // data-tauri-drag-region 走手动拖拽（performWindowDrag），系统「双击标题栏
  // 缩放」只在真标题栏生效——Overlay 形态下真标题栏被 webview 内容盖住。
  // 补全局 dblclick：命中拖拽面元素本身（与起拖同判定，子元素交互不受扰）
  // 即 toggleMaximize。仅 mac + Tauri——Win/Linux 自绘标题栏的拖拽区经
  // HTCAPTION 仿真，系统原生双击缩放已生效，再叠 JS 会双次翻转。
  useEffect(() => {
    if (PLATFORM !== "mac" || !IS_TAURI) return;
    const onDblClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.hasAttribute("data-tauri-drag-region")) {
        getCurrentWindow().toggleMaximize().catch(() => {});
      }
    };
    window.addEventListener("dblclick", onDblClick);
    return () => window.removeEventListener("dblclick", onDblClick);
  }, []);

  // T13：设置页路由钩子注入（aiStore 错误面「去设置」按钮 → 打开 AI 设置）
  useEffect(() => {
    // AI 设置入口（诊断面板「去设置」）：设置对话框落「AI」分区（2026-10-10
    // AI 设置并入设置页，独立对话框退役）。
    setAiSettingsOpener(() => openSettingsToPane("ai"));
    return () => setAiSettingsOpener(null);
  }, [openSettingsToPane]);

  // 涟漪反馈（2026-10-16 视觉重设计 M2）：document 级 pointerdown 委托，
  // 目标三类见 ui/ripple.ts；卸载即解绑（App 是单例根，实际不卸）。
  useEffect(() => initRipple(), []);

  // Phase 2 Task 7（B1 会话纪要）：会话收尾钩子注入——closeTab / disconnect /
  // 重连耗尽时异步生成纪要（onSessionEnded fire-and-forget，失败静默不反噬）。
  // 搭车（2026-10-19 方案 A）：AI 面板状态按会话作用域，会话收尾时一并清理
  // （abort 在途流 + 摘切片；store 不反向依赖 session 链路的既有惯例不变）。
  useEffect(() => {
    setSessionEndHook((info) => {
      onSessionEnded(info);
      useAiStore.getState().dropSession(info.id);
    });
    return () => setSessionEndHook(null);
  }, []);

  // A12 动作收口：面板 / 全局快捷键 / （Task 14 后续提交）原生菜单事件、
  // 汉堡菜单——一处 action 多入口，全部汇到 handleAction。
  const handleAction = useCallback(
    (action: string) => {
      // 开关二态动作读现值（getState 避免把 activeModal 拉进依赖面）。
      const modal = useModalStore.getState();
      // ⌘K 外观区（2026-10-18 入口审计）：主题/语言具体项直派——与 mac 视图
      // 菜单（theme.set.*）同一字面量，语言面此前仅设置页可达，此处收口。
      if (action.startsWith("theme.set.")) {
        setMode(action.slice("theme.set.".length) as Parameters<typeof setMode>[0]);
        return;
      }
      if (action.startsWith("lang.set.")) {
        const loc = action.slice("lang.set.".length);
        if ((LANGS as readonly string[]).includes(loc)) setLang(loc as Lang);
        return;
      }
      switch (action) {
        case "palette.toggle":
          modal.active === "palette" ? modal.close("palette") : modal.open("palette");
          break;
        case "history.search":
          modal.active === "history" ? modal.close("history") : modal.open("history");
          break;
        case "ai.nl2cmd":
          // 打开 = 清场 + 聚焦 pane 的 cwd 锚点（OSC7 活值）；关闭 = 顺带清场
          // （在途请求 abort，panel 卸载后 store 不留尾巴）。副作用在 updater
          // 外（StrictMode 下 updater 可能双调）。
          nlBegin();
          modal.active === "nl2cmd" ? modal.close("nl2cmd") : modal.open("nl2cmd");
          break;
        case "hosts.new":
          setForm({ mode: "new", groupId: null });
          modal.open("hostForm");
          break;
        case "hosts.new_group":
          // 信号计数：HostTree useEffect 监听展开分组输入（连续触发也生效）。
          setNewGroupSignal((n) => n + 1);
          break;
        case "notify.center":
          openMainView("notifications");
          break;
        case "hosts.panelToggle":
          toggleSidebarCollapsed();
          break;
        case "hosts.import":
          modal.open("importHosts");
          break;
        case "settings.open":
          openSettingsToPane(null);
          break;
        case "update.check":
          // 四端入口统一走 toast 编排（update/updateToasts.ts）：单飞防重 +
          // 发现新版 toast 内直接「下载安装」（2026-10-13 用户裁定：跳设置页
          // 太扯）；「不自动一条龙」裁定保持——下载仍须显式点击。
          runUpdateCheckToasts();
          break;
        case "theme.toggle":
          setMode(themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light");
          break;
        case "lang.toggle":
          // 三语循环（2026-10-18 +繁体）：简 → 繁 → EN → 简
          setLang(lang === "zh-CN" ? "zh-Hant" : lang === "zh-Hant" ? "en-US" : "zh-CN");
          break;
        case "session.splitRight":
        case "session.splitDown": {
          const s = useSessionStore.getState();
          if (s.activeId) s.splitPane(s.activeId, action === "session.splitRight" ? "row" : "column");
          break;
        }
        case "session.tabNext":
        case "session.tabPrev": {
          // Ctrl+Tab 切标签（2026-10-18 入口审计缺口补齐）：根会话序（与
          // TabBar 展示同口径 paneOf=null）循环轮转；库级视图下切会话 = 离开
          // 库级视图回终端（与会话页签点击同一语义，workspaceStore 判定）。
          const st = useSessionStore.getState();
          const tabs = st.sessions.filter((s) => s.paneOf === null);
          if (tabs.length < 2) break;
          const idx = tabs.findIndex((s) => s.id === st.activeId);
          const next = tabs[(idx + (action === "session.tabNext" ? 1 : tabs.length - 1)) % tabs.length];
          if (next && next.id !== st.activeId) {
            st.setActive(next.id);
            if (workspaceViewOf(useWorkspaceStore.getState().mainView) !== null) {
              useWorkspaceStore.getState().openMainView("terminal");
            }
          }
          break;
        }
        case "vault.lock":
          void useVaultLockStore.getState().lock();
          break;
        case "app.quit":
          // 真退出（不走 close-to-tray 拦截路径）；非 Tauri 环境静默。
          invoke("quit_app").catch(() => {});
          break;
        // --- 2026-10-12 跨平台审计补齐（此前 Win/Linux 不可达的面）---
        case "app.closeWindow":
          // 与标题栏 X 同路：CloseRequested → close-to-tray 拦截转隐藏
          // （mac ⌘W 原生菜单同语义）；纯浏览器 dev 静默。
          getCurrentWindow().close().catch(() => {});
          break;
        case "app.toggleFullscreen": {
          const w = getCurrentWindow();
          void w.isFullscreen().then((fs) => w.setFullscreen(!fs)).catch(() => {});
          break;
        }
        case "view.zoomIn":
        case "view.zoomOut":
        case "view.zoomReset":
          // 进 menu.rs apply_zoom（ZoomState 单一状态源，mac 菜单同源）。
          invoke("view_zoom", {
            op: action === "view.zoomIn" ? "in" : action === "view.zoomOut" ? "out" : "reset",
          }).catch(() => {});
          break;
        default:
          // tool.* 工具命令（⌘K 工具组 / Win/Linux 汉堡 / 托盘同源清单）：
          // 统一收口 runToolAction——此前未路由，两端入口是死点击（2026-10-16
          // 用户反馈「⌘K 列表与全项目脱钩」的根因之一）。
          if (action.startsWith("tool.")) runToolAction(action.slice("tool.".length));
          break;
      }
    },
    [themeMode, setMode, lang, toggleSidebarCollapsed, runToolAction],
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
          if (!passSplitAction(action, Date.now())) return;
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
    document.body.dataset.resizing = "true";
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      if (resizing.current) setSidebarWidth(clampSidebarWidth(startWidth + ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      resizing.current = false;
      delete document.body.dataset.resizing;
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
    <div
      className="app-shell"
      // macOS 融合式标题栏（2026-10-14 用户裁定「标题栏与系统融合」）：
      // 原生标题栏退役（tauri.conf.json titleBarStyle=Overlay + hiddenTitle），
      // 内容顶到窗口顶缘、红绿灯悬浮于侧栏左上；侧栏顶部让位 + 拖拽面见
      // Sidebar titlebarInset / MainArea 拖拽区 / 12-titlebar-theme.css。
      data-titlebar={PLATFORM === "mac" && IS_TAURI ? "overlay" : undefined}
    >
      {/* A12：Win/Linux 自绘标题栏（decorations:false 的窗口壳；mac 不渲染走
          原生红绿灯 + 系统菜单栏）。动作收口同一 handleAction。 */}
      {PLATFORM !== "mac" && IS_TAURI && (
        <TitleBar
          plat={PLATFORM}
          onAction={handleAction}
          onSnap={(layout) => invoke("window_snap", { layout }).catch(() => {})}
        />
      )}
      <div className="app-body">
        {/* 48px 图标轨（2026-10-16 视觉重设计 M3「獭居·浮岛」）：高频入口恒驻
            + Otty 球设置入口；mac 红绿灯随轨道移到窗口最左。 */}
        <IconRail
          titlebarInset={PLATFORM === "mac" && IS_TAURI}
          onOpenCredentials={() => openModal("credentials")}
          onOpenSettings={() => openSettingsToPane(null)}
          onOpenMcpSettings={() => openSettingsToPane("mcp")}
          onOpenHistory={() => openModal("history")}
          onOpenUpdate={() => openSettingsToPane("about")}
        />
        {/* 应用级侧栏（2026-10-10 壳层重构）：快捷连接 + 主机区（树）；
            功能导航与设置已迁图标轨（M3）。⌓\ 折叠胶囊 = 64px 恒宽。 */}
        <Sidebar
          style={{ width: sidebarCollapsed ? SIDEBAR_CAPSULE_WIDTH : sidebarWidth }}
          collapsed={sidebarCollapsed}
          titlebarInset={PLATFORM === "mac" && IS_TAURI}
          newGroupSignal={newGroupSignal}
          selectedId={selectedId}
          onSelect={(host) => setSelectedId(host.id)}
          onOpen={(host) => openTab(host)}
          onEdit={(host) => {
            setForm({ mode: "edit", host });
            openModal("hostForm");
          }}
          onAdd={(groupId) => {
            setForm({ mode: "new", groupId });
            openModal("hostForm");
          }}
          onQuickConnect={() => openModal("palette")}
          onNewGroup={() => setNewGroupSignal((n) => n + 1)}
        />
        {!sidebarCollapsed && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startResize}
            data-testid="sidebar-resizer"
          />
        )}
        {/* 主区视图路由（UI 批次一 Task 2）：mainView 状态机五视图切换；终端
            隐藏常驻不变量在 MainArea 内执行（非 terminal 视图 visibility 隐藏，
            运行中会话不卸载）。 */}
        {/* 空态快捷卡（ui-batch2 T3，审计 A4）：三入口动作全为既有语义——
            新建主机 = HostTree onAdd 同款 setForm({mode:"new"})；⌘K =
            侧栏搜索行同款 openModal("palette")（modalStore 唯一槽）。 */}
        <MainArea
          storeError={storeError}
          selected={selected}
          onOpenAlerts={() => openSettingsToPane("alerts")}
          onOpenAiSettings={() => openSettingsToPane("ai")}
          onAddHost={() => {
            setForm({ mode: "new", groupId: null });
            openModal("hostForm");
          }}
          onOpenPalette={() => openModal("palette")}
        />
      </div>
      {/* 应用内 Toast（2026-10-10 交互统一）：右下角堆叠，CSV 导出等结果反馈。 */}
      <Toaster />
      {/* Otty 情感时刻覆盖层（2026-10-16 M3）：连接/传输/解锁/更新四瞬间，
          单槽队列 + 开关可关（ui/otty）；pointer-events:none 不挡交互。 */}
      <OttyMoments />

      {/* 弹窗渲染门（modalStore 单实例，2026-10-14 用户裁定）：open 态 =
          owned(id)；`|| (closing && activeModal === null)` = 正常关闭播完
          退场动画、被新弹窗顶掉时立即销毁不播退场。 */}
      {formView.value && (owned("hostForm") || (formView.closing && activeModal === null)) && (
        <HostForm
          closing={formView.closing}
          host={formView.value.mode === "edit" ? formView.value.host : null}
          defaultGroupId={formView.value.mode === "new" ? formView.value.groupId : null}
          onClose={() => {
            setForm(null);
            closeModal("hostForm");
          }}
        />
      )}
      {importView.shouldRender && (importOpen || (importView.closing && activeModal === null)) && (
        <ImportDialog closing={importView.closing} onClose={() => closeModal("importHosts")} />
      )}
      {/* 导出主机对话框（2026-10-16 四格式：CSV/Tabby JSON/Xshell 目录/OpenSSH
          config）；结果经 toast（成功落盘路径 / 个数），失败就地重试。 */}
      {exportView.shouldRender && (exportOpen || (exportView.closing && activeModal === null)) && (
        <ExportHostsDialog closing={exportView.closing} onClose={() => closeModal("exportHosts")} />
      )}
      {credentialsView.shouldRender &&
        (credentialsOpen || (credentialsView.closing && activeModal === null)) && (
          <CredentialsDialog
            closing={credentialsView.closing}
            onClose={() => closeModal("credentials")}
          />
        )}
      {(owned("settings") || activeModal === null) && (
        <SecuritySettings
          open={owned("settings")}
          initialPane={settingsPane}
          onClose={() => closeModal("settings")}
          onOpenSyncDialog={() => openModal("sync")}
        />
      )}
      {/* 同步流程对话框：设置页同步分区「立即同步」的唯一弹窗入口（工具菜单
          同步项已退役，2026-10-14 设置类收敛）；开启即顶掉设置页（单实例槽），
          「去设置」按钮反向顶回。 */}
      {(owned("sync") || activeModal === null) && (
        <SyncDialog
          open={owned("sync")}
          onClose={() => closeModal("sync")}
          onOpenSettings={() => openSettingsToPane("sync")}
        />
      )}
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
      {lockView.shouldRender && <LockScreen closing={lockView.closing} />}
      {/* Task 16.5 vault 初始化门遮罩（BL-208 F3 迁入 security/VaultInitGateOverlay：
          loading/failed 两态；failed = alertdialog 语义 + 退出按钮即聚焦（键盘可达），
          z 序在锁屏之上——初始化未完成时锁屏状态机尚未启动，两者互斥）。 */}
      <VaultInitGateOverlay phase={initPhase} error={initError} />
      {/* A12 命令面板（T5 QuickConnect 并入收口）：主机 + 命令统一搜索。
          动作经 handleAction 分派；连主机即开标签。外门口径同上：被新弹窗
          顶掉立即销毁，正常关闭（槽位已空）播完退场。 */}
      {(owned("palette") || activeModal === null) && (
        <CommandPalette
          open={owned("palette")}
          onClose={() => closeModal("palette")}
          hosts={hosts}
          onConnect={(host) => {
            openTab(host);
            closeModal("palette");
          }}
          onAction={(action) => {
            closeModal("palette");
            handleAction(action);
          }}
          plat={PLATFORM}
        />
      )}
      {/* T15 历史搜索面板（⌘R）：跨主机命令历史 FTS 检索；回车把命令写进当前
          聚焦 pane（剥提示符前缀——CommandWatch 提取含提示符原文；不带换行，
          落在输入行由用户确认执行）。 */}
      {(owned("history") || activeModal === null) && (
        <HistorySearch
          open={owned("history")}
          onClose={() => closeModal("history")}
          hosts={hosts}
          onInsert={(command) => {
            useSessionStore.getState().insertToFocusedPane(stripPromptPrefix(command));
            // 与 AI 生成命令同一姿态：插入即切回终端 + 焦点交还 xterm，
            // 回车直接执行（2026-10-16 用户反馈）。
            useWorkspaceStore.getState().openMainView("terminal");
            useTerminalFocus.getState().request();
            closeModal("history");
          }}
          plat={PLATFORM}
        />
      )}
      {/* Phase 2 B1（Task 6）⌘J NL→命令输入条：底部锚定；生成结果走公共
          InsertRow 的 danger 三档确认插终端（聚焦 pane 的 rustId 面板内解析）。 */}
      {(owned("nl2cmd") || activeModal === null) && (
        <NLCommandPanel
          open={owned("nl2cmd")}
          onClose={() => closeModal("nl2cmd")}
          onOpenSettings={() => openSettingsToPane("ai")}
        />
      )}
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
