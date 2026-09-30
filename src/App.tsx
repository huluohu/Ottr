// App（Task 7 重构）：单页 = 顶栏 + 主机树 + 标签化终端主区。
//
// 【条件 hooks 债清偿（终审风险③）】Phase 0 的 `?spike=` early-return 发生在
// AppContent hooks 之前，属条件分支打破 hooks 顺序约定的历史债；本重构删除
// spike UI 分支（台账裁定：scripts/ 命令面保留在 Rust 侧，UI 侧分支清除），
// App 成为单一渲染路径——没有任何条件 return，hooks 顺序恒定。
// Task 4/11 的 spike 测量页（latency/throughput/keyring/notify/render）与
// 顶栏 keyring/notify 手动验证按钮随本重构消亡。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { HostTree } from "./hosts/HostTree";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { QuickConnect } from "./hosts/QuickConnect";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
import { TabBar } from "./session/TabBar";
import { HostKeyDialog } from "./session/HostKeyDialog";
import { TerminalArea } from "./terminal/Terminal";
import { FilePanel } from "./files/FilePanel";
import { initSessionEvents } from "./session/events";
import { initTransferEvents } from "./files/events";
import { useSessionStore } from "./session/SessionStore";
import { ThemeProvider, useTheme, type ThemeMode } from "./theme/ThemeContext";
import { useVaultStore } from "./vault/store";
import type { Host } from "./vault/api";
import "./theme/tokens.css";
import "./App.css";

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
  const hosts = useVaultStore((s) => s.hosts);
  const storeError = useVaultStore((s) => s.error);
  // 会话面（Task 7）：标签条 + 分屏终端主区（Task 8） + host key 确认框
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const openTab = useSessionStore((s) => s.openTab);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  // 首屏：vault 数据 → 会话事件监听 → 标签恢复（不自动连接，安全考虑见
  // SessionStore.restoreTabs）。恢复依赖 hosts 就位，故排在 refresh 之后。
  useEffect(() => {
    void (async () => {
      try {
        await useVaultStore.getState().refresh();
      } catch {
        // 失败由 store.error 驱动主区错误横幅；恢复跳过（无主机可查）
      }
      await initSessionEvents();
      await initTransferEvents();
      useSessionStore.getState().restoreTabs(useVaultStore.getState().hosts);
    })();
  }, []);

  // ⌘K / Ctrl+K 呼出快速连接（雏形：Task 14 扩成完整命令面板）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="topbar-title">Ottr</span>
        <button className="topbar-palette" data-testid="open-quick-connect" onClick={() => setPaletteOpen(true)}>
          {t("quickConnect.title")} <kbd>{t("quickConnect.buttonHint")}</kbd>
        </button>
        <button className="topbar-debug" data-testid="open-credentials" onClick={() => setCredentialsOpen(true)}>
          {t("credentials.openButton")}
        </button>
        <div className="topbar-spacer" />
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
                <button
                  data-testid="view-terminal"
                  data-active={!filesOpen}
                  aria-pressed={!filesOpen}
                  onClick={() => setFilesOpen(false)}
                >
                  {t("files.viewTerminal")}
                </button>
                <button
                  data-testid="view-files"
                  data-active={filesOpen}
                  aria-pressed={filesOpen}
                  onClick={() => setFilesOpen(true)}
                >
                  {t("files.viewFiles")}
                </button>
              </div>
            </div>
            {/* 终端隐藏常驻（Task 10）：visibility 而非卸载——xterm 缓冲/滚动回看不丢 */}
            <div className="term-area-holder" data-hidden={filesOpen}>
              <TerminalArea />
            </div>
            {filesOpen && rootSession && <FilePanel session={rootSession} />}
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
      <HostKeyDialog />
      <QuickConnect
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(host) => {
          openTab(host);
          setPaletteOpen(false);
        }}
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
