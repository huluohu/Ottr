// 会话纪要触发链端到端（Phase 2 B1，Task 7 Step 3「真夹具一轮」TS 侧全链）：
// 真 SessionStore 状态机（closeTab）→ 真钩子接线（setSessionEndHook →
// onSessionEnded）→ 真生成链（settings/redact/prompt 装配/通知管线全真）→
// 真 invoke 面（history_list_session / summary_insert / notify_insert 载荷
// 断言，MockProvider 顶替网络端点）→ 真 HistorySearch 面板「纪要」页签可见。
// 三个命令的会话（含 password=hunter2 敏感面）→ 断开 → 纪要入库可查；
// provider 故障 → 静默（不入库、不反噬 closeTab）。
// 词典固定 zh-CN（同 HistorySearch.test 惯例）。
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

// Mock provider 工厂（端点替身；请求体记录供脱敏断言）
const chatScripts: string[][] = [];
const recordedRequests: unknown[] = [];
let providerFails = false;
vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => ({
      async *chat(req: unknown) {
        if (providerFails) throw new Error("endpoint down");
        recordedRequests.push(req);
        for (const chunk of chatScripts[0] ?? ["纪要正文。"]) {
          yield { text: chunk };
        }
      },
      async testConnection() {
        return "mock-ok";
      },
    }),
  };
});

import i18n from "../i18n";
import type { Host } from "../vault/api";
import { setSessionEndHook, useSessionStore } from "../session/SessionStore";
import { onSessionEnded } from "./summary";
import { HistorySearch } from "../history/HistorySearch";

const mockedInvoke = invoke as unknown as Mock;

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterAll(async () => {
  await i18n.changeLanguage("en-US");
});

const hostA: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: [],
  address: "10.0.0.1",
  port: 22,
  username: "deploy",
  protocol: "ssh",
  credential_id: 7,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

const HISTORY_ROWS = [1, 2, 3].map((i) => ({
  id: i,
  host_id: 1,
  command:
    i === 2
      ? "root@web01:~$ export password=hunter2"
      : `root@web01:~$ docker compose ${i === 1 ? "config" : "up -d"}`,
  cwd: null,
  exit_code: 0,
  session_id: expect.any(String) as unknown as string,
  ts: 1_760_000_000 + i,
}));

/** 入库载荷（summary_insert 断言面）。 */
function insertedPayloads(): Record<string, unknown>[] {
  return mockedInvoke.mock.calls
    .filter(([cmd]) => cmd === "summary_insert")
    .map(([, args]) => args as Record<string, unknown>);
}

let capturedSummaryRow: Record<string, unknown> | null = null;

beforeEach(() => {
  mockedInvoke.mockReset();
  chatScripts.length = 0;
  chatScripts.push(["部署了 docker compose 服务，配置了环境变量。", ""]);
  recordedRequests.length = 0;
  providerFails = false;
  capturedSummaryRow = null;
  useSessionStore.setState({
    sessions: [],
    activeId: null,
    hostKeyAsk: null,
    settings: { maxReconnectAttempts: 2 },
    trees: {},
    activePane: {},
    searchSessionId: null,
  });
  localStorage.clear();
});

function backend(): void {
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "history_list_session") return HISTORY_ROWS;
    if (cmd === "settings_get") {
      switch (args?.key) {
        case "ai_providers":
          return [
            {
              id: "p1",
              name: "DeepSeek",
              kind: "openai-compatible",
              baseURL: "https://api.deepseek.com",
              model: "deepseek-chat",
            },
          ];
        case "redaction":
          return { hostname: true, custom: [] };
        default:
          return null;
      }
    }
    if (cmd === "secret_get") return "sk-test";
    if (cmd === "summary_insert") {
      capturedSummaryRow = {
        id: 9,
        ...(args?.input as Record<string, unknown>),
        ts: 1_760_000_009,
      };
      return capturedSummaryRow;
    }
    if (cmd === "summary_list") {
      return capturedSummaryRow ? [capturedSummaryRow] : [];
    }
    if (cmd === "notify_insert") {
      return { id: 10, read: false, ts: 1_760_000_010 };
    }
    return undefined;
  });
}

describe("触发链端到端（断开→生成→入库→面板可见）", () => {
  it("3 命令会话 closeTab → 纪要入库（脱敏）→ ⌘R 纪要页签可查", async () => {
    backend();
    setSessionEndHook(onSessionEnded);

    // 会话开 + 关（数据源 3 条命令同 session_id；会话 id 由 store 生成）
    const id = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    HISTORY_ROWS.forEach((r) => (r.session_id = id));
    act(() => useSessionStore.getState().closeTab(id));

    // fire-and-forget 链路全部是微任务：flush 后入库
    await act(async () => {});
    await act(async () => {});
    const inserted = insertedPayloads();
    expect(inserted).toHaveLength(1);
    const input = inserted[0].input as Record<string, unknown>;
    expect(input).toMatchObject({
      host_id: 1,
      session_id: id,
      command_count: 3,
      summary: "部署了 docker compose 服务，配置了环境变量。",
    });
    // 脱敏闭环：外发请求体无明文，入库摘要（模型回文）同样无明文
    expect(JSON.stringify(recordedRequests)).not.toContain("hunter2");
    expect(JSON.stringify(inserted)).not.toContain("hunter2");

    // 面板可见：纪要页签渲染入库行（主机名 / 摘要全文 / 命令数）
    render(
      <HistorySearch
        open
        onClose={() => {}}
        hosts={[hostA]}
        onInsert={() => {}}
        plat="mac"
      />,
    );
    fireEvent.click(screen.getByTestId("summary-tab"));
    await act(async () => {});
    expect(mockedInvoke).toHaveBeenCalledWith("summary_list", { hostId: null, limit: 50 });
    expect(screen.getAllByTestId("summary-item")).toHaveLength(1);
    expect(screen.getByText("部署了 docker compose 服务，配置了环境变量。")).toBeTruthy();
    cleanup();
  });

  it("provider 故障：静默——不入库、不通知，closeTab 不受影响", async () => {
    backend();
    providerFails = true;
    setSessionEndHook(onSessionEnded);
    const id = useSessionStore.getState().openTab(hostA, { autoConnect: false });
    expect(() => act(() => useSessionStore.getState().closeTab(id))).not.toThrow();
    await act(async () => {});
    await act(async () => {});
    expect(insertedPayloads()).toHaveLength(0);
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === "notify_insert")).toBe(false);
  });
});
