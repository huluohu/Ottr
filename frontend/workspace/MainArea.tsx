// MainArea（UI 批次一 Task 2；Task 3 实体迁入）：主区视图路由——
// workspaceStore.mainView 状态机驱动的主区视图切换（terminal/files/processes/
// overview/batch）。
//
// 【终端常驻不变量】非 terminal 视图时终端 DOM **保留但隐藏**（visibility 制式，
// 沿 Task 10 文件视图先例：absolute+inset 保持原尺寸，回视图无需 refit）——
// xterm 缓冲/滚动回看不丢，运行中会话不卸载。overview/batch 视图同制式
// （Task 3 起 OverviewPage/BatchPanel 实体挂在这里，占位壳 MainViewSlot 消亡）。
//
// 【实体导航接线（Task 3；2026-10-16 总览标签化）】总览卡片点击 = openTab +
// openMainView("terminal")（原对话框 onClose 语义等价迁移）；「进程」= openTab +
// openMainView("processes")；总览头部「← 终端」返回按钮退役——导航统一走
// 标签条（点会话标签回终端、总览标签 ✕ 收场），BatchPanel 非标签制保留返回。
//
// 【filesOnly 覆盖】FTP/FTPS 会话无 PTY 终端：mainView 无论何值（视图族内）恒
// 文件视图、终端/进程按钮隐藏——原 HomeLayout 行为等价迁移（原 filesOpen 布尔
// 换成 mainView==='files'）。
//
// 【视觉不变】term-main-row 的 AI 诊断侧栏仍只在终端视图挂载；监控/插件自
// 2026-10-17 批次三起为满幅主区视图（WorkspaceViewShell 外壳，与文件/进程
// 平级渲染），侧栏形态退役。
//
// 【行让位（ui-batch2 T1，审计 48/49）】files/procs 两视图的面板与
// term-main-row 平级渲染，行内内容已全部 out-of-flow（holder absolute 让位、
// 侧栏卸载）——行置 data-yield 折叠自身 flex，面板满幅；否则行仍 flex:1 与
// 面板 50/50 均分主区（面板压半高）。隐藏 holder 内 pane 由 App.css 压回
// visibility:hidden（防 `.term-pane[data-active]` 翻回戳穿——终端缓冲曾透过
// 面板显形、盖住面板绘制），CSS 契约由 term-veil-css.test.ts 守卫。
//
// 【空态快捷操作卡（ui-batch2 T3，审计 A4）】零会话且未选中主机的占位面从
// 纯文字升级为三入口卡：连接夹具（库内有走查夹具端点主机的条件入口，动作 =
// 既有 openTab）/ 新建主机（onAddHost → App 的 setForm({mode:"new"}) 既有
// 语义）/ ⌘K 命令面板卡（onOpenPalette → openModal("palette")，modalStore 唯一槽）。
// 空态判定不变（terminalMode=false + selected=null 分支），占位文案保留为
// 卡片引导语；两 prop 缺省时对应入口不渲染（组件可独立挂载，行为可裁剪）。
import { useTranslation } from "react-i18next";
import { TabBar } from "../session/TabBar";
import { TerminalArea, TerminalToolbar } from "../terminal/Terminal";
import { FilePanel } from "../files/FilePanel";
import { ProcessBrowser } from "../monitor/ProcessBrowser";
import { DiagnosePanel } from "../ai/DiagnosePanel";
import { RecordToggle, useAnyRecording } from "../history/RecordToggle";
import { OverviewPage } from "../monitor/OverviewPage";
import { BatchPanel } from "../batch/BatchPanel";
import { CronPanel } from "../cron/CronPanel";
import { NotificationCenter } from "../notify/NotificationCenter";
import { ForwardPanel } from "../forward/ForwardPanel";
import { JumpChainEditor } from "../hosts/JumpChainEditor";
import { WorkspaceViewShell } from "./WorkspaceViewShell";
import { MonitorPanel } from "../monitor/MonitorSidebar";
import { PluginPanel } from "../plugins/PluginSidebar";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";
import { platform, shortcutLabel } from "../shortcuts/registry";
import { useWorkspaceStore } from "./workspaceStore";
import { HomeWelcome } from "../home/HomeWelcome";

