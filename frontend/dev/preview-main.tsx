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
const recMode = new URLSearchParams(location.search).get("rec") === "1";
const hostsMode = new URLSearchParams(location.search).get("hosts") === "1";
const ftpMode = new URLSearchParams(location.search).get("ftp") === "1";
const lockMode = new URLSearchParams(location.search).get("lock") === "1";
const formMode = new URLSearchParams(location.search).get("form") === "1";
const sideMode = new URLSearchParams(location.search).get("side") === "1";
// 图标轨更新钮/面板目检（2026-10-26）：?update=available|downloading|installed|
// error|checking —— 种子 updateStore，验证钮贴锁定键正上方 + 面板四态排版。
const updateMode = new URLSearchParams(location.search).get("update");
// 设置页目检（2026-10-26）：?settings=sync —— 设置页直落同步分区，且已保存
// 本地目录通道让「立即同步」可点，验证同步子弹框叠在设置之上（设置不被顶掉）。
const settingsMode = new URLSearchParams(location.search).get("settings");
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
if (recMode) {
  invokeTable.recording_search = [
    { id: 1, host_id: 1, path: "/Users/preview/Library/Application Support/ottr/recordings/rec-1.cast",
      duration: 2, text_index_path: "recordings_fts:1", created_at: 1792400000,
      snippet: "[root@iZbp1jfknvc71e3lhetottZ ~]#" },
    { id: 2, host_id: 1, path: "/Users/preview/Library/Application Support/ottr/recordings/rec-2.cast",
      duration: 82, text_index_path: "recordings_fts:2", created_at: 1792300000,
      snippet: "% " },
  ];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__TAURI_INTERNALS__ = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (cmd: string, args?: any) => {
    if (filesMode || recMode) {
      calls.push([cmd, args]);
    }
    if (filesMode) {
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
    if (settingsMode && cmd === "settings_get") {
      if (args?.key === "sync.channel") return Promise.resolve("localdir");
      if (args?.key === "sync.config.localdir") return Promise.resolve({ path: "/tmp/ottr-sync-preview" });
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
  if (settingsMode) {
    const { SecuritySettings } = await import("./../security/SecuritySettings");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <MainArea storeError={null} selected={seedHost} onOpenAiSettings={() => {}} />
          <SecuritySettings open initialPane={settingsMode as "sync"} onClose={() => {}} />
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (updateMode) {
    const { IconRail } = await import("./../app/IconRail");
    const { useUpdateStore } = await import("./../update/updateStore");
    const { useVaultLockStore } = await import("./../security/VaultLockStore");
    useVaultLockStore.setState({ phase: "unlocked", mode: "password" } as never);
    const info = {
      version: "1.5.9",
      date: "2026-10-26T04:13:21Z",
      body: [
        "## 🔄 1.5.9：更新提醒全局协调",
        "",
        "- **图标轨更新钮贯穿全程**：有新版 / 下载中 / 待重启一处可见",
        "- **贴钮面板**：版本信息 + 发布说明 + 一键「下载并安装」",
        "- 自动检查发现新版本不再弹 toast（只亮轨上钮）",
        "- 发布说明随 latest.json 下发，面板内直接阅读",
        "",
        "详见 [发布页](https://github.com/huluohu/Ottr/releases)。",
      ].join("\n"),
    };
    const phase =
      updateMode === "downloading"
        ? { kind: "downloading", received: 3 * 1024 * 1024, total: 8 * 1024 * 1024 }
        : updateMode === "installed"
          ? { kind: "installed" }
          : updateMode === "error"
            ? { kind: "error", message: "下载失败：网络连接被重置（ECONNRESET）" }
            : updateMode === "checking"
              ? { kind: "checking" }
              : { kind: "available", update: {}, version: info.version };
    useUpdateStore.setState({ current: "1.5.8", portable: false, info, phase: phase as never });
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div className="app-shell">
            <div className="app-body">
              <IconRail
                onOpenCredentials={() => {}}
                onOpenSettings={() => {}}
                onOpenMcpSettings={() => {}}
                onOpenHistory={() => {}}
              />
              <div style={{ flex: 1 }} />
            </div>
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (formMode) {
    // 新建主机关闭钮/底部留白目检（2026-10-20 用户反馈）
    const { HostForm } = await import("./../hosts/HostForm");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <HostForm host={null} defaultGroupId={null} onClose={() => {}} />
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (sideMode) {
    // 胶囊态展开钮目检
    const { Sidebar } = await import("./../app/Sidebar");
    const { useVaultStore } = await import("./../vault/store");
    useVaultStore.setState({
      hosts: [
        { id: 1, name: "web-01", group_id: 9, tags: [], address: "10.0.0.1", port: 22, username: "root",
          protocol: "ssh", credential_id: null, jump_chain_id: null, encoding_override: null,
          theme_override: null, monitor_enabled: false, is_production: false, notes: null,
          created_at: 1, updated_at: 1 } as never,
      ],
      hostGroups: [{ id: 9, name: "Servers", parent_id: null, color: "#d92d20", created_at: 1, updated_at: 1 }] as never,
      loading: false,
      error: null,
    });
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div style={{ height: "100vh", display: "flex" }}>
            <Sidebar
              style={{ width: 64 }}
              collapsed
              onExpand={() => {}}
              selectedId={null}
              onSelect={() => {}}
              onOpen={() => {}}
              onEdit={() => {}}
              onAdd={() => {}}
              onQuickConnect={() => {}}
              onNewGroup={() => {}}
            />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (lockMode) {
    // 锁屏毛玻璃目检：主界面应用内层 + 锁屏遮罩/卡片（与 App 结构同构）
    const { MainArea } = await import("./../workspace/MainArea");
    const { LockScreen } = await import("./../security/LockScreen");
    const { useSessionStore } = await import("./../session/SessionStore");
    useSessionStore.setState({
      sessions: [
        {
          id: "preview-tab", hostId: 1, hostName: "preview-host", address: "127.0.0.1",
          port: 22, username: "preview", protocol: "ssh", jumpChainId: null,
          status: "connected", restored: true, rustId: "pty-preview", attempt: 0,
          lastError: null, nextRetryAt: null, paneOf: null, encodingOverride: "utf-8",
          encoding: "utf-8", encodingHint: null, isProduction: false,
        },
      ],
      activeId: "preview-tab",
      trees: { "preview-tab": { kind: "leaf", id: "preview-tab" } },
      activePane: { "preview-tab": "preview-tab" },
    });
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div className="app-shell" data-titlebar={undefined}>
            <div className="app-body" data-locked="true">
              <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
                <MainArea storeError={null} selected={seedHost} onOpenAiSettings={() => {}} />
              </div>
            </div>
            <LockScreen />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (ftpMode) {
    // FTP/FTPS 能力矩阵目检：会话 protocol=ftp → 只应有「文件」子页签
    const { MainArea } = await import("./../workspace/MainArea");
    const { useSessionStore } = await import("./../session/SessionStore");
    useSessionStore.setState({
      sessions: [
        {
          id: "ftp-tab", hostId: 2, hostName: "ftp-host", address: "10.0.0.9", port: 21,
          username: "ftp", protocol: "ftp", jumpChainId: null, status: "connected",
          restored: true, rustId: "ftp-1", attempt: 0, lastError: null, nextRetryAt: null,
          paneOf: null, encodingOverride: "utf-8", encoding: "utf-8", encodingHint: null,
          isProduction: false,
        },
      ],
      activeId: "ftp-tab",
      trees: { "ftp-tab": { kind: "leaf", id: "ftp-tab" } },
      activePane: { "ftp-tab": "ftp-tab" },
    });
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
            <MainArea storeError={null} selected={null} onOpenAiSettings={() => {}} />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (hostsMode) {
    const { HostTree } = await import("./../hosts/HostTree");
    const { useVaultStore } = await import("./../vault/store");
    useVaultStore.setState({
      hosts: [
        { id: 1, name: "web-01", group_id: 9, tags: [], address: "10.0.0.1", port: 22, username: "root",
          protocol: "ssh", credential_id: null, jump_chain_id: null, encoding_override: null,
          theme_override: null, monitor_enabled: false, is_production: false, notes: null,
          created_at: 1, updated_at: 1 },
        { id: 2, name: "db-01", group_id: null, tags: [], address: "10.0.0.2", port: 22, username: "root",
          protocol: "ssh", credential_id: null, jump_chain_id: null, encoding_override: null,
          theme_override: null, monitor_enabled: false, is_production: false, notes: null,
          created_at: 1, updated_at: 1 },
      ],
      hostGroups: [{ id: 9, name: "Servers", parent_id: null, color: null, created_at: 1, updated_at: 1 }],
      loading: false,
      error: null,
    });
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div style={{ padding: 20, width: 320 }}>
            <HostTree
              selectedId={null}
              onSelect={() => {}}
              onOpen={() => {}}
              onEdit={() => {}}
              onAdd={() => {}}
            />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
  if (recMode) {
    const { RecordingPanel } = await import("./../history/RecordingPanel");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ThemeProvider>
          <div style={{ padding: 20, height: "100vh" }}>
            <RecordingPanel hostId={null} hosts={[{ id: 1, name: "web-01" } as never]} query="" />
          </div>
        </ThemeProvider>
      </React.StrictMode>,
    );
    return;
  }
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
          <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
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
