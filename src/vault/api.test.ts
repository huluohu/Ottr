// 数据冒烟（Task 4 裁定 #4）：mock @tauri-apps/api/core 的 invoke，验证
// api 封装与 zustand store 动作的接线、命令名契约与载荷形态。
// 真 Tauri 后端命令在 Task 5 接线；本测试锁住两侧契约，防类型漂移。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { vaultApi, type Credential, type Host, type HostInput } from "./api";
import { useVaultStore } from "./store";

const mockedInvoke = invoke as unknown as Mock;

const sampleHost: Host = {
  id: 1,
  name: "web-01",
  group_id: null,
  tags: ["prod"],
  address: "10.0.0.1",
  port: 2222,
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: "生产环境",
  created_at: 100,
  updated_at: 200,
};

const sampleCredential: Credential = {
  id: 7,
  kind: "password",
  key_pub: null,
  created_at: 1,
  updated_at: 2,
};

const sampleInput: HostInput = {
  name: "web-01",
  group_id: null,
  tags: ["prod"],
  address: "10.0.0.1",
  port: 2222,
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: "生产环境",
};

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe("vaultApi（invoke 封装）", () => {
  it("hosts.search 发送 hosts_search + camelCase 顶层参数", async () => {
    mockedInvoke.mockResolvedValue([sampleHost]);
    const rows = await vaultApi.hosts.search("生产");
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_search", { query: "生产" });
    expect(rows).toEqual([sampleHost]);
  });

  it("hosts.create 载荷保持 serde snake_case 形态", async () => {
    mockedInvoke.mockResolvedValue(sampleHost);
    await vaultApi.hosts.create(sampleInput);
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", { input: sampleInput });
  });

  it("credentials.reveal 走单点明文通道", async () => {
    mockedInvoke.mockResolvedValue("pw");
    const secret = await vaultApi.credentials.reveal(7, "secret");
    expect(mockedInvoke).toHaveBeenCalledWith("credentials_reveal", { id: 7, field: "secret" });
    expect(secret).toBe("pw");
  });
});

describe("useVaultStore", () => {
  it("refresh 并发拉取三张列表并清 loading", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([sampleHost]);
      if (cmd === "credentials_list") return Promise.resolve([sampleCredential]);
      if (cmd === "host_groups_list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    await useVaultStore.getState().refresh();
    const state = useVaultStore.getState();
    expect(state.hosts).toEqual([sampleHost]);
    expect(state.credentials).toEqual([sampleCredential]);
    expect(state.hostGroups).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("deleteHost 调 hosts_delete 并触发 refresh", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([]);
      if (cmd === "credentials_list") return Promise.resolve([]);
      if (cmd === "host_groups_list") return Promise.resolve([]);
      if (cmd === "hosts_delete") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    useVaultStore.setState({ hosts: [sampleHost] });
    await useVaultStore.getState().deleteHost(1);
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_delete", { id: 1 });
    expect(useVaultStore.getState().hosts).toEqual([]);
  });

  it("refresh 失败时置 error 并向上抛出", async () => {
    mockedInvoke.mockRejectedValue(new Error("vault locked"));
    await expect(useVaultStore.getState().refresh()).rejects.toThrow("vault locked");
    expect(useVaultStore.getState().error).toBe("vault locked");
    expect(useVaultStore.getState().loading).toBe(false);
  });
});
