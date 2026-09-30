// 诊断链路测试（T13 Step 4）：exit_code≠0 → 面板开 → tail 取数 → 脱敏 →
// provider 流式 → 通知落库（notify kind="ai"）。provider 层 mock（MockProvider
// 记录请求），invoke 全量 mock（真后端命令已在 src-tauri 接线）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const chatFactory = vi.fn();
/** 工厂产出的 provider 实例（chatFactory 裸 vi.fn 返回 undefined，实例单独收集）。 */
type MockProviderLike = { requests: { system?: string; messages: { content: string }[]; maxTokens: number }[] };
const createdProviders: MockProviderLike[] = [];
vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: (meta: unknown, apiKey: string) => {
      chatFactory(meta, apiKey);
      const p = orig.createMockProvider(["原因是磁盘已满。", "```bash\ndf -h /data\n```"]);
      createdProviders.push(p);
      return p;
    },
  };
});

import i18n from "../i18n";
import {
  buildUserMessage,
  commandExcerpt,
  useAiStore,
  type DiagnoseRequest,
} from "./aiStore";
import { setNotifyPorts } from "../notify/core";
import { resetRateLimiter } from "../notify/core";

const mockedInvoke = invoke as unknown as Mock;

const PROVIDERS = [
  {
    id: "p1",
    name: "DeepSeek",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
];

function mockBackend(over: { secret?: string | null; enabled?: unknown } = {}) {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(over.enabled ?? true);
        if (args?.key === "redaction")
          return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve(over.secret === undefined ? "sk-test" : over.secret);
      case "secret_contains":
        return Promise.resolve(true);
      case "session_tail":
        return Promise.resolve("mkdir: cannot create directory '/data': No space left on device\nIP 10.1.2.3\n");
      case "notify_insert":
        return Promise.resolve({
          id: 1,
          kind: "ai",
          severity: "success",
          host_id: 7,
          title_key: "notify.title.aiDone",
          body: "",
          payload: null,
          read: false,
          ts: 0,
        });
      default:
        return Promise.resolve(null);
    }
  });
}

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 7,
  hostName: "web-01",
  exitCode: 1,
  command: "mkdir -p /data && password=hunter2 10.1.2.3",
};

beforeEach(async () => {
  mockedInvoke.mockReset();
  chatFactory.mockClear();
  createdProviders.length = 0;
  useAiStore.getState().close();
  resetRateLimiter();
  setNotifyPorts({ now: () => 1_000, focused: () => true, system: async () => {} });
  await i18n.changeLanguage("zh-CN"); // 断言面向 zh 词典键
});

describe("诊断链路（onCommandFailed → run）", () => {
  it("全链：面板开 → tail(8KB) → 脱敏 → 流式 answer → done → notify 落库", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("done");
    });
    const st = useAiStore.getState();
    expect(st.request?.kind).toBe("diagnose");
    expect(st.answer).toContain("原因是磁盘已满。");
    expect(st.answer).toContain("df -h /data");
    // provider 收到明文 key；面板 meta 是 settings 快照
    expect(chatFactory).toHaveBeenCalledTimes(1);
    expect(chatFactory.mock.calls[0][1]).toBe("sk-test");
    expect(st.settingsUsed?.providers[0].name).toBe("DeepSeek");
    // tail 取数面：rustId + 8KB
    const tailCall = mockedInvoke.mock.calls.find(([c]) => c === "session_tail");
    expect(tailCall?.[1]).toMatchObject({ id: "pty-9", bytes: 8192 });
    // 脱敏：命令里的密码与 IP、输出里的 IP 都进了占位符（请求体在 MockProvider.requests）
    const provider = createdProviders[0];
    const sent = provider.requests[0];
    expect(JSON.stringify(sent.messages)).not.toContain("hunter2");
    expect(JSON.stringify(sent.messages)).not.toContain("10.1.2.3");
    expect(st.redactions.length).toBeGreaterThan(0);
    // 通知落库（kind=ai）
    const notifyCall = mockedInvoke.mock.calls.find(([c]) => c === "notify_insert");
    expect(notifyCall?.[1].input).toMatchObject({ kind: "ai", severity: "success", host_id: 7 });
  });

  it("system 提示词进请求（诊断模板）", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("done");
    });
    const provider = createdProviders[0];
    expect(provider.requests[0].system).toContain("运维");
    expect(provider.requests[0].maxTokens).toBe(1024);
  });

  it("ai.enabled=false：失败事件静默丢弃（面板不开）", async () => {
    mockBackend({ enabled: false });
    useAiStore.getState().onCommandFailed(REQ);
    await new Promise((r) => setTimeout(r, 20));
    expect(useAiStore.getState().request).toBeNull();
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("未配置 provider → error/noProvider（不触发请求）", async () => {
    mockBackend();
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve([]);
      if (cmd === "settings_get") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("error");
    });
    expect(useAiStore.getState().errorKind).toBe("noProvider");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("key 未保存 → error/noKey", async () => {
    mockBackend({ secret: null });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("error");
    });
    expect(useAiStore.getState().errorKind).toBe("noKey");
  });

  it("session_tail 失败（会话已关）：空输出照发诊断", async () => {
    mockBackend();
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "session_tail") return Promise.reject(new Error("no such session"));
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "secret_get") return Promise.resolve("sk");
      if (cmd === "notify_insert") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("done");
    });
    const provider = createdProviders[0];
    expect(provider.requests[0].messages[0].content).toContain("mkdir");
  });

  it("abort：在途中止 → aborted 态（非 error）", async () => {
    mockBackend();
    useAiStore.setState({ status: "running" });
    useAiStore.getState().abort();
    expect(useAiStore.getState().status).toBe("aborted");
  });
});

describe("openExplain（右键解释）", () => {
  it("单轮解释链（无 tail 取数）", async () => {
    mockBackend();
    useAiStore.getState().openExplain({
      kind: "explain",
      sessionId: "tab-1",
      hostId: 7,
      hostName: "web-01",
      text: "E5: spdif underline error 10.1.2.3",
    });
    await vi.waitFor(() => {
      expect(useAiStore.getState().status).toBe("done");
    });
    expect(mockedInvoke.mock.calls.some(([c]) => c === "session_tail")).toBe(false);
    const provider = createdProviders[0];
    expect(provider.requests[0].system).toContain("终端");
    expect(provider.requests[0].messages[0].content).toContain("[REDACTED_IPV4_1]");
    const notifyCall = mockedInvoke.mock.calls.find(([c]) => c === "notify_insert");
    expect(notifyCall?.[1].input.title_key).toBe("notify.title.aiExplain");
  });
});

describe("纯函数", () => {
  it("buildUserMessage：诊断带退出码/命令/输出三段", () => {
    const msg = buildUserMessage(REQ, "mkdir -p /data", "no space");
    expect(msg).toContain("退出码: 1");
    expect(msg).toContain("mkdir -p /data");
    expect(msg).toContain("no space");
  });
  it("commandExcerpt：首行 + 80 字符截断", () => {
    expect(commandExcerpt("a\nb")).toBe("a");
    expect(commandExcerpt("x".repeat(100))).toHaveLength(81);
  });
});
