// NL→命令链路测试（Phase 2 B1，Task 6）：
//   * buildNl2cmdPrompt / sanitizeNlCommand 纯函数（prompt 装配 + 端点差异兜底）；
//   * nlStore 运行链：Mock provider 断言请求体（system/stop/max_tokens）、
//     输入不过 redact、cwd 锚点、danger 分级、empty/noProvider/noKey/abort 面。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const chatFactory = vi.fn();
type MockProviderLike = {
  requests: { system?: string; messages: { content: string }[]; maxTokens: number; stop?: string[] }[];
};
const createdProviders: MockProviderLike[] = [];
/** Mock provider 的回放脚本（用例各自改写；factory 调用时读取）。 */
let script: string | string[] = ["docker ps"];
/** factory 抛错开关（request 错误面）。 */
let failProvider = false;
/** factory 直通替身（abort 竞态用：真定时器间隙的慢流，Mock 微任务链插不进）。 */
let providerOverride: MockProviderLike | null = null;

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: (meta: unknown, apiKey: string) => {
      chatFactory(meta, apiKey);
      if (failProvider) throw new Error("boom");
      if (providerOverride) {
        createdProviders.push(providerOverride);
        return providerOverride;
      }
      const p = orig.createMockProvider(script);
      createdProviders.push(p);
      return p;
    },
  };
});

import i18n from "../i18n";
import type { ChatRequest } from "./provider";
import {
  buildNl2cmdPrompt,
  sanitizeNlCommand,
  useNlStore,
} from "./nl2cmd";

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

