// vault store 变更失败的可见性（2026-11-01 功能审计 P2-7 回归）。
//
// 背景：此前只有 refresh() 会写 store.error，而 refresh 在**变更本身**失败时
// 根本走不到——删除主机失败 = 界面静默回弹、零提示（用户无法判断到底删没
// 删掉）。HostTree 的删除/drag 路径还显式 `.catch(() => {})` 吞掉 rejection，
// 注释里说「错误由 store.refresh 收口进全局 error」——前提不成立。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useVaultStore } from "./store";

const mockedInvoke = invoke as unknown as Mock;

describe("vault store：变更失败落 error", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    useVaultStore.setState({ hosts: [], credentials: [], hostGroups: [], jumpChains: [], loading: false, error: null });
  });

  it("deleteHost 失败：store.error 落错误消息（不再静默）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_delete") return Promise.reject(new Error("vault locked"));
      return Promise.resolve([]);
    });
    await expect(useVaultStore.getState().deleteHost(1)).rejects.toThrow("vault locked");
    expect(useVaultStore.getState().error).toContain("vault locked");
  });

  it("updateHost 失败：同样落 error（drag 移组路径也走这里）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_update") return Promise.reject(new Error("db busy"));
      return Promise.resolve([]);
    });
    await expect(
      useVaultStore.getState().updateHost(1, {
        protocol: "ssh",
        name: "x",
        group_id: null,
        tags: [],
        address: "10.0.0.1",
        port: 22,
        username: null,
        credential_id: null,
        jump_chain_id: null,
        encoding_override: null,
        theme_override: null,
        monitor_enabled: false,
        is_production: false,
        notes: null,
      }),
    ).rejects.toThrow("db busy");
    expect(useVaultStore.getState().error).toContain("db busy");
  });

  it("成功路径不残留 error（refresh 复位）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });
    useVaultStore.setState({ error: "旧错误" });
    await useVaultStore.getState().refresh();
    expect(useVaultStore.getState().error).toBeNull();
  });
});
