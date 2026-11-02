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
// 断线耗尽态目检（2026-10-29 用户需求：终端内回车继续重连）：?reconnect=exhausted
// —— 种子一条「自动重连已耗尽」的会话（disconnected + attempt=5），终端可聚焦；
// 按回车应重走退避链（attempt 归零 → 第 1/5 次起步）。window.__session__ 暴露
// 会话状态给浏览器断言面。
const reconnectMode = new URLSearchParams(location.search).get("reconnect");
// README 配图模式（2026-11-01 用户需求「每种语言的 README 配图都要切换到对应
// 语言后拍摄」）：README 有六种语言，配图此前六份共用同一批简中界面截图。
// ?shot=<name> 决定画面（home/terminal/palette/cron/overview/credentials），
// ?lang=<locale> 决定界面语言（en-US/zh-CN/ja/ko/es/it）。出图脚本：
// scripts/capture-screenshots.mjs（Playwright 无头 Chromium，不碰真机桌面）。
const shotMode = new URLSearchParams(location.search).get("shot");
const shotLang = new URLSearchParams(location.search).get("lang");
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
// eslint-disable-next-line @typescript/no-explicit-any
(window as any).__TAURI_CHANNEL_STUB__ = MockChannel;
// 事件插件内部件：@tauri-apps/api 的 listen/unlisten 会调它的
// registerListener/unregisterListener——缺了会在 unlisten 时抛
//「Cannot read properties of undefined (reading 'unregisterListener')」。
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  registerListener: () => {},
  unregisterListener: () => {},
};

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