function mockBackend(over: { secret?: string | null } = {}) {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    switch (cmd) {
      case "settings_get":
        if (args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
        if (args?.key === "ai.max_tokens") return Promise.resolve(777);
        return Promise.resolve(null);
      case "secret_get":
        return Promise.resolve(over.secret === undefined ? "sk-test" : over.secret);
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  chatFactory.mockClear();
  createdProviders.length = 0;
  script = ["docker ps"];
  failProvider = false;
  providerOverride = null;
  useNlStore.getState().close();
  await i18n.changeLanguage("zh-CN"); // 断言面向 zh 词典键
});

describe("buildNl2cmdPrompt（装配）", () => {
  it("system = i18n 模板；user = 输入原文；stop 钉单行", () => {
    const p = buildNl2cmdPrompt("找出最大的文件");
    expect(p.system).toContain("命令生成器");
    expect(p.system).toContain("一行");
    expect(p.user).toBe("找出最大的文件");
    expect(p.stop).toEqual(["\n"]);
  });

  it("cwd 有值才带目录锚点段；null 不提目录", () => {
    const withCwd = buildNl2cmdPrompt("解压 backup.tar.gz", { cwd: "/var/tmp" });
    expect(withCwd.user).toContain("当前目录: /var/tmp");
    expect(withCwd.user).toContain("解压 backup.tar.gz");
    const noCwd = buildNl2cmdPrompt("解压 backup.tar.gz", { cwd: null });
    expect(noCwd.user).toBe("解压 backup.tar.gz");
  });
});

describe("sanitizeNlCommand（端点差异兜底）", () => {
  it(" obedient：单行命令原样（trim）", () => {
    expect(sanitizeNlCommand("docker ps")).toBe("docker ps");
    expect(sanitizeNlCommand("  ls -la --color  ")).toBe("ls -la --color");
  });

  it("围栏包裹（stop 失效的端点）：取内层首行；未闭合围栏也取", () => {
    expect(sanitizeNlCommand("```bash\ndocker ps -a\n```")).toBe("docker ps -a");
    expect(sanitizeNlCommand("```sh\nls\n")).toBe("ls");
  });

  it("被 stop 截在围栏头：判不可用（内容永远没到，不把语言标签当命令）", () => {
    expect(sanitizeNlCommand("```bash")).toBe("");
    expect(sanitizeNlCommand("```")).toBe("");
  });

  it("整行反引号内联代码：取内层", () => {
    expect(sanitizeNlCommand("`df -h`")).toBe("df -h");
  });

  it("$ 提示符前缀剥离；# 刻意不剥（注释转命令是语义反转）", () => {
    expect(sanitizeNlCommand("$ df -h")).toBe("df -h");
    expect(sanitizeNlCommand("# df -h")).toBe("# df -h");
  });

  it("恒取首行 + 空串", () => {
    expect(sanitizeNlCommand("cmd1\ncmd2")).toBe("cmd1");
    expect(sanitizeNlCommand("")).toBe("");
    expect(sanitizeNlCommand("   ")).toBe("");
  });
});

describe("nlStore 运行链（Mock provider）", () => {
  it("全链：请求体带 system/stop/max_tokens；输入不过 redact（原样外发）", async () => {
    mockBackend();
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("remove the line password=hunter2 from config");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    const st = useNlStore.getState();
    expect(st.command).toBe("docker ps");
    expect(st.level).toBe("green");
    const sent = createdProviders[0].requests[0];
    expect(sent.system).toContain("命令生成器");
    expect(sent.stop).toEqual(["\n"]);
    expect(sent.maxTokens).toBe(777);
    // 输入原样进 user 消息（裁定：意图描述无既成敏感面，不脱敏）
    expect(sent.messages[0].content).toContain("password=hunter2");
    expect(st.settingsUsed?.providers[0].name).toBe("DeepSeek");
    // 无 tail 取数、无通知（轻量输入条，与诊断面板的差异面）
    expect(mockedInvoke.mock.calls.some(([c]) => c === "session_tail")).toBe(false);
    expect(mockedInvoke.mock.calls.some(([c]) => c === "notify_insert")).toBe(false);
  });

  it("cwd 锚点进 user 消息（begin 注入）", async () => {
    mockBackend();
    useNlStore.getState().begin("/var/log");
    useNlStore.getState().setInput("找出最大的文件");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    const sent = createdProviders[0].requests[0];
    expect(sent.messages[0].content).toContain("当前目录: /var/log");
  });

  it("done：围栏产物 sanitize + danger 红档（rm -rf）", async () => {
    mockBackend();
    script = ["```bash\nrm -rf /tmp/build\n```"];
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("清掉构建目录");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    const st = useNlStore.getState();
    expect(st.command).toBe("rm -rf /tmp/build");
    expect(st.level).toBe("red");
  });

  it("空结果（stop 截在围栏头）→ error/empty", async () => {
    mockBackend();
    script = ["```bash"];
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("列出文件");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("error");
    });
    expect(useNlStore.getState().errorKind).toBe("empty");
  });

  it("在途 abort → aborted 态（非 error）", async () => {
    mockBackend();
    const requests: MockProviderLike["requests"] = [];
    providerOverride = {
      requests,
      // 慢流：真定时器间隙让 abort 落在两 chunk 之间（Mock 的纯微任务流
      // 在任何测试观察点之前就跑完了，插不进取消）
      async *chat(req: ChatRequest) {
        requests.push(req);
        yield { text: "docker" };
        await new Promise((r) => setTimeout(r, 5));
        if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
        yield { text: " ps" };
      },
    } as unknown as MockProviderLike;
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("列出容器");
    const run = useNlStore.getState().submit();
    // 1ms 定时点：settings/key 出库（纯微任务）早已完成、controller 在位，
    // 慢流正睡在 5ms 的 chunk 间隙——abort 必落在窗口内
    await new Promise((r) => setTimeout(r, 1));
    useNlStore.getState().abort();
    await run;
    expect(useNlStore.getState().status).toBe("aborted");
    expect(useNlStore.getState().answer).toBe("docker"); // 首 chunk 已收，第二 chunk 未达
  });

  it("未配置 provider → error/noProvider（不触发请求）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("ls");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("error");
    });
    expect(useNlStore.getState().errorKind).toBe("noProvider");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("secrets 读取故障（非未存值）→ error/noKey；免 key（null 存储）→ 空串直连", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
      if (cmd === "secret_get") return Promise.reject(new Error("vault is locked"));
      return Promise.resolve(null);
    });
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("ls");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("error");
    });
    expect(useNlStore.getState().errorKind).toBe("noKey");
    expect(useNlStore.getState().error).toContain("vault is locked");

    // null 存储 = 未存 key（Ollama 免鉴权）→ 空串透传（fix 1/5 I-1 同口径）
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") return Promise.resolve(PROVIDERS);
      if (cmd === "secret_get") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("ls");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    expect(chatFactory.mock.calls[0][1]).toBe("");
  });

  it("provider 构造/请求抛错 → error/request 带端点消息（重试面）", async () => {
    mockBackend();
    failProvider = true;
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("ls");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("error");
    });
    expect(useNlStore.getState().errorKind).toBe("request");
    expect(useNlStore.getState().error).toContain("boom");
  });

  it("空白输入 submit no-op（不发请求）", async () => {
    mockBackend();
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("   ");
    await useNlStore.getState().submit();
    expect(useNlStore.getState().status).toBe("idle");
    expect(chatFactory).not.toHaveBeenCalled();
  });

  it("begin 重置上一轮残留（input/answer/command/error 全清）", async () => {
    mockBackend();
    useNlStore.getState().begin(null);
    useNlStore.getState().setInput("ls");
    await useNlStore.getState().submit();
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    useNlStore.getState().begin("/tmp");
    const st = useNlStore.getState();
    expect(st.input).toBe("");
    expect(st.answer).toBe("");
    expect(st.command).toBeNull();
    expect(st.cwd).toBe("/tmp");
    expect(st.status).toBe("idle");
  });
});
