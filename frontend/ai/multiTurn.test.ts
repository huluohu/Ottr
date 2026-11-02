// AI 多轮追问会话测试（2026-11-02 批次二 C 项）。
//
// 钉住四件事：
// 1. 首轮：装配诊断上下文（命令 + 输出尾 + 主机备注）并发出；
// 2. 追问轮：**只带对话历史 + 本次追问**——不重取输出尾、不重注入主机备注
//    （省 token、不重复出网）；
// 3. 对话历史**脱敏后存储**（追加进历史时 redact 一次）；
// 4. 模型回答落进历史（assistant 轮），形成可继续追问的上下文。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const chatFactory = vi.fn();
type MockProviderLike = {
  requests: { system?: string; messages: { content: string }[]; maxTokens: number }[];
};
const createdProviders: MockProviderLike[] = [];
vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: (meta: unknown, apiKey: string) => {
      chatFactory(meta, apiKey);
      const p = orig.createMockProvider(["**原因**\n\n磁盘满了。"]);
      createdProviders.push(p);
      return p;
    },
  };
});

import i18n from "../i18n";
import { useAiStore, type DiagnoseRequest } from "./aiStore";
import { setNotifyPorts, resetRateLimiter } from "../notify/core";

const mockedInvoke = invoke as unknown as Mock;

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 7,
  hostName: "web-01",
  exitCode: 1,
  command: "check disk usage",
};

function mockBackend(over: { hostNotes?: string | null; tail?: string } = {}) {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") {
          return Promise.resolve([
            {
              id: "p1",
              name: "DeepSeek",
              kind: "openai-compatible",
              baseURL: "https://api.deepseek.com",
              model: "deepseek-chat",
            },
          ]);
        }
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") {
          return Promise.resolve({ hostname: true, custom: [] });
        }
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "session_tail":
        return Promise.resolve(over.tail ?? "boom on 10.1.2.3\n");
      case "hosts_get":
        return Promise.resolve(
          over.hostNotes == null ? null : { id: 7, name: "web-01", notes: over.hostNotes },
        );
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  mockedInvoke.mockReset();
  chatFactory.mockClear();
  createdProviders.length = 0;
  useAiStore.setState({ sessions: {} });
  resetRateLimiter();
  setNotifyPorts({
    now: () => 0,
    focused: () => false,
    system: async () => {},
  });
});

describe("AI 多轮追问会话", () => {
  it("首轮：发出装配好的诊断上下文（命令 + 输出尾 + 主机备注）", async () => {
    mockBackend({ hostNotes: "Ubuntu 24.04 systemd，日志在 /var/log/syslog" });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).toContain("check disk usage");
    // 输出尾里的内网 IP 已脱敏（出网前 redact）
    expect(body).toContain("boom on [REDACTED_IPV4_1]");
    expect(body).not.toContain("10.1.2.3");
    expect(body).toContain("Ubuntu 24.04 systemd");
  });

  it("首轮后历史含 user 轮 + assistant 轮", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const messages = useAiStore.getState().sessions["tab-1"]!.messages;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("磁盘满了");
  });

  it("追问轮：只带对话历史 + 本次追问，不重取输出尾、不重注入主机备注", async () => {
    mockBackend({ hostNotes: "Ubuntu 24.04 systemd" });
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const tailCallsBefore = mockedInvoke.mock.calls.filter(([c]) => c === "session_tail").length;
    const hostsCallsBefore = mockedInvoke.mock.calls.filter(([c]) => c === "hosts_get").length;

    await useAiStore.getState().run("tab-1", "不对，请用 truncate 重试");
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    // 追问轮**不再**取输出尾 / 主机备注
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "session_tail").length).toBe(
      tailCallsBefore,
    );
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "hosts_get").length).toBe(
      hostsCallsBefore,
    );

    // 请求体 = 历史（首轮 user + 首轮 assistant）+ 本次追问
    const messages = createdProviders[1].requests[0].messages;
    expect(messages.length).toBe(3);
    expect(messages[0].content).toContain("check disk usage");
    expect(messages[1].content).toContain("磁盘满了");
    expect(messages[2].content).toBe("不对，请用 truncate 重试");
  });

  it("对话历史脱敏后存储（敏感值不留在 store 里）", async () => {
    mockBackend({ tail: "连接 10.1.2.3 失败" });
    useAiStore.getState().onCommandFailed({
      ...REQ,
      command: "curl http://10.9.8.7/x",
    });
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    const messages = useAiStore.getState().sessions["tab-1"]!.messages;
    const dump = JSON.stringify(messages);
    expect(dump).not.toContain("10.1.2.3");
    expect(dump).not.toContain("10.9.8.7");
    expect(dump).toContain("[REDACTED_");
  });

  it("追问内容本身也脱敏后入历史", async () => {
    mockBackend();
    useAiStore.getState().onCommandFailed(REQ);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    await useAiStore.getState().run("tab-1", "再试一次 10.55.66.77");
    await vi.waitFor(() => {
      const msgs = useAiStore.getState().sessions["tab-1"]!.messages;
      expect(msgs.some((m) => m.content.includes("10.55.66.77"))).toBe(false);
    });
  });
});
