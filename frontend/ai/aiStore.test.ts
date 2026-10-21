// 诊断链路测试（T13 Step 4；2026-10-19 方案 A 会话作用域更新）：exit_code≠0 →
// 面板开（只写所属会话切片）→ tail 取数 → 脱敏 → provider 流式 → 通知落库
// （notify kind="ai"）。provider 层 mock（MockProvider 记录请求），invoke 全量
// mock（真后端命令已在 desktop 接线）。
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
  shouldAutoDiagnose,
  useAiStore,
  type DiagnoseRequest,
  type SessionAiState,
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

function mockBackend(over: { secret?: string | null; enabled?: unknown; sessionTail?: string } = {}) {
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
        return Promise.resolve(
          over.sessionTail === undefined
            ? "mkdir: cannot create directory '/data': No space left on device\nIP 10.1.2.3\n"
            : over.sessionTail,
        );
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

/** 会话切片读取（方案 A：一切状态在 sessions[id] 下）。 */
function aiState(id = REQ.sessionId): SessionAiState | undefined {
  return useAiStore.getState().sessions[id];
}

/** 直塞一个切片（abort 徽标等纯状态测试的种子面）。 */
function seedSlice(id: string, over: Partial<SessionAiState>): void {
  useAiStore.setState((st) => ({
    sessions: {
      ...st.sessions,
      [id]: {
        request: null,
        status: "idle",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
        settingsUsed: null,
        seen: false,
        ...over,
      },
    },
  }));
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  chatFactory.mockClear();
  createdProviders.length = 0;
  useAiStore.setState({ sessions: {} });
  resetRateLimiter();
  setNotifyPorts({ now: () => 1_000, focused: () => true, system: async () => {} });
  await i18n.changeLanguage("zh-CN"); // 断言面向 zh 词典键
});

describe("诊断链路（onCommandFailed → run）", () => {
  it("全链：面板开 → tail(8KB) → 脱敏 → 流式 answer → done → notify 落库", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("done");
    });
    const st = aiState()!;
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
      expect(aiState()?.status).toBe("done");
    });
    const provider = createdProviders[0];
    expect(provider.requests[0].system).toContain("运维");
    expect(provider.requests[0].maxTokens).toBe(1024);
  });

  it("ai.enabled=false：失败事件静默丢弃（面板不开）", async () => {
    mockBackend({ enabled: false });
    useAiStore.getState().onCommandFailed(REQ);
    await new Promise((r) => setTimeout(r, 20));
    expect(aiState()).toBeUndefined();
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
      expect(aiState()?.status).toBe("error");
    });
    expect(aiState()?.errorKind).toBe("noProvider");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  // provider 启用/禁用（2026-10-16）：诊断链取首个未禁用的，全禁用 = 无可用。
  it("首个 provider 禁用、第二个可用 → 实际用第二个（列表序 = 默认优先序）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") {
        return Promise.resolve([
          { ...PROVIDERS[0], enabled: false },
          { ...PROVIDERS[0], id: "p2", name: "Ollama", model: "qwen2.5:7b" },
        ]);
      }
      if (cmd === "settings_get" && args?.key === "redaction") {
        return Promise.resolve({ hostname: true, custom: [] });
      }
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "secret_get") return Promise.resolve("sk-test");
      if (cmd === "session_tail") return Promise.resolve("ok\n");
      if (cmd === "notify_insert") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("done");
    });
    expect(chatFactory.mock.calls[0][0]).toMatchObject({ id: "p2", model: "qwen2.5:7b" });
  });

  it("全部 provider 禁用 → error/noProvider（不出网）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") {
        return Promise.resolve([{ ...PROVIDERS[0], enabled: false }]);
      }
      if (cmd === "settings_get") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("error");
    });
    expect(aiState()?.errorKind).toBe("noProvider");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("免 key Ollama 全链：secrets 无存值 → 空 key 照常出结果（fix 1/5 I-1）", async () => {
    // openai-compatible 显式允许免 key（Ollama 本地）；此前 stored===null→noKey
    // 是自相矛盾面，修正为空串透传（不发 Authorization 的裁决在 provider 层）
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") {
        return Promise.resolve([
          {
            id: "local",
            name: "Ollama",
            kind: "openai-compatible",
            baseURL: "http://localhost:11434/v1",
            model: "qwen2.5:7b",
          },
        ]);
      }
      if (cmd === "settings_get" && args?.key === "redaction") {
        return Promise.resolve({ hostname: true, custom: [] });
      }
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "secret_get") return Promise.resolve(null);
      if (cmd === "session_tail") return Promise.resolve("ok\n");
      if (cmd === "notify_insert") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("done");
    });
    const st = aiState()!;
    expect(st.errorKind).toBeNull();
    expect(st.answer).toContain("原因是磁盘已满。");
    expect(chatFactory.mock.calls[0][1]).toBe("");
  });

  it("secrets 读取故障（非未存值）→ error/noKey", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "secret_get") return Promise.reject(new Error("vault is locked"));
      return Promise.resolve(null);
    });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("error");
    });
    expect(aiState()?.errorKind).toBe("noKey");
    expect(aiState()?.error).toContain("vault is locked");
  });

  // 2026-10-21 AI 层第二道防线（用户裁定「收到空内容也没必要触发诊断」）：
  // 命令与输出尾都为空 = 无从诊断——面板切片摘除、请求不出网（watch 层已有
  // 首道门卫，这里兜其余路径）。
  it("空内容不诊断：命令空 + tail 空 → 切片摘除、provider 不调用", async () => {
    mockBackend({ sessionTail: "" });
    useAiStore.getState().onCommandFailed({ ...REQ, command: "" });
    await vi.waitFor(() => {
      expect(aiState()).toBeUndefined();
    });
    expect(chatFactory).not.toHaveBeenCalled();
    const notifyCall = mockedInvoke.mock.calls.find(([c]) => c === "notify_insert");
    expect(notifyCall).toBeUndefined();
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
      expect(aiState()?.status).toBe("done");
    });
    const provider = createdProviders[0];
    expect(provider.requests[0].messages[0].content).toContain("mkdir");
  });

  it("abort：在途中止 → aborted 态（非 error）", () => {
    seedSlice(REQ.sessionId, { request: REQ, status: "running" });
    useAiStore.getState().abort(REQ.sessionId);
    expect(aiState()?.status).toBe("aborted");
    // 面板保留（close 才摘切片）
    expect(aiState()?.request).not.toBeNull();
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
      expect(aiState()?.status).toBe("done");
    });
    expect(mockedInvoke.mock.calls.some(([c]) => c === "session_tail")).toBe(false);
    const provider = createdProviders[0];
    expect(provider.requests[0].system).toContain("终端");
    expect(provider.requests[0].messages[0].content).toContain("[REDACTED_IPV4_1]");
    const notifyCall = mockedInvoke.mock.calls.find(([c]) => c === "notify_insert");
    expect(notifyCall?.[1].input.title_key).toBe("notify.title.aiExplain");
  });
});

