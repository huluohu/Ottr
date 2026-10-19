// Dev 预览入口（dev-preview.html 专用；不进生产构建——vite build 只打
// index.html 入口）。用途：**纯前端布局/可见性回归的浏览器级验证载体**
// （2026-10-19 验证分层升级：此类回归不走真机，内置浏览器截图断言即可）。
//
// 机制：安装 window.__TAURI_INTERNALS__ 假件（invoke 按命令表应答、未命中
// 返回 null），让 App/MainArea 能在纯浏览器里挂载；store 种子直接 setState
// （一条已连接会话），UI 交互（点页签/切换器）真实生效。
// 用法：`npm run dev` 后访问 http://localhost:1420/dev-preview.html
import React from "react";
import ReactDOM from "react-dom/client";

// --- Tauri internals 假件（必须在 @tauri-apps/api 模块求值前就位）----------
type InvokeTable = Record<string, unknown>;
const invokeTable: InvokeTable = {
  // 常用查询面给空集合/空对象，写面给可链式空值；未命中命令一律 null
  hosts_list: [],
  host_groups_list: [],
  credentials_list: [],
  jump_chains_list: [],
  snippets_list: [],
  settings_get: null,
  vault_status: { phase: "ready" },
};
class MockChannel {
  constructor() {}
  toJSON() {
    return "__CHANNEL__";
  }
}
// 文件面板验证模式（?files=1）：假 sftp/local 数据 + 调用记录（浏览器断言面）
const filesMode = new URLSearchParams(location.search).get("files") === "1";
interface FakeEntry { name: string; is_dir: boolean; size: number; mode: number; mtime: number }
const dir = (name: string): FakeEntry => ({ name, is_dir: true, size: 0, mode: 0o40755, mtime: 1700000000 });
const file = (name: string, size = 42): FakeEntry => ({ name, is_dir: false, size, mode: 0o100644, mtime: 1700000000 });
const LOCAL: Record<string, FakeEntry[]> = {
  "/Users/preview": [dir("docs"), dir("photos"), file("notes.txt"), file("readme.md")],
  "/Users/preview/docs": [file("a.md"), file("b.md")],
  "/Users/preview/photos": [file("p1.jpg")],
};
const REMOTE: Record<string, FakeEntry[]> = {
  "/home/preview": [dir("logs"), file("conf.yml"), file("data.bin", 2048)],
  "/home/preview/logs": [file("app.log", 512)],
};
const calls: Array<[string, unknown]> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__calls = calls;

if (filesMode) {
  invokeTable.local_home = "/Users/preview";
  invokeTable.sftp_realpath = "/home/preview";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__TAURI_INTERNALS__ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (cmd: string, args?: any) => {
    if (filesMode) {
      calls.push([cmd, args]);
      if (cmd === "local_list") return Promise.resolve(LOCAL[args?.path] ?? []);
      if (cmd === "sftp_list") return Promise.resolve(REMOTE[args?.path] ?? []);
      if (cmd === "sftp_mkdir_all" || cmd === "sftp_mkdir") return Promise.resolve(null);
      if (cmd === "sftp_upload" || cmd === "sftp_download")
        return Promise.resolve({
          transfer_id: `xfer-${calls.length}`,
          local_path: String(args?.local ?? "/dev/null"),
          remote_path: String(args?.path ?? "/tmp/x"),
          total: 1,
        });
    }
    if (cmd in invokeTable) return Promise.resolve(invokeTable[cmd]);
    return Promise.resolve(null);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transformCallback: (cb: any) => (typeof cb === "function" ? cb : () => {}),
  metadata: { currentWindow: { label: "preview" }, currentWebview: { label: "preview" } },
  plugins: {},
};
// Channel 类走内部转换，给个可 new 的桩
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__TAURI_CHANNEL_STUB__ = MockChannel;

import "./../i18n";
import "./../theme/tokens.css";
import "./../styles/index.css";
import { ThemeProvider } from "./../theme/ThemeContext";
import { MainArea } from "./../workspace/MainArea";
import { useSessionStore } from "./../session/SessionStore";
import { useVaultStore } from "./../vault/store";

// --- 种子：一条已连接会话（term-view 与子页签切换的布局验证面）------------
const seedHost = {
  id: 1,
  name: "preview-host",
  group_id: null,
  tags: [],
  address: "127.0.0.1",
  port: 22,
  username: "preview",
  protocol: "ssh" as const,
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};
useVaultStore.setState({ hosts: [seedHost], hostGroups: [], loading: false, error: null });
useSessionStore.setState({
  sessions: [
    {
      id: "preview-tab",
      hostId: 1,
      hostName: "preview-host",
      rustId: "pty-preview",
      paneOf: null,
      status: "connected",
      attempt: 0,
      nextRetryAt: null,
      lastError: null,
      restored: true,
      encoding: "utf-8",
      isProduction: false,
      protocol: "ssh",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ].map((x) => x as any),
  activeId: "preview-tab",
  trees: { "preview-tab": { kind: "leaf", id: "preview-tab" } },
  activePane: { "preview-tab": "preview-tab" },
});

// PTY 数据面在浏览器里不存在（attach 未真跑），终端画布为空属预期——本页
// 只验证布局/可见性。定期以假输出喂画布让终端区非空（视觉参照）。
setInterval(() => {
  const sinkWrite = (window as unknown as { __previewFeed__?: (s: string) => void })
    .__previewFeed__;
  sinkWrite?.(`preview line ${new Date().toLocaleTimeString()}\r\n`);
}, 3000);

async function render() {
  if (filesMode) {
    const { FilePanel } = await import("./../files/FilePanel");
    const session = {
      id: "preview-tab",
      hostId: 1,
      hostName: "preview-host",
      address: "127.0.0.1",
      port: 22,
      username: "preview",
      protocol: "ssh",
      rustId: "pty-preview",
      paneOf: null,
      status: "connected",
      encoding: "utf-8",
      isProduction: false,
    } as unknown as Parameters<typeof FilePanel>[0]["session"];
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div style={{ height: "100vh" }}>
            <FilePanel session={session} />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <MainArea storeError={null} selected={seedHost} onOpenAiSettings={() => {}} />
      </ThemeProvider>
    </React.StrictMode>,
  );
}
void render();
