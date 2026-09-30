// VaultLockStore 状态机测试（T11）：status 启动分派（keyring 恒解锁 / password
// 锁定 / 查询失败 fail-closed）、unlock 成败、lock、Rust 事件贯通
// （ottr://vault-locked / vault-unlocked 单一收口）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type LockHandler = (e: { payload: unknown }) => void;
const eventHandlers = new Map<string, LockHandler>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: LockHandler) => {
    eventHandlers.set(event, handler);
    return Promise.resolve(() => eventHandlers.delete(event));
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  resetVaultLockStoreForTest,
  useVaultLockStore,
  VAULT_LOCKED_EVENT,
  VAULT_UNLOCKED_EVENT,
} from "./VaultLockStore";

const mockedInvoke = invoke as unknown as Mock;

function mockStatus(mode: string, locked: boolean) {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "vault_security_status") return Promise.resolve({ mode, locked });
    if (cmd === "vault_unlock") return Promise.resolve(null);
    if (cmd === "vault_lock") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  eventHandlers.clear();
  resetVaultLockStoreForTest();
});

describe("VaultLockStore 状态机", () => {
  it("keyring 模式：恒 unlocked（无锁概念）", async () => {
    mockStatus("keyring", false);
    await useVaultLockStore.getState().init();
    expect(useVaultLockStore.getState().phase).toBe("unlocked");
    expect(useVaultLockStore.getState().mode).toBe("keyring");
  });

  it("password 模式：启动即锁定", async () => {
    mockStatus("password", true);
    await useVaultLockStore.getState().init();
    expect(useVaultLockStore.getState().phase).toBe("locked");
    expect(useVaultLockStore.getState().mode).toBe("password");
  });

  it("status 查询失败：fail-closed 按锁定收敛", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("backend gone")));
    await useVaultLockStore.getState().init();
    expect(useVaultLockStore.getState().phase).toBe("locked");
  });

  it("unlock：密码错 → error 落态、phase 仍 locked；密码对 → unlocked", async () => {
    mockStatus("password", true);
    await useVaultLockStore.getState().init();
    mockedInvoke.mockImplementation((cmd: string, args?: { password?: string }) => {
      if (cmd !== "vault_unlock") return Promise.reject(new Error(cmd));
      if (args?.password === "correct horse") return Promise.resolve(null);
      return Promise.reject(new Error("master password is incorrect"));
    });
    const ok = await useVaultLockStore.getState().unlock("wrong");
    expect(ok).toBe(false);
    expect(useVaultLockStore.getState().phase).toBe("locked");
    expect(useVaultLockStore.getState().error).toContain("master password is incorrect");

    const ok2 = await useVaultLockStore.getState().unlock("correct horse");
    expect(ok2).toBe(true);
    expect(useVaultLockStore.getState().phase).toBe("unlocked");
    expect(useVaultLockStore.getState().error).toBeNull();
  });

  it("lock：手动锁定落 locked", async () => {
    mockStatus("keyring", false);
    await useVaultLockStore.getState().init();
    await useVaultLockStore.getState().lock();
    expect(useVaultLockStore.getState().phase).toBe("locked");
  });

  it("Rust 事件贯通：vault-locked / vault-unlocked 驱动状态（多入口单一收口）", async () => {
    mockStatus("keyring", false);
    await useVaultLockStore.getState().init();
    expect(eventHandlers.has(VAULT_LOCKED_EVENT)).toBe(true);
    expect(eventHandlers.has(VAULT_UNLOCKED_EVENT)).toBe(true);

    eventHandlers.get(VAULT_LOCKED_EVENT)!({ payload: null });
    expect(useVaultLockStore.getState().phase).toBe("locked");

    eventHandlers.get(VAULT_UNLOCKED_EVENT)!({ payload: null });
    expect(useVaultLockStore.getState().phase).toBe("unlocked");
  });
});
