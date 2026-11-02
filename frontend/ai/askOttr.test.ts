// Ask Ottr（批次四 P0「Ask Ottr 上下文入口」）测试。
//
// 钉住：
// 1. 打开 Ask Ottr → 面板进入「提问」态（请求 kind=ask，输入条可提问）；
// 2. **首轮带上下文**（输出尾 + 主机备注）——「刚发生了什么」是提问的语境；
// 3. 提问后进入多轮追问（与诊断面板同一状态机）；
// 4. 追问轮**不重取**输出尾/主机备注（省 token、不重复出网）。
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
      const p = orig.createMockProvider(["**答**：内存还剩 2G。"]);
      createdProviders.push(p);
      return p;
    },
  };
});

import i18n from "../i18n";
import { useAiStore } from "./aiStore";
import { setNotifyPorts, resetRateLimiter } from "../notify/core";

const mockedInvoke = invoke as unknown as Mock;

function mockBackend() {
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
        return Promise.resolve("Mem:  total 7.7Gi used 5.5Gi\n");
      case "hosts_get":
        return Promise.resolve({
          id: 7,
          name: "web-01",
          notes: "Ubuntu 24.04 systemd，日志在 /var/log/syslog",
        });
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
  mockBackend();
  useAiStore.setState({ sessions: {} });
  resetRateLimiter();
  setNotifyPorts({
    now: () => 0,
    focused: () => false,
    system: async () => {},
  });
});

describe("Ask Ottr（批次四 P0）", () => {
  it("openAsk → 面板进入提问态（kind=ask，无回答）", () => {
    useAiStore.getState().openAsk({
      kind: "ask",
      sessionId: "tab-1",
      rustId: "pty-1",
      hostId: 7,
      hostName: "web-01",
    });
    const st = useAiStore.getState().sessions["tab-1"]!;
    expect(st.request?.kind).toBe("ask");
    expect(st.status).toBe("idle");
    expect(st.messages).toHaveLength(0);
  });

  it("首轮提问 → 带输出尾 + 主机备注作上下文（问题在前）", async () => {
    useAiStore.getState().openAsk({
      kind: "ask",
      sessionId: "tab-1",
      rustId: "pty-1",
      hostId: 7,
      hostName: "web-01",
    });
    await useAiStore.getState().run("tab-1", "这台机器还剩多少内存？");
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });
    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).toContain("这台机器还剩多少内存？");
    expect(body).toContain("Mem:  total 7.7Gi"); // 输出尾
    expect(body).toContain("Ubuntu 24.04 systemd"); // 主机备注
    // 提问语境里**没有**「退出码 / 命令」那段诊断块
    expect(body).not.toContain("Exit code");
  });

  it("提问后可继续追问（第二轮只带历史 + 追问）", async () => {
    useAiStore.getState().openAsk({
      kind: "ask",
      sessionId: "tab-1",
      rustId: "pty-1",
      hostId: 7,
      hostName: "web-01",
    });
    await useAiStore.getState().run("tab-1", "还剩多少内存？");
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });
    await useAiStore.getState().run("tab-1", "那磁盘呢？");
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });
    const second = createdProviders[1].requests[0].messages;
    // 历史（首轮 user + assistant）+ 本次追问
    expect(second.length).toBe(3);
    expect(second[0].content).toContain("还剩多少内存？");
    expect(second[1].content).toContain("内存还剩 2G");
    expect(second[2].content).toBe("那磁盘呢？");
  });
});
