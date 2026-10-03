// MainArea（UI 批次一 Task 2；Task 3 实体迁入）：主区视图路由——
// workspaceStore.mainView 状态机驱动的五视图切换（terminal/files/processes/
// overview/batch）。
//
// 【终端常驻不变量】非 terminal 视图时终端 DOM **保留但隐藏**（visibility 制式，
// 沿 Task 10 文件视图先例：absolute+inset 保持原尺寸，回视图无需 refit）——
// xterm 缓冲/滚动回看不丢，运行中会话不卸载。overview/batch 视图同制式
// （Task 3 起 OverviewPage/BatchPanel 实体挂在这里，占位壳 MainViewSlot 消亡）。
//
// 【实体导航接线（Task 3）】总览卡片点击 = openTab + openMainView("terminal")
// （原对话框 onClose 语义等价迁移）；「进程」= openTab + openMainView("processes")；
// 两实体头部「← 终端」= openMainView("terminal")（原 slot-back-terminal 语义）。
//
// 【filesOnly 覆盖】FTP/FTPS 会话无 PTY 终端：mainView 无论何值（视图族内）恒
// 文件视图、终端/进程按钮隐藏——原 HomeLayout 行为等价迁移（原 filesOpen 布尔
// 换成 mainView==='files'）。
//
// 【视觉不变】term-main-row 的 AI 诊断/监控/插件三侧栏仍只在终端视图挂载
// （原 `!filesVisible && !procsVisible` 域）；监控/插件竖条的自管折叠语义不动。
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
// 语义）/ ⌘K 命令面板卡（onOpenPalette → setPaletteOpen(true) 既有语义）。
// 空态判定不变（terminalMode=false + selected=null 分支），占位文案保留为
// 卡片引导语；两 prop 缺省时对应入口不渲染（组件可独立挂载，行为可裁剪）。
import { useTranslation } from "react-i18next";
import { TabBar } from "../session/TabBar";
import { TerminalArea } from "../terminal/Terminal";
import { FilePanel } from "../files/FilePanel";
import { ProcessBrowser } from "../monitor/ProcessBrowser";
import { DiagnosePanel } from "../ai/DiagnosePanel";
import { MonitorSidebar } from "../monitor/MonitorSidebar";
import { PluginSidebar } from "../plugins/PluginSidebar";
import { RecordToggle } from "../history/RecordToggle";
import { OverviewPage } from "../monitor/OverviewPage";
import { BatchPanel } from "../batch/BatchPanel";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";
import { platform, shortcutLabel } from "../shortcuts/registry";
import { useWorkspaceStore } from "./workspaceStore";

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
  /** 空态快捷卡「⌘K 命令面板」入口（App 注入 = setPaletteOpen(true)；缺省 =
   * 入口不渲染）。 */
  onOpenPalette?: () => void;
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

