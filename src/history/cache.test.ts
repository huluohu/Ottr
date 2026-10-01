// 补全历史缓存测试（Task 8，B8 数据面）：复用 history_search 空查询拉取
// （host + 全局并行、并发去重）、MRU 增量追加、规范化（提示符剥离/多行/
// 集成噪声剔除）、失败静默。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

import {
  CompletionHistoryCache,
  COMPLETION_HISTORY_LIMIT,
  normalizeCommand,
  normalizeCommands,
} from "./cache";

/** history_search 的 invoke 面（vaultApi.history.search → invoke("history_search")）：
 * 返回行由测试用例按 (query, hostId) 灌入。 */
function stubSearch(rows: Array<{ command: string; host_id: number }>): void {
  mockedInvoke.mockImplementation((_cmd: string, args: { query: string; hostId: number | null }) =>
    Promise.resolve(rows.filter((r) => args.hostId === null || r.host_id === args.hostId)),
  );
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeCommand/normalizeCommands", () => {
  it("剥提示符 + 去空白", () => {
    expect(normalizeCommand("root@web:~$ docker ps")).toBe("docker ps");
    expect(normalizeCommand("  ls -la  ")).toBe("ls -la");
  });

  it("多行/集成噪声/空 → null", () => {
    expect(normalizeCommand("git add -A\ngit commit")).toBeNull();
    expect(normalizeCommand("export PROMPT_COMMAND=x")).toBeNull();
    expect(normalizeCommand("   ")).toBeNull();
  });

  it("列表保序去重", () => {
    expect(normalizeCommands(["ls", "root@h:~$ ls", "docker ps", ""])).toEqual([
      "ls",
      "docker ps",
    ]);
  });
});

describe("CompletionHistoryCache", () => {
  it("ensure：host 表 + 全局表并行拉取（载荷断言：空 query + hostId 维度）", async () => {
    stubSearch([
      { command: "root@h:~$ docker ps", host_id: 7 },
      { command: "ls -la", host_id: 7 },
      { command: "global-only git status", host_id: 9 },
    ]);
    const cache = new CompletionHistoryCache();
    await cache.ensure(7);
    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === "history_search");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1].hostId).sort()).toEqual([7, null]);
    for (const c of calls) {
      expect(c[1].query).toBe("");
      expect(c[1].limit).toBe(COMPLETION_HISTORY_LIMIT);
    }
    const { suggest } = await import("../terminal/completion");
    expect(
      suggest({ line: "doc", cursor: 3 }, cache.sources(7))?.suffix,
    ).toBe("ker ps");
    expect(
      suggest({ line: "global", cursor: 6 }, cache.sources(7))?.suffix,
    ).toBe("-only git status");
  });

  it("ensure：同 host 并发去重（单飞），命中缓存后不再拉", async () => {
    stubSearch([{ command: "ls", host_id: 1 }]);
    const cache = new CompletionHistoryCache();
    await Promise.all([cache.ensure(1), cache.ensure(1)]);
    expect(mockedInvoke).toHaveBeenCalledTimes(2); // host + global 各一次
    mockedInvoke.mockClear();
    await cache.ensure(1);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("append：MRU 前插去重 + 双表同步；规范化不过关静默丢弃", () => {
    const cache = new CompletionHistoryCache();
    cache.append(7, "root@h:~$ docker ps");
    cache.append(7, "ls -la");
    cache.append(7, "root@h:~$ docker ps"); // 重复 → 移到队首（不重复）
    cache.append(7, "git add -A\ngit commit"); // 多行 → 丢弃
    const src = cache.sources(7);
    expect(src.hostHistory).toEqual(["docker ps", "ls -la"]);
    expect(src.globalHistory).toEqual(["docker ps", "ls -la"]);
  });

  it("append：容量滚动（CAP 截尾）", () => {
    const cache = new CompletionHistoryCache();
    for (let i = 0; i < COMPLETION_HISTORY_LIMIT + 5; i++) {
      cache.append(1, `cmd-${i}`);
    }
    const src = cache.sources(1);
    expect(src.hostHistory).toHaveLength(COMPLETION_HISTORY_LIMIT);
    expect(src.hostHistory[0]).toBe(`cmd-${COMPLETION_HISTORY_LIMIT + 4}`);
  });

  it("ensure 失败静默：不抛、缓存为空（只剩内置表）、可重试", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("vault busy")));
    const cache = new CompletionHistoryCache();
    await expect(cache.ensure(3)).resolves.toBeUndefined();
    expect(cache.sources(3).hostHistory).toEqual([]);
    mockedInvoke.mockImplementation(() => Promise.resolve([{ command: "ls", host_id: 3 }]));
    await cache.ensure(3);
    expect(cache.sources(3).hostHistory).toEqual(["ls"]);
  });

  it("未 ensure 的 host：sources 为空数组（不掷错）", () => {
    const cache = new CompletionHistoryCache();
    expect(cache.sources(42)).toEqual({ hostHistory: [], globalHistory: [] });
  });
});