interface MainAreaProps {
  /** vault refresh 失败横幅（HomeLayout 启动链持有，透传）。 */
  storeError: string | null;
  /** 左树选中主机（无会话时的占位面）。 */
  selected: Host | null;
  /** AI 诊断面板「去设置」→ AI 设置对话框（对话框入口仍在 HomeLayout）。 */
  onOpenAiSettings: () => void;
  /** 空态快捷卡「新建主机」入口（App 注入 = setForm({ mode: "new", groupId: null })；
   * 缺省 = 入口不渲染）。 */
  onAddHost?: () => void;
  /** 空态快捷卡「⌘K 命令面板」入口（App 注入 = openModal("palette")；缺省 =
   * 入口不渲染）。 */
  onOpenPalette?: () => void;
  /** 空态快捷卡「导入配置」入口（App 注入 = openModal("importHosts")；缺省 =
   * 入口不渲染）。 */
  onOpenImport?: () => void;
  /** 通知中心空态「查看告警规则」→ 设置告警分区（App 注入）。 */
  onOpenAlerts?: () => void;
}

/** 走查夹具端点（seed_vault 播种的 spike 主机；spike-sshd.sh 127.0.0.1:2222）。
 * 键式与 Rust host_endpoint_key 同口径（"address:port"，仅 IPv6 加括号——
 * 夹具为 IPv4 字面量）。 */
export const FIXTURE_ENDPOINT = "127.0.0.1:2222";

/** 空态快捷卡「连接夹具」的夹具识别口径（纯函数）：库内 ssh 主机端点命中
 * FIXTURE_ENDPOINT 即认定。无数据面夹具标记可依，按端点识别 = 零新数据依赖
 * （主机列表本就在 vault store）；命中即说明该端点可直连（走查环境已就绪）。 */
export function findFixtureHost(hosts: Host[]): Host | null {
  return (
    hosts.find((h) => h.protocol === "ssh" && `${h.address}:${h.port}` === FIXTURE_ENDPOINT) ??
    null
  );
}

