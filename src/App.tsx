// App（Task 5 重构）：主页 = 左侧主机树 + 主区占位（终端 Task 7 接入）。
// spike 页（?spike=…）为 Task 4/7/11 自动化测量入口，原样保留（台账裁定：
// UI 侧 spike 分支由 Task 7 重构时清除）；Task 11 的人工验证按钮暂驻顶栏
// （Task 8 设置页落地时迁移）。
// 注：旧模板 greet 页与 home.* 词典段随本重构消亡；AppContent 不再持有任何
// hooks（条件返回在 hooks 之前的历史债随模板页一并清偿）。
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import OttrTerminal, { RenderSpike, ThroughputSpike } from "./terminal/Terminal";
import { HostTree } from "./hosts/HostTree";
import { HostForm } from "./hosts/HostForm";
import { ImportDialog } from "./hosts/ImportDialog";
import { QuickConnect } from "./hosts/QuickConnect";
import { CredentialsDialog } from "./credentials/CredentialsDialog";
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

// --- 主页布局（Task 5）------------------------------------------------------

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

  // 首屏拉取 vault 数据（失败时 store.error 驱动主区错误横幅）
  useEffect(() => {
    void useVaultStore.getState().refresh().catch(() => {});
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
        {/* Task 11 / Spike #7/#8 人工验证入口（自动化路径走 ?spike= 页） */}
        <button id="spike-keyring-btn" className="topbar-debug">
          {t("spike.keyringButton")}
        </button>
        <button id="spike-notify-btn" className="topbar-debug">
          {t("spike.notifyButton")}
        </button>
      </header>
      <div className="app-body">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <HostTree
            selectedId={selectedId}
            onSelect={(host) => setSelectedId(host.id)}
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
              <p>{t("mainArea.terminalPending")}</p>
            </section>
          ) : (
            <section className="main-placeholder">
              <p>{t("mainArea.placeholder")}</p>
            </section>
          )}
        </main>
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
      <QuickConnect
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelect={(host) => {
          setSelectedId(host.id);
          setPaletteOpen(false);
        }}
      />
    </div>
  );
}

function AppContent() {
  // Task 4/7/11/13 spike 入口：?spike=latency | throughput | keyring | notify | render
  // （自动化由 OTTR_SPIKE 导航进来，见 src-tauri lib.rs setup）
  const spike = new URLSearchParams(window.location.search).get("spike");
  if (spike === "latency") {
    return <OttrTerminal spike="latency" />;
  }
  if (spike === "throughput") {
    return <ThroughputSpike />;
  }
  if (spike === "render") {
    return <RenderSpike />;
  }
  if (spike === "keyring") {
    return <KeyringSpikePage />;
  }
  if (spike === "notify") {
    return <NotifySpikePage />;
  }
  return <HomeLayout />;
}

// ---------------------------------------------------------------------------
// Task 11 / Spike #7：keyring 读写（service "ottr.spike" 与正式数据隔离）
// 流程：set → get → del → assert（del 后 get 应 NoEntry）；报告 JSON 落盘
// /tmp/ottr-keyring.json（驱动脚本 scripts/spike-desktop-api.sh 轮询取数）。
// ---------------------------------------------------------------------------

const KEYRING_SERVICE = "ottr.spike";
const KEYRING_ACCOUNT = "spike-account";

interface KeyringReport {
  mode: "keyring";
  service: string;
  account: string;
  value_sent: string;
  value_got: string | null;
  steps: { set: string; get: string; del: string; get_after_del: string };
  roundtrip: boolean;
  deleted_assert: boolean;
  pass: boolean;
  cleanup: string;
  error?: string;
}

/** 单步包装：失败不中断后续步骤（del 兜底清理仍要执行），detail 记录错误。 */
async function step(name: string, fn: () => Promise<void>): Promise<string | null> {
  pageLog(`keyring: ${name}`);
  try {
    await fn();
    return null;
  } catch (e) {
    return `${name}: ${e}`;
  }
}

function pageLog(msg: string) {
  void invoke("spike_log", { msg }).catch(() => {});
}

