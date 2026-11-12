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

// 2026-11-12 真机实证的回归：一张表里有一行脏数据（跳板链 hops 非 Vec<i64>）
// → 此前 Promise.all 整组 reject → 四张表全不落态 → 主机树/凭据/分组/跳板链
// 同时空白（用户看到「应用被清空」）。改 allSettled 后：其余表照常落态。
describe("vault store：单表失败不再牵连全片（2026-11-12 真机回归）", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    useVaultStore.setState({
      hosts: [],
      credentials: [],
      hostGroups: [],
      jumpChains: [],
      loading: false,
      error: null,
    });
  });

  it("跳板链列表失败：主机/凭据/分组照常落态 + 仍然上抛", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([{ id: 1, name: "prod-1" }]);
      if (cmd === "credentials_list") return Promise.resolve([{ id: 7, name: "cred" }]);
      if (cmd === "host_groups_list") return Promise.resolve([{ id: 3, name: "grp" }]);
      if (cmd === "jc_list") return Promise.reject(new Error("malformed jump chain hops json"));
      return Promise.resolve(null);
    });
    await expect(useVaultStore.getState().refresh()).rejects.toThrow("malformed jump chain hops json");
    const s = useVaultStore.getState();
    expect(s.hosts).toHaveLength(1);
    expect(s.credentials).toHaveLength(1);
    expect(s.hostGroups).toHaveLength(1);
    expect(s.error).toContain("malformed jump chain hops json");
    expect(s.loading).toBe(false);
  });

  it("跳板链列表失败：跳板链保留上次数据（不清空成空列表）", async () => {
    useVaultStore.setState({ jumpChains: [{ id: 9, name: "chain-a", hops: [1] }] as never });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "jc_list") return Promise.reject(new Error("db corrupt"));
      return Promise.resolve([]);
    });
    await expect(useVaultStore.getState().refresh()).rejects.toThrow("db corrupt");
    expect(useVaultStore.getState().jumpChains).toHaveLength(1);
  });

  it("四张表全失败：错误汇总且四张表都保留上次数据", async () => {
    useVaultStore.setState({ hosts: [{ id: 1, name: "prod-1" }] as never });
    mockedInvoke.mockImplementation(() => Promise.reject(new Error("vault locked")));
    await expect(useVaultStore.getState().refresh()).rejects.toThrow("vault locked");
    const s = useVaultStore.getState();
    expect(s.hosts).toHaveLength(1);
    expect(s.error).toContain("vault locked");
  });
});