export function MainArea({
  storeError,
  selected,
  onOpenAiSettings,
  onAddHost,
  onOpenPalette,
  onOpenImport,
  onOpenAlerts,
}: MainAreaProps) {
  const { t } = useTranslation();
  const mainView = useWorkspaceStore((s) => s.mainView);
  const overviewOpen = useWorkspaceStore((s) => s.overviewOpen);
  // macOS 融合式标题栏：主区顶部行（标签条/空态主区）兼作窗口拖拽面
  // （2026-10-14；Win/Linux 有自绘标题栏，不注入）。data-tauri-drag-region
  // 仅命中元素本身才起拖——标签/按钮等子元素交互不受影响。
  const isMac = platform() === "mac";
  const dragRegion = isMac ? { "data-tauri-drag-region": true } : {};
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  const openTab = useSessionStore((s) => s.openTab);
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const hosts = useVaultStore((s) => s.hosts);
  // 空态快捷卡（ui-batch2 T3）：夹具端点命中才出的条件入口 + 平台键位提示
  const fixtureHost = findFixtureHost(hosts);
  const paletteLabel = shortcutLabel("palette.toggle", platform()) ?? "⌘K";

  // 会话面派生（原 HomeLayout 逻辑原样迁入）：活动标签根会话 + filesOnly 覆盖
  const terminalMode = sessions.length > 0;
  const activeSession =
    sessions.find((s) => s.id === activeId) ??
    sessions.find((s) => s.paneOf === activeId) ??
    null;
  const rootSession = activeSession
    ? (sessions.find((s) => s.id === (activeSession.paneOf ?? activeSession.id)) ?? null)
    : null;
  const filesOnly = rootSession?.protocol === "ftp" || rootSession?.protocol === "ftps";
  // 监控面板采样开关（主机关闭监控时面板呈未采样态；ToolDialog 同口径）
  const monitorEnabled =
    rootSession != null
      ? (hosts.find((h) => h.id === rootSession.hostId)?.monitor_enabled ?? false)
      : false;
  // 视图可见性（mainView 单值互斥 + filesOnly 覆盖，语义与原实现等价）
  const filesVisible = mainView === "files" || (terminalMode && filesOnly);
  const procsVisible = mainView === "processes" && !filesVisible;
  const termViewActive = mainView === "terminal" && !filesOnly;
  // 监控/插件（2026-10-16 IA 重构批次 B）：会话级子页签——与文件/进程同域
  // （依赖已连接会话的 rustId；FTP/FTPS 无 PTY 不提供监控/插件）。
  // 2026-10-17 批次三：满幅主区视图（WorkspaceViewShell 外壳，平级渲染同
  // 文件/进程），侧栏同屏形态退役（224px 窄条 + 分屏钮遮挡）。
  const monitorVisible = mainView === "monitor" && rootSession != null && !filesOnly;
  const pluginsVisible = mainView === "plugins" && rootSession != null && !filesOnly;
  // 视图切换器跟随会话页签显示（2026-10-18 用户反馈）：终端/文件/进程/监控/
  // 插件是会话级子视图，只在会话语境（有活动会话且停在会话级视图）渲染——
  // 库级页签（总览/定时任务/通知中心/端口转发/跳板链/批量）激活时整组隐藏，
  // 点会话页签即回终端语境。零会话时同样不渲染（此前挂着也无意义）。
  const sessionViewActive =
    rootSession !== null &&
    (mainView === "terminal" ||
      mainView === "files" ||
      mainView === "processes" ||
      mainView === "monitor" ||
      mainView === "plugins");
  // 任一会话在录 → 库级页签保留录制指示/停止入口（见渲染处注释）。
  const anyRecording = useAnyRecording();
  // overview/batch 实体视图（UI 批次一 Task 3 迁入；占位壳 MainViewSlot 消亡）。
  // 2026-10-16 总览标签化：OverviewPage 的「← 终端」返回按钮退役（导航走
  // 标签条：点会话标签回终端、关总览标签 ✕ 收场）；onOpen/onOpenProcesses
  // 语义不变（跳标签 + 切视图）。BatchPanel 非标签制，返回按钮保留。
  // 库级宽幅视图槽位（2026-10-16 IA 重构：定时任务/通知中心/端口转发/跳板链
  // 自弹框迁入主区——弹框退役第一步）。监控/插件为会话级子页签，不走此槽。
  const slotView =
    mainView === "overview" ||
    mainView === "batch" ||
    mainView === "cron" ||
    mainView === "notifications" ||
    mainView === "forwards" ||
    mainView === "jumpchains"
      ? mainView
      : null;
  const slotPane =
    slotView === null ? null : slotView === "overview" ? (
      <OverviewPage
        onOpen={(host) => {
          openTab(host);
          openMainView("terminal");
        }}
        onOpenProcesses={(host) => {
          openTab(host);
          openMainView("processes");
        }}
      />
    ) : slotView === "batch" ? (
      <BatchPanel onClose={() => openMainView("terminal")} />
    ) : slotView === "cron" ? (
      <WorkspaceViewShell labelKey="nav.cron" description={t("workspace.cron.desc")} testid="workspace-view-cron">
        <CronPanel open />
      </WorkspaceViewShell>
    ) : slotView === "notifications" ? (
      <WorkspaceViewShell labelKey="nav.notifications" description={t("workspace.notifications.desc")} testid="workspace-view-notifications">
        <NotificationCenter onOpenAlerts={onOpenAlerts} />
      </WorkspaceViewShell>
    ) : slotView === "forwards" ? (
      <WorkspaceViewShell labelKey="forward.title" description={t("workspace.forwards.desc")} testid="workspace-view-forwards">
        <ForwardPanel open />
      </WorkspaceViewShell>
    ) : (
      <WorkspaceViewShell labelKey="jump.title" description={t("workspace.jumpchains.desc")} testid="workspace-view-jumpchains">
        <JumpChainEditor open />
      </WorkspaceViewShell>
    );

  // 零会话空态内容（错误横幅 / 已选中占位 / 欢迎页）——总览标签在场时挂在
  // 标签条下方（mainView 被切回 terminal 的零会话形态，如启动落地后用户
  // 显式回终端视图），无标签时独占主区（原分支原样）。
  const emptyBody = (
    <>
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
        <section className="main-placeholder" data-testid="main-empty">
          <HomeWelcome
            hosts={hosts}
            fixtureHost={fixtureHost}
            paletteLabel={paletteLabel}
            onAddHost={onAddHost}
            onOpenPalette={onOpenPalette}
            onOpenImport={onOpenImport}
            onConnect={openTab}
          />
        </section>
      )}
    </>
  );

  // 零会话：库级宽幅视图（总览/定时任务/通知中心/端口转发/跳板链，2026-10-16
  // IA 重构）任一在场 → 标签条常驻；主区内容跟随 mainView。批量独开（总览
  // 标签未开）时无标签可渲染，实体独占主区（原对话框语义）。
  if (!terminalMode) {
    if (!overviewOpen && slotView === null) {
      return (
        <main className="main-area" data-testid="main-area" {...dragRegion}>
          {slotView !== null ? slotPane : emptyBody}
        </main>
      );
    }
    return (
      <main className="main-area terminal-mode" data-testid="main-area">
        <div className="tabbar-row" {...dragRegion}>
          {/* dragRegion 透传：标签容器 flex:1 占满行内空档，属性必须落在实际
              命中元素上（空档双击缩放/起拖才生效，2026-10-16 用户反馈）。 */}
          <TabBar dragRegion={dragRegion} />
        </div>
        {slotView !== null ? (
          <div className="term-main-row">{slotPane}</div>
        ) : (
          <div className="main-area-empty-body">{emptyBody}</div>
        )}
      </main>
    );
  }

  // 有会话：标签条（独占一行，2026-10-19 用户裁定方案 B：会话页签多时不再
  // 与右侧常驻组打架）+ 终端常驻区（主区视图路由核心）。
  // 【终端常驻不变量】五视图共用同一 term-main-row：overview/batch 实体视图
  // 渲染在让位的侧栏位置，终端 holder 恒在 DOM（data-hidden 切 visibility）——
  // 任何视图切换都不卸载终端（xterm 缓冲/滚动回看不丢，运行中会话保留）。
  // 视图切换器 + 录制钮移入终端工具行（TerminalArea toolbarExtra），与分屏
  // 按钮同行——页签行只剩会话页签，视觉边界一条线。
  return (
    <main className="main-area terminal-mode" data-testid="main-area">
      <div className="tabbar-row" {...dragRegion}>
        {/* dragRegion 透传：标签容器 flex:1 占满行内空档，属性必须落在实际
            命中元素上（空档双击缩放/起拖才生效，2026-10-16 用户反馈）。 */}
        <TabBar dragRegion={dragRegion} />
      </div>
      {/* 终端工具行（2026-10-19 热修）：分屏钮 + 视图切换器 + 录制 + 编码。
          必须渲染在 data-hidden 的 term-area-holder **之外**——holder 在非
          终端视图时 visibility:hidden，切换器住里面会跟着消失（v1.4.0 发布
          回归：切到文件/监控后找不到「终端」按钮回不去）。本行常驻可见。 */}
      <div className="term-toolbar-row">
        <TerminalToolbar
          terminalControls={!filesOnly}
          toolbarExtra={
            // 录制钮属会话域但「正在录」时在库级页签也保留指示+停止入口
            // （2026-10-18 裁定：悄悄进行比红点消失更糟）；视图切换器只在
            // 会话语境渲染（2026-10-18 划界不变）。
            sessionViewActive || anyRecording ? (
                <>
                  {/* 视图切换器（2026-10-19 方案 B：自页签行迁入终端工具行） */}
                  <div className="view-switch" role="group" aria-label={t("files.viewSwitch")}>
                    {!filesOnly && (
                      <button
                        data-testid="view-terminal"
                        data-active={termViewActive}
                        aria-pressed={termViewActive}
                        onClick={() => openMainView("terminal")}
                      >
                        {t("files.viewTerminal")}
                      </button>
                    )}
                    <button
                      data-testid="view-files"
                      data-active={filesVisible}
                      aria-pressed={filesVisible}
                      onClick={() => openMainView("files")}
                    >
                      {t("files.viewFiles")}
                    </button>
                    {!filesOnly && (
                      <button
                        data-testid="view-processes"
                        data-active={procsVisible}
                        aria-pressed={procsVisible}
                        onClick={() => openMainView("processes")}
                      >
                        {t("process.title")}
                      </button>
                    )}
                    {!filesOnly && (
                      <button
                        data-testid="view-monitor"
                        data-active={monitorVisible}
                        aria-pressed={monitorVisible}
                        onClick={() => openMainView("monitor")}
                      >
                        {t("monitor.title")}
                      </button>
                    )}
                    {!filesOnly && (
                      <button
                        data-testid="view-plugins"
                        data-active={pluginsVisible}
                        aria-pressed={pluginsVisible}
                        onClick={() => openMainView("plugins")}
                      >
                        {t("plugins.title")}
                      </button>
                    )}
                  </div>
                  {/* 录制钮（会话域，2026-10-18 裁定不常驻；「正在录」例外保留
                      指示+停止入口——悄悄进行比红点消失更糟）；前置分隔线与
                      切换器组区隔（2026-10-19 用户反馈） */}
                  {!filesOnly && (sessionViewActive || anyRecording) && (
                    <>
                      <span className="toolbar-sep" aria-hidden="true" />
                      <RecordToggle
                        rustId={rootSession?.rustId ?? null}
                        hostId={
                          rootSession?.kind === "local" ? null : rootSession?.hostId ?? null
                        }
                        // 仅在终端视图可开始录制；子页签（文件/进程/监控/
                        // 插件）里录制只捕获终端输出，与眼前操作无关——
                        // 已在录时仍显示红点与停止入口（组件内按 recording
                        // 自行渲染），不提供误导性的开始按钮。
                        canStart={mainView === "terminal" || anyRecording}
                      />
                    </>
                  )}
                </>
              ) : null
            }
          />
      </div>
      {/* 终端隐藏常驻：visibility 而非卸载（见头注不变量）。
          data-terminal = 终端聚焦守卫判定容器（评审 M-4），恒在 DOM。
          data-yield = files/procs 视图时折叠本行（ui-batch2 T1，审计 48/49）：
          此时行内内容全部 out-of-flow（holder absolute 让位、侧栏卸载），行若
          仍 flex:1 会与平级渲染的 FilePanel/ProcessBrowser 50/50 均分主区——
          面板被压半高。overview/batch 的实体视图渲染在行内，保持 flex:1。
          （工具行已迁出本 holder——2026-10-19 热修，见上方注释。） */}
      <div
        className="term-main-row"
        data-yield={filesVisible || procsVisible || monitorVisible || pluginsVisible}
      >
        <div
          className="term-area-holder"
          data-testid="term-holder"
          data-hidden={slotView !== null || !termViewActive}
          data-terminal=""
        >
          <TerminalArea />
        </div>
        {slotView !== null ? (
          slotPane
        ) : (
          termViewActive && (
            // 方案 A 会话作用域（2026-10-19）：面板读写都落 active 会话自己的
            // 切片；key=sessionId 保证切会话即重挂（markSeen 徽标口径随之正确）。
            <DiagnosePanel
              key={activeSession?.id ?? "none"}
              sessionId={activeSession?.id ?? ""}
              onOpenSettings={onOpenAiSettings}
            />
          )
        )}
      </div>
      {/* 监控/插件（2026-10-17 批次三）：满幅视图 + 统一外壳，平级渲染同
          文件/进程；终端 visibility 隐藏常驻（缓冲/滚动回看不丢）。 */}
      {monitorVisible && rootSession && (
        <WorkspaceViewShell labelKey="monitor.title" description={t("workspace.monitor.desc")}>
          <MonitorPanel rustId={rootSession.rustId} enabled={monitorEnabled} />
        </WorkspaceViewShell>
      )}
      {pluginsVisible && rootSession && (
        <WorkspaceViewShell labelKey="plugins.title" description={t("workspace.plugins.desc")}>
          <PluginPanel rustId={rootSession.rustId} />
        </WorkspaceViewShell>
      )}
      {filesVisible && rootSession && <FilePanel session={rootSession} />}
      {procsVisible && rootSession && <ProcessBrowser rustId={rootSession.rustId} />}
    </main>
  );
}
