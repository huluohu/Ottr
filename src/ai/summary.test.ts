// 会话纪要链路测试（Phase 2 B1，Task 7）：
//   * buildSummaryPrompt 纯函数（system i18n 模板 + 编号命令序列）；
//   * generateSessionSummary 全链（Mock provider）：请求体断言（system/maxTokens
//     512/单轮无 stop）、**脱敏断言**（password=hunter2 不出现在外发请求体）、
//     提示符前缀剥离、门槛（<3 命令静默跳过）、入库载荷（command_count）、
//     通知落库（kind=ai title_key）、失败静默（provider 抛错/入库拒绝不外抛）。
// invoke 全量 mock（真后端命令已在 Rust 侧接线）；notify 管线用假端口注入。
// 词典固定 zh-CN（jsdom navigator.language 是 en-US，changeLanguage 拧回中文，
// 同 HistorySearch.test 惯例）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// onSessionEnded 去抖测试（BL-510③）需要可控的端点替身：createProvider 工厂
// mock（首个 chat 调用挂起直到测试放行；既有用例全走 opts.provider 注入不受影响）
const providerChats: ChatRequest[] = [];
let releaseChat: (() => void) | null = null;
vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => ({
      async *chat(req: ChatRequest) {
        providerChats.push(req);
        await new Promise<void>((r) => {
          releaseChat = r;
        });
        yield { text: "纪要正文。" };
      },
      async testConnection() {
        return "mock-ok";
      },
    }),
  };
});

import i18n from "../i18n";
import { resetRateLimiter } from "../notify/core";
import type { ChatRequest } from "./provider";
import {
  SUMMARY_MAX_TOKENS,
  buildSummaryPrompt,
  generateSessionSummary,
  onSessionEnded,
  type SessionEndInfo,
} from "./summary";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});

const mockedInvoke = invoke as unknown as Mock;

/** 记录请求的 provider 替身（非流式聚合用：两个增量即完整回复）。 */
class RecordingProvider {
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: string[]) {}
  async *chat(req: ChatRequest) {
    this.requests.push(req);
    for (const chunk of this.script) {
      yield { text: chunk };
    }
  }
  async testConnection(): Promise<string> {
    return "mock-ok";
  }
}

const REQ: SessionEndInfo = { hostId: 1, id: "tab-e2e", hostName: "web-01" };

const HISTORY_ROWS = [
  {
    id: 1,
    host_id: 1,
    command: "root@web01:~$ cd /srv/ottr",
    cwd: null,
    exit_code: 0,
    session_id: "tab-e2e",
    ts: 1_760_000_000,
  },
  {
    id: 2,
    host_id: 1,
    command: "root@web01:~$ export password=hunter2",
    cwd: null,
    exit_code: 0,
    session_id: "tab-e2e",
    ts: 1_760_000_001,
  },
  {
    id: 3,
    host_id: 1,
    command: "root@web01:~$ docker compose up -d",
    cwd: null,
    exit_code: 0,
    session_id: "tab-e2e",
    ts: 1_760_000_002,
  },
];

const PROVIDERS = [
  {
    id: "p1",
    name: "DeepSeek",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
];

function mockBackend(over: {
  history?: unknown[] | Error;
  secret?: string | null;
  insertRow?: unknown;
  /** vault_security_status 注入口（BL-510① 锁定态闸门）：缺省 unlocked。 */
  locked?: boolean | Error;
} = {}): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "vault_security_status") {
      if (over.locked instanceof Error) throw over.locked;
      return { mode: "password", locked: over.locked ?? false };
    }
    if (cmd === "settings_get") {
      switch (args?.key) {
        case "ai_providers":
          return PROVIDERS;
        case "redaction":
          return { hostname: true, custom: [] };
        case "ai.enabled":
          return true;
        case "ai.max_tokens":
          return 1024;
        default:
          return null;
      }
    }
    if (cmd === "history_list_session") {
      const rows = over.history === undefined ? HISTORY_ROWS : over.history;
      if (rows instanceof Error) throw rows;
      return rows;
    }
    if (cmd === "secret_get") {
      if (over.secret === undefined) return "sk-test";
      if (over.secret === null) return null;
      return over.secret;
    }
    if (cmd === "summary_insert") {
      if (over.insertRow instanceof Error) throw over.insertRow;
      if (over.insertRow === undefined) {
        return {
          id: 9,
          host_id: 1,
          session_id: "tab-e2e",
          summary: "x",
          command_count: 3,
          ts: 1_760_000_009,
        };
      }
      return over.insertRow;
    }
    if (cmd === "notify_insert") {
      return {
        id: 10,
        kind: "ai",
        severity: "info",
        host_id: 1,
        title_key: "notify.title.summaryReady",
        body: "web-01",
        payload: null,
        read: false,
        ts: 1_760_000_010,
      };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

/** 收集 summary_insert 载荷（入库断言面）。 */
function insertedPayloads(): Record<string, unknown>[] {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === "summary_insert")
    .map(([, args]) => args as Record<string, unknown>);
}