describe("方案 A 会话作用域（2026-10-19）", () => {
  it("后台会话失败只写自己的切片，不碰他会在看的面板", async () => {
    mockBackend();
    // A 会话（tab-1）已有完成的面板
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("done");
    });
    const aBefore = { ...aiState()! };
    // B 会话（tab-2）失败
    useAiStore.getState().onCommandFailed({
      ...REQ,
      sessionId: "tab-2",
      rustId: "pty-10",
      hostName: "db-01",
      command: "systemctl restart db",
    });
    await vi.waitFor(() => {
      expect(aiState("tab-2")?.status).toBe("done");
    });
    // A 的面板分毫不动（旧全局单槽会被 B 取代）
    const aAfter = aiState("tab-1")!;
    expect(aAfter).toEqual(aBefore);
    expect(aAfter.request?.hostName).toBe("web-01");
    expect(aiState("tab-2")!.request?.hostName).toBe("db-01");
  });

  it("待看徽标口径：失败 → seen=false，markSeen → true，close → 切片摘除", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(aiState()?.status).toBe("done");
    });
    expect(aiState()?.seen).toBe(false);
    useAiStore.getState().markSeen(REQ.sessionId);
    expect(aiState()?.seen).toBe(true);
    // close 后切片不存在（页签徽标随之消失）
    useAiStore.getState().close(REQ.sessionId);
    expect(aiState()).toBeUndefined();
  });

  it("markSeen 无面板时是 no-op（不产生幽灵切片）", () => {
    useAiStore.getState().markSeen("ghost-tab");
    expect(useAiStore.getState().sessions["ghost-tab"]).toBeUndefined();
  });

  it("close 单会话不影响他会话切片", () => {
    seedSlice("tab-1", { request: REQ });
    seedSlice("tab-2", { request: { ...REQ, sessionId: "tab-2" } });
    useAiStore.getState().close("tab-1");
    expect(aiState("tab-1")).toBeUndefined();
    expect(aiState("tab-2")).toBeDefined();
  });

  it("dropSession = close 语义（会话收尾钩子消费面）", () => {
    seedSlice("tab-1", { request: REQ, status: "running" });
    useAiStore.getState().dropSession("tab-1");
    expect(aiState("tab-1")).toBeUndefined();
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
  it("shouldAutoDiagnose：Ctrl+C（130）不触发，其余失败照常", () => {
    // 2026-10-19 用户反馈：Ctrl+C 是主动取消不是失败
    expect(shouldAutoDiagnose(130)).toBe(false);
    expect(shouldAutoDiagnose(127)).toBe(true);
    expect(shouldAutoDiagnose(1)).toBe(true);
    expect(shouldAutoDiagnose(143)).toBe(true);
  });
});