export function MainArea({ storeError, selected, onOpenAiSettings, onAddHost, onOpenPalette }: MainAreaProps) {
  const { t } = useTranslation();
  const mainView = useWorkspaceStore((s) => s.mainView);
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
  // 视图可见性（mainView 单值互斥 + filesOnly 覆盖，语义与原实现等价）
  const filesVisible = mainView === "files" || (terminalMode && filesOnly);
  const procsVisible = mainView === "processes" && !filesVisible;
  const termViewActive = mainView === "terminal" && !filesOnly;
  // overview/batch 实体视图（UI 批次一 Task 3 迁入；占位壳 MainViewSlot 消亡）。
  // 导航接线：卡片 = 跳标签 + 回终端；「进程」= 跳标签 + 切进程视图；
  // 头部返回按钮 = 回终端（会话与终端缓冲从未卸载）。
  const slotView = mainView === "overview" || mainView === "batch" ? mainView : null;
  const backToTerminal = () => openMainView("terminal");
  const slotPane =
    slotView === null ? null : slotView === "overview" ? (
      <OverviewPage
        onClose={backToTerminal}
        onOpen={(host) => {
          openTab(host);
          openMainView("terminal");
        }}
        onOpenProcesses={(host) => {
          openTab(host);
          openMainView("processes");
        }}
      />
    ) : (
      <BatchPanel onClose={backToTerminal} />
    );

  // 零会话：占位面（原分支原样——视图族按钮只在有会话时存在）。overview/batch
  // 零会话也可开（原对话框语义），此时无终端可保留，实体视图独占主区。
  if (!terminalMode) {
    return (
      <main className="main-area" data-testid="main-area">
        {slotView !== null ? (
          slotPane
        ) : (
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
                <p>{t("mainArea.placeholder")}</p>
                {(fixtureHost || onAddHost || onOpenPalette) && (
                  <div className="main-empty-actions" data-testid="main-empty-actions">
                    {fixtureHost && (
                      <button
                        type="button"
                        className="main-empty-card"
                        data-testid="empty-connect-fixture"
                        onClick={() => openTab(fixtureHost)}
                      >
                        <span className="main-empty-card-title">
                          {t("mainArea.quickFixture", { name: fixtureHost.name })}
                        </span>
                        <span className="main-empty-card-desc">
                          {fixtureHost.username ? `${fixtureHost.username}@` : ""}
                          {fixtureHost.address}:{fixtureHost.port}
                        </span>
                      </button>
                    )}
                    {onAddHost && (
                      <button
                        type="button"
                        className="main-empty-card"
                        data-testid="empty-add-host"
                        onClick={onAddHost}
                      >
                        <span className="main-empty-card-title">{t("mainArea.quickAddHost")}</span>
                        <span className="main-empty-card-desc">{t("mainArea.quickAddHostDesc")}</span>
                      </button>
                    )}
                    {onOpenPalette && (
                      <button
                        type="button"
                        className="main-empty-card"
                        data-testid="empty-palette-hint"
                        onClick={onOpenPalette}
                      >
                        <span className="main-empty-card-title">{t("mainArea.quickPalette")}</span>
                        <span className="main-empty-card-desc">
                          <kbd className="main-empty-kbd">{paletteLabel}</kbd>{" "}
                          {t("mainArea.quickPaletteDesc")}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    );
  }

  // 有会话：标签条 + 视图切换 + 终端常驻区（五视图路由核心）。
  // 【终端常驻不变量】五视图共用同一 term-main-row：overview/batch 实体视图
  // 渲染在让位的侧栏位置，终端 holder 恒在 DOM（data-hidden 切 visibility）——
  // 任何视图切换都不卸载终端（xterm 缓冲/滚动回看不丢，运行中会话保留）。
  return (
    <main className="main-area terminal-mode" data-testid="main-area">
      <div className="tabbar-row">
        <TabBar />
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
        </div>
        {!filesOnly && (
          <RecordToggle
            rustId={rootSession?.rustId ?? null}
            hostId={rootSession?.hostId ?? null}
          />
        )}
      </div>
      {/* 终端隐藏常驻：visibility 而非卸载（见头注不变量）。
          data-terminal = 终端聚焦守卫判定容器（评审 M-4），恒在 DOM。
          data-yield = files/procs 视图时折叠本行（ui-batch2 T1，审计 48/49）：
          此时行内内容全部 out-of-flow（holder absolute 让位、侧栏卸载），行若
          仍 flex:1 会与平级渲染的 FilePanel/ProcessBrowser 50/50 均分主区——
          面板被压半高。overview/batch 的实体视图渲染在行内，保持 flex:1。 */}
      <div
        className="term-main-row"
        data-yield={filesVisible || procsVisible}
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
            <>
              <DiagnosePanel onOpenSettings={onOpenAiSettings} />
              <MonitorSidebar
                rustId={rootSession?.rustId ?? null}
                enabled={
                  hosts.find((h) => h.id === rootSession?.hostId)?.monitor_enabled ?? false
                }
              />
              <PluginSidebar rustId={rootSession?.rustId ?? null} />
            </>
          )
        )}
      </div>
      {filesVisible && rootSession && <FilePanel session={rootSession} />}
      {procsVisible && rootSession && <ProcessBrowser rustId={rootSession.rustId} />}
    </main>
  );
}