/** 收集 notify_insert 载荷（通知断言面）。 */
function notifiedPayloads(): Record<string, unknown>[] {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === "notify_insert")
    .map(([, args]) => args as Record<string, unknown>);
}

beforeEach(() => {
  mockedInvoke.mockReset();
  providerChats.length = 0;
  releaseChat = null;
  resetRateLimiter(); // notify 限频窗口（60s）不跨用例泄漏
});

describe("buildSummaryPrompt", () => {
  it("system = i18n 模板；user = 头段 + 逐条编号命令（顺序即数组序）", () => {
    const p = buildSummaryPrompt(["cd /srv", "docker compose up -d"]);
    expect(p.system).toContain("会话纪要");
    expect(p.user).toBe(
      "以下是本次会话中依次执行的命令（已脱敏，按时间顺序）:\n1. cd /srv\n2. docker compose up -d",
    );
  });
});

describe("generateSessionSummary", () => {
  it("全链：请求体（system/maxTokens 512/无 stop）+ 脱敏断言（无明文 hunter2）+ 提示符剥离", async () => {
    mockBackend();
    const provider = new RecordingProvider(["部署了 docker compose 服务，共 3 条命令。", "。"]);
    const ok = await generateSessionSummary(REQ, { provider });
    expect(ok).toBe(true);

    // 请求体断言：单轮、maxTokens 512（裁定 #2）、无 stop（非钉单行场景）
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0];
    expect(req.system).toContain("会话纪要");
    expect(req.maxTokens).toBe(SUMMARY_MAX_TOKENS);
    expect(req.stop).toBeUndefined();
    expect(req.messages).toHaveLength(1);

    // **脱敏断言（裁定 #1）**：命令序列先 redact 再进 prompt——注入
    // password=hunter2，请求体（system+user 全文）不得出现明文
    const outgoing = JSON.stringify(req);
    expect(outgoing).not.toContain("hunter2");
    expect(req.messages[0].content).toContain("[REDACTED_PASSWORD_1]");
    // 提示符前缀剥离：prompt 噪声（root@web01:~$）不进请求
    expect(req.messages[0].content).not.toContain("root@web01");
    expect(req.messages[0].content).toContain("1. cd /srv/ottr");
    expect(req.messages[0].content).toContain("3. docker compose up -d");

    // 入库载荷：脱敏后的摘要 + 命令数
    const inserted = insertedPayloads();
    expect(inserted).toHaveLength(1);
    const input = inserted[0].input as Record<string, unknown>;
    expect(input).toMatchObject({
      host_id: 1,
      session_id: "tab-e2e",
      summary: "部署了 docker compose 服务，共 3 条命令。。",
      command_count: 3,
    });

    // 通知落库：kind=ai + summaryReady 标题键（T12 管线，T13 先例）
    const notified = notifiedPayloads();
    expect(notified).toHaveLength(1);
    const nInput = notified[0].input as Record<string, unknown>;
    expect(nInput).toMatchObject({
      kind: "ai",
      severity: "info",
      host_id: 1,
      title_key: "notify.title.summaryReady",
      body: "web-01",
    });
    // payload 钉死（BL-510②）：session_id/command_count 随行——通知中心点开
    // 可溯源到会话与规模；形状变化即此处红（防脱敏/重构时静默改形）
    expect(nInput.payload).toEqual({ session_id: "tab-e2e", command_count: 3 });
  });

  it("门槛：<3 条命令静默跳过（不碰 settings/provider——未成会话不生成）", async () => {
    mockBackend({ history: HISTORY_ROWS.slice(0, 2) });
    const provider = new RecordingProvider(["x"]);
    const ok = await generateSessionSummary(REQ, { provider });
    expect(ok).toBe(false);
    expect(provider.requests).toHaveLength(0);
    const commands = mockedInvoke.mock.calls.filter(([cmd]) => cmd === "settings_get");
    expect(commands).toHaveLength(0);
    expect(insertedPayloads()).toHaveLength(0);
  });

  it("0 条历史（连接失败未成会话）：取数即退出，不生成", async () => {
    mockBackend({ history: [] });
    const ok = await generateSessionSummary(REQ, {
      provider: new RecordingProvider(["x"]),
    });
    expect(ok).toBe(false);
    expect(insertedPayloads()).toHaveLength(0);
  });

  it("未配置 provider：静默跳过", async () => {
    mockBackend();
    mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "history_list_session") return HISTORY_ROWS;
      if (cmd === "settings_get" && args?.key === "ai_providers") return [];
      return null;
    });
    const ok = await generateSessionSummary(REQ, {
      provider: new RecordingProvider(["x"]),
    });
    expect(ok).toBe(false);
    expect(insertedPayloads()).toHaveLength(0);
  });

  it("provider 抛错：恒不外抛（fire-and-forget 纪律），返回 false 不入库", async () => {
    mockBackend();
    const broken = {
      chat: () => {
        throw new Error("endpoint down");
      },
      testConnection: async () => "x",
    } as unknown as RecordingProvider;
    const ok = await generateSessionSummary(REQ, { provider: broken });
    expect(ok).toBe(false);
    expect(insertedPayloads()).toHaveLength(0);
    expect(notifiedPayloads()).toHaveLength(0);
  });

  it("空回复：不入库不通知", async () => {
    mockBackend();
    const ok = await generateSessionSummary(REQ, {
      provider: new RecordingProvider(["   "]),
    });
    expect(ok).toBe(false);
    expect(insertedPayloads()).toHaveLength(0);
  });

  it("入库失败（vault 锁定等）：静默 false，不外抛", async () => {
    mockBackend({ insertRow: new Error("vault is locked; unlock with the master password") });
    const ok = await generateSessionSummary(REQ, {
      provider: new RecordingProvider(["纪要正文。"]),
    });
    expect(ok).toBe(false);
    expect(notifiedPayloads()).toHaveLength(0);
  });

  it("history 取数失败：静默 false", async () => {
    mockBackend({ history: new Error("backend gone") });
    const ok = await generateSessionSummary(REQ, {
      provider: new RecordingProvider(["x"]),
    });
    expect(ok).toBe(false);
    expect(insertedPayloads()).toHaveLength(0);
  });

  it("锁定态前置闸门：vault 锁定 → 不派发 LLM、不入库、不通知（BL-510①）", async () => {
    mockBackend({ locked: true });
    const provider = new RecordingProvider(["纪要正文。"]);
    const ok = await generateSessionSummary(REQ, { provider });
    expect(ok).toBe(false);
    // 派发前置闸门：请求未出网（现状是请求已发出、入库被拒静默丢）
    expect(provider.requests).toHaveLength(0);
    expect(insertedPayloads()).toHaveLength(0);
    expect(notifiedPayloads()).toHaveLength(0);
  });

  it("锁定态查询失败：fail-closed（宁可漏一条尽力而为的纪要，不赌白烧 LLM）", async () => {
    mockBackend({ locked: new Error("backend gone") });
    const provider = new RecordingProvider(["x"]);
    const ok = await generateSessionSummary(REQ, { provider });
    expect(ok).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(insertedPayloads()).toHaveLength(0);
  });
});

