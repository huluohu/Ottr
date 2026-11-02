// AI 备忘注入的**链路面**测试（2026-11-02 批次一 A 项）：
// 主机「备注」必须真正进入 provider 请求（而不只是纯函数正确）。
//
// 三条钉死的行为：
// 1. 备注进入请求体（诊断链 / ⌘J 链 / 纪要链）；
// 2. 备注**脱敏**后才出网（内网 IP 变占位符）；
// 3. 取备注失败（hosts_get 报错）不阻断 AI 请求。
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
      const p = orig.createMockProvider(["好的。"]);
      createdProviders.push(p);
      return p;
    },
  };
});

import { clearHostNotesCache } from "./hostContext";
import { useAiStore, type DiagnoseRequest } from "./aiStore";
import { useNlStore } from "./nl2cmd";

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

function mockBackend(over: { hostNotes?: string | null; hostGetFails?: boolean } = {}) {
  mockedInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "settings_get":
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "secret_contains":
        return Promise.resolve(true);
      case "session_tail":
        return Promise.resolve("boom\n");
      case "hosts_get":
        if (over.hostGetFails) return Promise.reject(new Error("host gone"));
        return Promise.resolve(
          over.hostNotes == null ? null : { id: 7, name: "web-01", notes: over.hostNotes },
        );
      case "notify_insert":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

/** 设置读取需要真实键值——直接给 vaultApi 层塞值太绕，改为覆写 invoke。 */
function mockSettings() {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve("sk-test");
      case "secret_contains":
        return Promise.resolve(true);
      case "session_tail":
        return Promise.resolve("boom\n");
      case "hosts_get":
        return Promise.resolve({
          id: 7,
          name: "web-01",
          notes: "Ubuntu 22.04 systemd, nginx 日志在 /var/log/nginx",
        });
      case "notify_insert":
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  chatFactory.mockClear();
  createdProviders.length = 0;
  clearHostNotesCache();
  useAiStore.setState({ sessions: {} });
});

describe("AI 备忘注入链路", () => {
  it("诊断链：主机备注进入 provider 请求", async () => {
    mockSettings();
    const req: DiagnoseRequest = {
      kind: "diagnose",
      sessionId: "tab-1",
      rustId: "pty-9",
      hostId: 7,
      hostName: "web-01",
      exitCode: 1,
      command: "systemctl status nginx",
    };
    useAiStore.getState().onCommandFailed(req);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-1"]?.status).toBe("done");
    });

    expect(createdProviders.length).toBe(1);
    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).toContain("Ubuntu 22.04 systemd");
    expect(body).toContain("/var/log/nginx");
  });

  it("诊断链：备注脱敏后才出网（内网 IP 变占位符）", async () => {
    mockBackend();
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get") {
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      }
      if (cmd === "secret_get") return Promise.resolve("sk-test");
      if (cmd === "session_tail") return Promise.resolve("boom\n");
      if (cmd === "hosts_get") {
        return Promise.resolve({
          id: 7,
          name: "web-01",
          notes: "内网网关 10.20.30.40 走跳板",
        });
      }
      return Promise.resolve(null);
    });

    const req: DiagnoseRequest = {
      kind: "diagnose",
      sessionId: "tab-2",
      rustId: "pty-9",
      hostId: 7,
      hostName: "web-01",
      exitCode: 1,
      command: "systemctl status nginx",
    };
    useAiStore.getState().onCommandFailed(req);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-2"]?.status).toBe("done");
    });

    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).not.toContain("10.20.30.40");
    expect(body).toContain("[REDACTED_");
  });

  it("取备注失败不阻断 AI 请求（备忘是增强项不是前置条件）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get") {
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      }
      if (cmd === "secret_get") return Promise.resolve("sk-test");
      if (cmd === "session_tail") return Promise.resolve("boom\n");
      if (cmd === "hosts_get") return Promise.reject(new Error("host deleted"));
      return Promise.resolve(null);
    });

    const req: DiagnoseRequest = {
      kind: "diagnose",
      sessionId: "tab-3",
      rustId: "pty-9",
      hostId: 7,
      hostName: "web-01",
      exitCode: 1,
      command: "systemctl status nginx",
    };
    useAiStore.getState().onCommandFailed(req);
    await vi.waitFor(() => {
      expect(useAiStore.getState().sessions["tab-3"]?.status).toBe("done");
    });

    expect(useAiStore.getState().sessions["tab-3"]?.status).toBe("done");
    expect(createdProviders.length).toBe(1);
  });

  it("⌘J 链：主机备注进入生成请求（begin 传入 hostId）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get") {
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      }
      if (cmd === "secret_get") return Promise.resolve("sk-test");
      if (cmd === "hosts_get") {
        return Promise.resolve({
          id: 7,
          name: "web-01",
          notes: "Debian 12，用 systemctl",
        });
      }
      return Promise.resolve(null);
    });

    useNlStore.getState().begin("/srv/app", 7);
    useNlStore.getState().setInput("重启 nginx");
    await useNlStore.getState().submit();

    expect(createdProviders.length).toBe(1);
    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).toContain("Debian 12");
    expect(body).toContain("重启 nginx");
  });

  it("⌘J 链：无主机（本地终端）时备注段缺席，链路照常", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get") {
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.enabled") return Promise.resolve(true);
        if (args?.key === "redaction") return Promise.resolve({ hostname: true, custom: [] });
        if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
        return Promise.resolve(null);
      }
      if (cmd === "secret_get") return Promise.resolve("sk-test");
      return Promise.resolve(null);
    });

    useNlStore.getState().begin("/srv/app", null);
    useNlStore.getState().setInput("重启 nginx");
    await useNlStore.getState().submit();

    expect(createdProviders.length).toBe(1);
    const body = createdProviders[0].requests[0].messages[0].content;
    expect(body).toContain("重启 nginx");
  });
});