// 断线耗尽态覆盖（?reconnect=exhausted）：把上面那条「已连接」会话换成
// 「自动重连 5 次未成功」的终态（restored=false = 曾连上后掉线的活会话）。
if (reconnectMode === "exhausted") {
  useSessionStore.setState({
    sessions: [
      {
        id: "preview-tab",
        hostId: 1,
        hostName: "preview-host",
        rustId: null,
        paneOf: null,
        status: "disconnected",
        attempt: 5,
        nextRetryAt: null,
        lastError: "ssh protocol error: Disconnected",
        restored: false,
        encoding: "utf-8",
        isProduction: false,
        protocol: "ssh",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__session__ = () =>
    useSessionStore.getState().sessions.map((s) => ({
      id: s.id,
      status: s.status,
      attempt: s.attempt,
      nextRetryAt: s.nextRetryAt,
    }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__reconnectNow__ = (id: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useSessionStore.getState() as any).reconnectNow(id);
}

// PTY 数据面在浏览器里不存在（attach 未真跑），终端画布为空属预期——本页
// 只验证布局/可见性。定期以假输出喂画布让终端区非空（视觉参照）。
// 配图模式例外：终端配图由 renderShot 写入定稿会话文本，不能再叠加假行。
if (!shotMode) {
  setInterval(() => {
    const sinkWrite = (window as unknown as { __previewFeed__?: (s: string) => void })
      .__previewFeed__;
    sinkWrite?.(`preview line ${new Date().toLocaleTimeString()}\r\n`);
  }, 3000);
}

/** README 配图用的一段真实感终端回显（仿 SSH 登录横幅 + 一次命令输出）。
 *  颜色用 ANSI 转义，与真机截图的终端配色一致（提示符绿、主机名青）。 */
const SHOT_TERMINAL_TRANSCRIPT = [
  "Linux 26ff194c6651 7.0.0-38-generic #38~24.04.4-Ubuntu SMP PREEMPT_DYNAMIC Mon Sep 14 16:37:11 UTC 2 x86_64",
  "",
  "The programs included with the Debian GNU/Linux system are free software;",
  "the exact distribution terms for each program are described in the",
  "individual files in /usr/share/doc/*/copyright.",
  "",
  "Debian GNU/Linux comes with ABSOLUTELY NO WARRANTY, to the extent",
  "permitted by applicable law.",
  "Last login: Sat Oct 31 08:08:46 2026 from 172.17.0.1",
  "\u001b[32mspike@26ff194c6651\u001b[0m:\u001b[34m~\u001b[0m$ echo '=== Ottr - AI-native SSH client ===' && uname -a && df -h / | tail -1 && free -m | head -2 && uptime && ls /etc | head -5",
  "=== Ottr - AI-native SSH client ===",
  "Linux 26ff194c6651 7.0.0-38-generic #38~24.04.4-Ubuntu SMP PREEMPT_DYNAMIC Mon Sep 14 16:37:11 UTC 2 x86_64 GNU/Linux",
  "overlay         48G   32G  12G  73%  /",
  "Mem:           15824  2049   1226  9249  24040",
  "              08:00:38 up 18 days, 19 min  0 user, load average: 0.32, 0.33, 0.29",
  "X11",
  "adviser.conf",
  "alternatives",
  "apt",
  "bash.bashrc",
  "\u001b[32mspike@26ff194c6651\u001b[0m:\u001b[34m~\u001b[0m$",
  "",
].join("\r\n");

/** README 配图渲染（?shot=<name>[&lang=<locale>]）：六张配图各自的画面状态。
 *  种子的是**界面状态**（主机/会话/面板/弹窗/数据面），不是像素；渲染仍是
 *  真实组件，样式与真机一致。 */
async function renderShot(): Promise<void> {
  const { IconRail } = await import("./../app/IconRail");
  const { Sidebar } = await import("./../app/Sidebar");
  const { useWorkspaceStore } = await import("./../workspace/workspaceStore");
  const { useSessionStore } = await import("./../session/SessionStore");
  const { useVaultStore } = await import("./../vault/store");
  const { sinks } = await import("./../session/terminal");
  const i18n = (await import("./../i18n")).default;

  // 界面语言（README 每语一套配图）：切语言 + 同步 <html lang>（字体栈依赖）。
  if (shotLang) {
    await i18n.changeLanguage(shotLang);
    document.documentElement.lang = shotLang;
  }
  // 主题：README 配图统一用「深河」暗色（此前真机配图即此主题）。真源是
  // vault settings，本页无后端 → 走 localStorage 启动缓存镜像（ThemeContext
  // 的 loadMode 先读它）。
  try {
    localStorage.setItem("ottr.settings.theme", "dark");
  } catch {
    // 隐私模式等：忽略（跟随系统浅色）
  }

  // 配图里的夹具主机（「fixture spike@127.0.0.1:2222」——端口 2222 即本地
  // SSH 夹具端点，空态欢迎页的「连接夹具」快捷卡按此端点识别）。
  const fixtureHost = {
    id: 1,
    name: "fixture",
    group_id: null,
    tags: [],
    address: "127.0.0.1",
    port: 2222,
    username: "spike",
    protocol: "ssh" as const,
    credential_id: 1,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    is_production: false,
    notes: null,
    created_at: 1,
    updated_at: 1,
  };
  useVaultStore.setState({
    hosts: [fixtureHost],
    hostGroups: [],
    // 凭据列表（凭据配图）：凭据面从 vault store 取，本页直接种子一条
    // 未命名密码凭据（与真机配图同款：显示「凭据 #1」+ 绑定主机数）。
    credentials: [
      {
        id: 1,
        kind: "password",
        name: null,
        key_pub: null,
        totp_digits: null,
        totp_period: null,
        created_at: 1,
        updated_at: 1,
      },
    ],
    loading: false,
    error: null,
  });

  // 面板数据面（定时任务 / 凭据）：真源是 Rust 命令，本页给同形种子。
  invokeTable["cj_list"] = [
    {
      id: 1,
      host_id: 1,
      schedule: "0 9 * * *",
      script: "df -h / && uptime",
      channels: [],
      enabled: true,
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 2,
      host_id: 1,
      schedule: "*/30 * * * *",
      script: "systemctl --failed",
      channels: [],
      enabled: true,
      created_at: 1,
      updated_at: 1,
    },
  ];
  invokeTable["cj_runs"] = [];
  invokeTable["cj_next_fire"] = Math.floor(Date.now() / 1000) + 3600;
  invokeTable["credentials_list"] = [
    { id: 1, kind: "password", name: null, key_pub: null, created_at: 1, updated_at: 1 },
  ];

  // 会话：仅终端配图需要（欢迎首页配图走零会话空态）。
  const withSession = shotMode === "terminal" || shotMode === "ai-panel";
  useSessionStore.setState({
    sessions: withSession
      ? [
          {
            id: "shot-tab",
            hostId: 1,
            hostName: "fixture",
            address: "127.0.0.1",
            port: 22,
            username: "spike",
            protocol: "ssh",
            rustId: "pty-shot",
            paneOf: null,
            status: "connected",
            attempt: 0,
            nextRetryAt: null,
            lastError: null,
            restored: true,
            encoding: "utf-8",
            isProduction: false,
          } as never,
        ]
      : [],
    activeId: withSession ? "shot-tab" : null,
    trees: withSession ? { "shot-tab": { kind: "leaf", id: "shot-tab" } } : {},
    activePane: withSession ? { "shot-tab": "shot-tab" } : {},
  });

  // 主区视图（定时任务 / 总览是主区视图态，不走弹窗）。
  if (shotMode === "cron") useWorkspaceStore.getState().openMainView("cron");
  if (shotMode === "overview") useWorkspaceStore.getState().openMainView("overview");

  // AI 诊断面板夹具（2026-11-02）：面板整高右栏后，「标题/退出码徽章是否被上方
  // 视图切换器工具行压住」这类布局回归需要能量测的稳定夹具——面板必须有
  // request 才渲染（DiagnosePanel 无请求返回 null），故此处种一条假请求。
  if (shotMode === "ai-panel") {
    const { useAiStore } = await import("./../ai/aiStore");
    useAiStore.setState({
      sessions: {
        "shot-tab": {
          request: {
            kind: "diagnose",
            sessionId: "shot-tab",
            rustId: "pty-shot",
            hostId: 1,
            hostName: "fixture",
            exitCode: 127,
            command: "check disk usage",
          },
          status: "done",
          answer: "**原因**\n\n`/var/log/syslog` 里的日志文件属主是 root。\n\n**修复命令**\n\n推荐用 truncate 清空而不是删除。",
          errorKind: null,
          error: null,
          redactions: [],
          settingsUsed: null,
          seen: true,
          usage: { inputTokens: 321, outputTokens: 87 },
          modelUsed: "ottr-verify-model",
          elapsedMs: 117,
          messages: [
            {
              role: "user",
              content: "check disk usage",
            },
            {
              role: "assistant",
              content: "**原因**\n\n磁盘已满。\n\n```bash\ndf -h /data\n```",
            },
            {
              role: "user",
              content: "不要删日志，先用 truncate 清空",
            },
            {
              role: "assistant",
              content:
                "**补充**\n\n先别删日志——用 `truncate -s 0` 清空比 `rm` 安全，还能留着 inode。\n\n" +
                "- 保留文件：`truncate -s 0 /var/log/app.log`\n" +
                "- 归档后清：`journalctl --rotate && journalctl --vacuum-time=7d`\n\n" +
                "```bash\njournalctl --disk-usage\n```\n",
            },
            {
              role: "user",
              content: "再确认一遍：还有别的清理手段吗？",
            },
            {
              role: "assistant",
              content:
                "**还有**\n\n1. 旧轮转日志：`find /var/log -name '*.gz' -mtime +30 -delete`\n" +
                "2. 缓存目录：清包管理器缓存\n" +
                "3. 孤儿 inode：重启持有它的进程\n\n" +
                "```bash\nlsof +L1\n```\n",
            },
          ],
        },
      },
    });
  }

  const { MainArea } = await import("./../workspace/MainArea");
  const { CommandPalette } = await import("./../palette/CommandPalette");
  const { CredentialsDialog } = await import("./../credentials/CredentialsDialog");
  const { TitleBar } = await import("./../titlebar/TitleBar");

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <div className="app-shell">
          {/* Win/Linux 自绘标题栏（App 同一组件）：README 配图对齐真机窗口壳。 */}
          <TitleBar
            plat="linux"
            onAction={() => {}}
            win={{
              minimize: () => {},
              toggleMaximize: () => {},
              close: () => {},
            }}
          />
          <div className="app-body">
            <IconRail
              titlebarInset={false}
              onOpenCredentials={() => {}}
              onOpenSettings={() => {}}
              onOpenMcpSettings={() => {}}
              onOpenHistory={() => {}}
            />
            <Sidebar
              style={{ width: 304 }}
              collapsed={false}
              onExpand={() => {}}
              titlebarInset={false}
              newGroupSignal={0}
              selectedId={null}
              onSelect={() => {}}
              onOpen={() => {}}
              onEdit={() => {}}
              onAdd={() => {}}
              onQuickConnect={() => {}}
              onNewGroup={() => {}}
            />
            <MainArea
              storeError={null}
              selected={shotMode === "home" ? null : fixtureHost}
              onOpenAiSettings={() => {}}
            />
          </div>
        </div>
        {shotMode === "palette" && (
          <CommandPalette
            open
            onClose={() => {}}
            hosts={[fixtureHost] as never}
            onConnect={() => {}}
            onAction={() => {}}
            plat="linux"
          />
        )}
        {shotMode === "credentials" && <CredentialsDialog onClose={() => {}} />}
      </ThemeProvider>
    </React.StrictMode>,
  );

  // 终端回显：等 SessionTerminal 挂载注册 sink 后写入（sink = 真实写入口）。
  if (shotMode === "terminal") {
    const enc = new TextEncoder();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const sink = sinks.get("shot-tab");
      if (sink) {
        sink.write(enc.encode(SHOT_TERMINAL_TRANSCRIPT));
        break;
      }
    }
  }

  // 就绪信号：出图脚本等它再截图（渲染 + 终端回显都落定后再拍）。
  (window as unknown as { __shotReady__?: boolean }).__shotReady__ = true;
}

async function render() {
  if (shotMode) {
    await renderShot();
    return;
  }
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