describe("onSessionEnded（双路径 in-flight 去抖，BL-510③）", () => {
  it("同 session 在途重复派发 → 只生成一次（disconnect+closeTab 双收尾真实时序）", async () => {
    mockBackend();
    const req = { ...REQ, id: "tab-debounce-1" };
    onSessionEnded(req);
    // 第一次还在途——closeTab 紧跟 disconnect 的第二次派发（同步紧随，见不了微任务）
    onSessionEnded(req);
    // 在途确认：链路走到 chat 挂起点且只有一次派发；期间未入库
    await vi.waitFor(() => expect(providerChats).toHaveLength(1));
    expect(insertedPayloads()).toHaveLength(0);
    releaseChat?.();
    await vi.waitFor(() => expect(insertedPayloads()).toHaveLength(1));
    // LLM 只派发一次（结果复用在途那次），通知恰一次
    expect(providerChats).toHaveLength(1);
    expect(notifiedPayloads()).toHaveLength(1);
  });

  it("在途完成后的新一次收尾 → 正常重新生成（去抖不误吞后续会话）", async () => {
    mockBackend();
    const first = { ...REQ, id: "tab-debounce-2" };
    onSessionEnded(first);
    await vi.waitFor(() => expect(providerChats).toHaveLength(1));
    releaseChat?.();
    await vi.waitFor(() => expect(insertedPayloads()).toHaveLength(1));
    // 首次已结算（in-flight 已清）——同一会话再次收尾 = 新一轮生成
    onSessionEnded(first);
    await vi.waitFor(() => expect(providerChats).toHaveLength(2));
    releaseChat?.();
    await vi.waitFor(() => expect(insertedPayloads()).toHaveLength(2));
  });
});
