// MainArea（UI 批次一 Task 2）：主区视图路由——workspaceStore.mainView 状态机
// 驱动的五视图切换（terminal/files/processes/overview/batch）。
//
// 【终端常驻不变量】非 terminal 视图时终端 DOM **保留但隐藏**（visibility 制式，
// 沿 Task 10 文件视图先例：absolute+inset 保持原尺寸，回视图无需 refit）——
// xterm 缓冲/滚动回看不丢，运行中会话不卸载。overview/batch 视图同制式（原为
// 顶栏对话框叠加，现迁入主区互斥体系；实体 T3 迁入）。
//
// 【filesOnly 覆盖】FTP/FTPS 会话无 PTY 终端：mainView 无论何值（视图族内）恒
// 文件视图、终端/进程按钮隐藏——原 HomeLayout 行为等价迁移（原 filesOpen 布尔
// 换成 mainView==='files'）。
//
// 【视觉不变】term-main-row 的 AI 诊断/监控/插件三侧栏仍只在终端视图挂载
// （原 `!filesVisible && !procsVisible` 域）；监控/插件竖条的自管折叠语义不动。
import { useTranslation } from "react-i18next";
import { TabBar } from "../session/TabBar";
import { TerminalArea } from "../terminal/Terminal";
import { FilePanel } from "../files/FilePanel";
import { ProcessBrowser } from "../monitor/ProcessBrowser";
import { DiagnosePanel } from "../ai/DiagnosePanel";
import { MonitorSidebar } from "../monitor/MonitorSidebar";
import { PluginSidebar } from "../plugins/PluginSidebar";
import { RecordToggle } from "../history/RecordToggle";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";
import { MainViewSlot } from "./MainViewSlot";
import { useWorkspaceStore } from "./workspaceStore";

interface MainAreaProps {
  /** vault refresh 失败横幅（HomeLayout 启动链持有，透传）。 */
  storeError: string | null;
  /** 左树选中主机（无会话时的占位面）。 */
  selected: Host | null;
  /** AI 诊断面板「去设置」→ AI 设置对话框（对话框入口仍在 HomeLayout）。 */
  onOpenAiSettings: () => void;
}

export function MainArea({ storeError, selected, onOpenAiSettings }: MainAreaProps) {
  const { t } = useTranslation();
  const mainView = useWorkspaceStore((s) => s.mainView);
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const hosts = useVaultStore((s) => s.hosts);

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
  // overview/batch 槽位视图（占位组件，T3 迁实体）
  const slotView = mainView === "overview" || mainView === "batch" ? mainView : null;

  // 零会话：占位面（原分支原样——视图族按钮只在有会话时存在）。overview/batch
  // 零会话也可开（原对话框语义），此时无终端可保留，槽位独占主区。
  if (!terminalMode) {
    return (
      <main className="main-area" data-testid="main-area">
        {slotView !== null ? (
          <MainViewSlot view={slotView} />
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
              <section className="main-placeholder">
                <p>{t("mainArea.placeholder")}</p>
              </section>
            )}
          </>
        )}
      </main>
    );
  }

  // 有会话：标签条 + 视图切换 + 终端常驻区（五视图路由核心）。
  // 【终端常驻不变量】五视图共用同一 term-main-row：overview/batch 槽位渲染在
  // 让位的侧栏位置，终端 holder 恒在 DOM（data-hidden 切 visibility）——任何
  // 视图切换都不卸载终端（xterm 缓冲/滚动回看不丢，运行中会话保留）。
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
          data-terminal = 终端聚焦守卫判定容器（评审 M-4），恒在 DOM。 */}
      <div className="term-main-row">
        <div
          className="term-area-holder"
          data-testid="term-holder"
          data-hidden={slotView !== null || !termViewActive}
          data-terminal=""
        >
          <TerminalArea />
        </div>
        {slotView !== null ? (
          <MainViewSlot view={slotView} />
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