async function runKeyringSteps(): Promise<KeyringReport> {
  const value = `ottr-spike-secret-${Date.now()}`;
  const r: KeyringReport = {
    mode: "keyring",
    service: KEYRING_SERVICE,
    account: KEYRING_ACCOUNT,
    value_sent: value,
    value_got: null,
    steps: { set: "not-run", get: "not-run", del: "not-run", get_after_del: "not-run" },
    roundtrip: false,
    deleted_assert: false,
    pass: false,
    cleanup: "n/a（条目已删）",
  };

  // set
  let err = await step("set", () => invoke("spike_keyring_set", { value }));
  r.steps.set = err ?? "ok";
  if (err) {
    r.error = err;
    return r;
  }

  // get（值必须一致）
  pageLog("keyring: get");
  try {
    const got = await invoke<string>("spike_keyring_get");
    r.value_got = got;
    r.roundtrip = got === value;
    r.steps.get = r.roundtrip ? "ok（值一致）" : `值不一致: ${got}`;
  } catch (e) {
    r.steps.get = `get: ${e}`;
  }

  // del
  err = await step("del", () => invoke("spike_keyring_del"));
  r.steps.del = err ?? "ok";

  // assert：del 后 get 应 NoEntry（删除生效）
  if (!err) {
    pageLog("keyring: get after del（应 NoEntry）");
    try {
      const again = await invoke<string>("spike_keyring_get");
      r.steps.get_after_del = `删除未生效，仍读到: ${again}`;
    } catch {
      r.steps.get_after_del = "ok（NoEntry，符合预期）";
      r.deleted_assert = true;
    }
  }

  // 兜底清理：任何一步失败导致条目残留时再删一次（验证完不留条目）
  if (r.steps.del !== "ok" || r.steps.get_after_del.startsWith("删除未生效")) {
    pageLog("keyring: cleanup retry");
    r.cleanup = (await step("cleanup-del", () => invoke("spike_keyring_del"))) ?? "ok";
  }

  r.pass = r.roundtrip && r.deleted_assert;
  return r;
}

/** StrictMode dev 双挂载防护：自动页整个生命周期只跑一次（同 Terminal.tsx 模式）。 */
let keyringPageRan = false;

function KeyringSpikePage() {
  const [out, setOut] = useState("spike:keyring 初始化…");
  if (!keyringPageRan) {
    keyringPageRan = true;
    void (async () => {
      try {
        const report = await runKeyringSteps();
        setOut(JSON.stringify(report, null, 2));
        const path = await invoke<string>("spike_report_file", {
          path: "/tmp/ottr-keyring.json",
          payload: JSON.stringify(report),
        });
        pageLog(`keyring report -> ${path}`);
      } catch (e) {
        pageLog(`keyring report failed: ${e}`);
        // 落一份失败报告让驱动脚本快速失败（而非干等超时）
        void invoke("spike_report_file", {
          path: "/tmp/ottr-keyring.json",
          payload: JSON.stringify({ mode: "keyring", pass: false, error: String(e) }),
        }).catch(() => {});
      }
    })();
  }
  return (
    <main className="container">
      <h1>Spike #7: keyring 读写</h1>
      <p>set → get → del → assert（报告落盘 /tmp/ottr-keyring.json）</p>
      <pre id="spike-keyring-out" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {out}
      </pre>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Task 11 / Spike #8：系统通知。API 层调用成功即记 PASS(API 层)——macOS 未授权时
// 通知被系统静默丢弃但 show() 不报错，「弹窗显示 + 点击回焦」只能人工确认
// （列入 T13 runbook；Windows Toast 应用身份 / Linux libnotify 同理）。
// ---------------------------------------------------------------------------

interface NotifyReport {
  mode: "notify";
  api: "ok" | "fail";
  error: string | null;
  note: string;
}

async function runNotifySteps(): Promise<NotifyReport> {
  try {
    await invoke("spike_notify", {
      title: "Ottr spike（Spike #8）",
      body: "通知已触发：请点我回焦窗口",
    });
    return {
      mode: "notify",
      api: "ok",
      error: null,
      note: "插件 API 调用成功；弹窗是否显示 + 点击回焦需人工确认（T13 runbook）",
    };
  } catch (e) {
    return { mode: "notify", api: "fail", error: String(e), note: "插件 API 调用失败" };
  }
}

let notifyPageRan = false;

function NotifySpikePage() {
  const [out, setOut] = useState("spike:notify 初始化…");
  if (!notifyPageRan) {
    notifyPageRan = true;
    void (async () => {
      try {
        const report = await runNotifySteps();
        setOut(JSON.stringify(report, null, 2));
        const path = await invoke<string>("spike_report_file", {
          path: "/tmp/ottr-notify.json",
          payload: JSON.stringify(report),
        });
        pageLog(`notify report -> ${path}`);
      } catch (e) {
        pageLog(`notify report failed: ${e}`);
        void invoke("spike_report_file", {
          path: "/tmp/ottr-notify.json",
          payload: JSON.stringify({ mode: "notify", api: "fail", error: String(e) }),
        }).catch(() => {});
      }
    })();
  }
  return (
    <main className="container">
      <h1>Spike #8: 系统通知</h1>
      <p>spike_notify 已调用（报告落盘 /tmp/ottr-notify.json）；弹窗需人工目视确认。</p>
      <pre id="spike-notify-out" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
        {out}
      </pre>
    </main>
  );
}

/** ThemeProvider 挂在最外层：spike 页与主页共享 data-theme（spike 测量页样式固定深底，不受影响）。 */
export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
