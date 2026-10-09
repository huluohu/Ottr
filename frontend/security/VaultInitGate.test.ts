// VaultInitGate 就绪门测试（Task 16.5）：终态收敛（ready 直达 / 事件后到 / failed
// 带错误消息）、事件先挂后查的夹逼顺序、非 Tauri 降级直通。
// BL-208（终审C-16，0×0 系残项）：F2 init panic 兜底（watchdog）/ F4 fail-open
// → fail-closed（Tauri 运行时查询失败不再直通）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
  VAULT_INIT_WATCHDOG_MS,
  VAULT_READY_EVENT,
} from "./VaultInitGate";

const mockedInvoke = invoke as unknown as Mock;

/** 模拟真 Tauri 运行时（init 的 fail-closed 分支以此为判据）。 */
function markTauriRuntime(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  eventHandlers.clear();
  resetVaultInitGateForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  resetVaultInitGateForTest();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
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
    await vi.advanceTimersByTimeAsync(0);
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

  // --- BL-208（0×0 系 F2/F4）------------------------------------------------

  it("F4 fail-closed：Tauri 运行时状态查询失败 → failed（不再 fail-open 直通）", async () => {
    markTauriRuntime();
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("state not managed: VaultInit")));
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("failed");
    expect(useVaultInitGate.getState().error).toContain("state not managed");
  });

  it("F2 兜底：initializing 挂死（init 线程 panic 既无 ready 也无 failed）→ watchdog 到时转 failed", async () => {
    markTauriRuntime();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "initializing" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    expect(useVaultInitGate.getState().phase).toBe("initializing");
    await vi.advanceTimersByTimeAsync(VAULT_INIT_WATCHDOG_MS);
    expect(useVaultInitGate.getState().phase).toBe("failed");
    expect(useVaultInitGate.getState().error).toContain("30");
  });

  it("F2 兜底不误伤：watchdog 期内 ready 事件到达 → 保持 ready，不转 failed", async () => {
    markTauriRuntime();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status") return Promise.resolve({ status: "initializing" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    eventHandlers.get(VAULT_READY_EVENT)!({ payload: null });
    await vi.advanceTimersByTimeAsync(VAULT_INIT_WATCHDOG_MS + 1000);
    expect(useVaultInitGate.getState().phase).toBe("ready");
    expect(useVaultInitGate.getState().error).toBeNull();
  });

  it("F2 兜底不重复计时：failed 终态后 watchdog 不再翻转状态", async () => {
    markTauriRuntime();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_init_status")
        return Promise.resolve({ status: "failed", error: "db corrupted" });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultInitGate.getState().init();
    await vi.advanceTimersByTimeAsync(VAULT_INIT_WATCHDOG_MS + 1000);
    expect(useVaultInitGate.getState().phase).toBe("failed");
    expect(useVaultInitGate.getState().error).toBe("db corrupted");
  });
});
