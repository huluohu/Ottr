// VaultLockStore 状态机测试（T11）：status 启动分派（keyring 恒解锁 / password
// 锁定 / 查询失败 fail-closed）、unlock 成败、lock、Rust 事件贯通
// （ottr://vault-locked / vault-unlocked 单一收口）；T4 顺带修：解锁两收口
// （Rust 事件 + unlock 兜底）触发 vault 数据重拉（hosts 域）。
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
import { useVaultStore } from "../vault/store";

const mockedInvoke = invoke as unknown as Mock;

function mockStatus(mode: string, locked: boolean) {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "vault_security_status") return Promise.resolve({ mode, locked });
    if (cmd === "vault_unlock") return Promise.resolve(null);
    if (cmd === "vault_lock") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

/** 解锁后重拉的四张 vault 列表（T4 接线测试的取数面）。 */
function serveVaultLists(hosts: unknown[] = [{ id: 7, name: "post-unlock" }]) {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "hosts_list") return Promise.resolve(hosts);
    if (cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  eventHandlers.clear();
  resetVaultLockStoreForTest();
  useVaultStore.setState({ hosts: [], credentials: [], hostGroups: [], jumpChains: [], error: null });
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

  it("refreshStatus：重查 status 落 mode/phase（模式切换命令成功后的收口）", async () => {
    // 降级（password → keyring）成功后的场景：status 已翻 keyring，store 必须跟上。
    mockStatus("password", false);
    await useVaultLockStore.getState().init();
    expect(useVaultLockStore.getState().mode).toBe("password");

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_security_status") return Promise.resolve({ mode: "keyring", locked: false });
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    await useVaultLockStore.getState().refreshStatus();
    expect(useVaultLockStore.getState().mode).toBe("keyring");
    expect(useVaultLockStore.getState().phase).toBe("unlocked");

    // status 查询失败：fail-closed 按锁定收敛（与 init 同语义）。
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("backend gone")));
    await useVaultLockStore.getState().refreshStatus();
    expect(useVaultLockStore.getState().phase).toBe("locked");
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

  // T4 顺带修（T3 评审转办）：锁定期的启动 refresh 被 Locked 门卫拒绝后，
  // 主机树空 / 陈旧错误横幅无人清理——解锁收口必须重拉 vault 数据。
  it("vault-unlocked 事件 → vault 数据重拉（主机树不再困死空态）", async () => {
    mockStatus("keyring", false);
    await useVaultLockStore.getState().init();
    // 模拟锁定期失败残留：hosts 空 + 错误横幅在挂
    useVaultStore.setState({ hosts: [], error: "vault is locked" });

    serveVaultLists();
    eventHandlers.get(VAULT_UNLOCKED_EVENT)!({ payload: null });
    await waitForStore(() => expect(useVaultStore.getState().hosts).toHaveLength(1));
    expect(useVaultStore.getState().hosts[0].name).toBe("post-unlock");
    expect(useVaultStore.getState().error).toBeNull(); // 横幅随成功重拉消亡
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_list");
  });

  it("unlock 成功兜底路径同享重拉；失败路径不重拉", async () => {
    mockStatus("password", true);
    await useVaultLockStore.getState().init();
    mockedInvoke.mockImplementation((cmd: string, args?: { password?: string }) => {
      if (cmd === "vault_security_status") return Promise.resolve({ mode: "password", locked: true });
      if (cmd === "vault_unlock") {
        return args?.password === "correct horse"
          ? Promise.resolve(null)
          : Promise.reject(new Error("master password is incorrect"));
      }
      if (cmd === "hosts_list") return Promise.resolve([{ id: 9, name: "after-unlock" }]);
      if (cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    // 密码错：不解锁、不重拉（hosts_list 未被调用）
    await useVaultLockStore.getState().unlock("wrong");
    expect(useVaultLockStore.getState().phase).toBe("locked");
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_list");

    // 密码对：解锁即重拉（事件丢失兜底路径）
    const ok = await useVaultLockStore.getState().unlock("correct horse");
    expect(ok).toBe(true);
    await waitForStore(() => expect(useVaultStore.getState().hosts).toHaveLength(1));
    expect(useVaultStore.getState().hosts[0].name).toBe("after-unlock");
  });

  it("重拉失败不反噬解锁：error 留在 vault 域横幅面，解锁态照常落位", async () => {
    mockStatus("keyring", false);
    await useVaultLockStore.getState().init();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_security_status") return Promise.resolve({ mode: "keyring", locked: false });
      return Promise.reject(new Error("backend gone"));
    });
    eventHandlers.get(VAULT_UNLOCKED_EVENT)!({ payload: null });
    // 微任务排空后断言：解锁态已置位、vault 域错误在挂（用户可手动重试）
    await Promise.resolve();
    await Promise.resolve();
    expect(useVaultLockStore.getState().phase).toBe("unlocked");
    expect(useVaultStore.getState().error).toContain("backend gone");
  });
});

/** 等到断言通过（fire-and-forget refresh 的异步收口）。 */
async function waitForStore(assert: () => void): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      assert();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  assert(); // 末次直断言：仍不满足即抛真实差异
}
