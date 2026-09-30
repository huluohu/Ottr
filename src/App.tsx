import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import OttrTerminal, { RenderSpike, ThroughputSpike } from "./terminal/Terminal";
import { ThemeProvider, useTheme, type ThemeMode } from "./theme/ThemeContext";
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

function AppContent() {
  const { t } = useTranslation();
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

  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [keyringOut, setKeyringOut] = useState("");
  const [notifyOut, setNotifyOut] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  // Task 11 / Spike #7：人工验证按钮（自动化路径走 ?spike=keyring 页）
  async function runKeyringButton() {
    setKeyringOut("running…");
    try {
      const r = await runKeyringSteps();
      setKeyringOut(JSON.stringify(r, null, 2));
    } catch (e) {
      setKeyringOut(`failed: ${e}`);
    }
  }

  // Task 11 / Spike #8：人工验证按钮（自动化路径走 ?spike=notify 页）
  async function runNotifyButton() {
    setNotifyOut("running…");
    try {
      setNotifyOut(JSON.stringify(await runNotifySteps(), null, 2));
    } catch (e) {
      setNotifyOut(`failed: ${e}`);
    }
  }

  return (
    <main className="container">
      <h1>{t("home.title")}</h1>

      {/* A10 主题切换（Task 8 设置页落地前的临时控件） */}
      <ThemeSwitch />

      <div className="row">
        <a href="https://vite.dev" target="_blank">
          <img src="/vite.svg" className="logo vite" alt="Vite logo" />
        </a>
        <a href="https://tauri.app" target="_blank">
          <img src="/tauri.svg" className="logo tauri" alt="Tauri logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <p>{t("home.logosHint")}</p>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          id="greet-input"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={t("home.greetPlaceholder")}
        />
        <button type="submit">{t("home.greetButton")}</button>
      </form>
      <p>{greetMsg}</p>

      {/* Task 11 / Spike #7/#8 人工验证入口 */}
      <div className="row">
        <button id="spike-keyring-btn" onClick={runKeyringButton}>
          {t("spike.keyringButton")}
        </button>
        <button id="spike-notify-btn" onClick={runNotifyButton}>
          {t("spike.notifyButton")}
        </button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{keyringOut}</pre>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{notifyOut}</pre>
    </main>
  );
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
