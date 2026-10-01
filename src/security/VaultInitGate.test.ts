// VaultInitGate 就绪门测试（Task 16.5）：终态收敛（ready 直达 / 事件后到 / failed
// 带错误消息）、事件先挂后查的夹逼顺序、非 Tauri 降级直通。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type InitHandler = (e: { payload: unknown }) => void;
const eventHandlers = new Map<string, InitHandler>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: InitHandler) => {
    eventHandlers.set(event, handler);
    return Promise.resolve(() => eventHandlers.delete(event));
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  resetVaultInitGateForTest,
  useVaultInitGate,
  VAULT_INIT_FAILED_EVENT,
  VAULT_READY_EVENT,
} from "./VaultInitGate";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  eventHandlers.clear();
  resetVaultInitGateForTest();
});

describe("VaultInitGate 就绪门", () => {
  it("命令直答 ready → 门放行（正常快路径：init 先于 webview 加载完成）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "ready" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("ready");
    expect(useVaultInitGate.getState().error).toBeNull();
  });

  it("命令答 initializing → 等；vault-ready 事件后到 → 放行（夹逼右端）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "initializing" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("initializing");

    eventHandlers.get(VAULT_READY_EVENT)!({ payload: null });
    expect(useVaultInitGate.getState().phase).toBe("ready");
  });

  it("事件先于查询落地（命令回 initializing 前事件已发）→ 查询兜住漏窗（夹逼左端）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "initializing" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    // 事件在 init() 完成前触发（监听器已挂上、invoke 查询未回）：让微任务队列
    // 清空（两个 listen 已注册）再发事件。
    const pending = useVaultInitGate.getState().init();
    await new Promise((r) => setTimeout(r, 0));
    eventHandlers.get(VAULT_READY_EVENT)!({ payload: null });
    expect(useVaultInitGate.getState().phase).toBe("ready");
    await pending;
    // 查询返回 initializing 不得倒退（终态收敛是单向的）
    expect(useVaultInitGate.getState().phase).toBe("ready");
  });

  it("vault-init-failed 事件 → failed + 错误消息透出（Rust Display 原文）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "initializing" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    eventHandlers.get(VAULT_INIT_FAILED_EVENT)!({
      payload: "keychain is not available",
    });
    expect(useVaultInitGate.getState().phase).toBe("failed");
    expect(useVaultInitGate.getState().error).toBe("keychain is not available");
  });

  it("命令直答 failed → failed + error 落态", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status")
        return Promise.resolve({ status: "failed", error: "db corrupted" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("failed");
    expect(useVaultInitGate.getState().error).toBe("db corrupted");
  });

  it("非 Tauri 降级：listen/invoke 全挂 → 门直通 ready（双保险，调用方本就 IS_TAURI 分流）", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("no tauri")));
    // listen mock 正常返回，这里直接让事件监听挂上后 invoke 失败即可覆盖 catch。
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("ready");
  });
});
