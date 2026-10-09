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
  username: "deploy",
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: "生产环境",
  created_at: 100,
  updated_at: 200,
};

const sampleCredential: Credential = {
  id: 7,
  kind: "password",
  name: null,
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
  username: "deploy",
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
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

  // Task 4 评审转交必办②：listByGroup 的 { groupId } camelCase 顶层参数真实用例
  it("hosts.listByGroup 发送 hosts_list_by_group + camelCase groupId（含 null 组）", async () => {
    mockedInvoke.mockResolvedValue([sampleHost]);
    const grouped = await vaultApi.hosts.listByGroup(5);
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_list_by_group", { groupId: 5 });
    expect(grouped).toEqual([sampleHost]);

    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue([]);
    const ungrouped = await vaultApi.hosts.listByGroup(null);
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_list_by_group", { groupId: null });
    expect(ungrouped).toEqual([]);
  });

  it("importSshConfig 发送 import_ssh_config（path=null 走默认 ~/.ssh/config）", async () => {
    const report = { added: 3, skipped_wildcards: 2, skipped_duplicates: 1, errors: ["L9: …"] };
    mockedInvoke.mockResolvedValue(report);
    const got = await vaultApi.importSshConfig(null);
    expect(mockedInvoke).toHaveBeenCalledWith("import_ssh_config", { path: null });
    expect(got).toEqual(report);
  });

  it("exportHostsCsv 发送 export_hosts_csv 并返回落盘路径", async () => {
    mockedInvoke.mockResolvedValue("/Downloads/ottr-hosts.csv");
    const path = await vaultApi.exportHostsCsv(null);
    expect(mockedInvoke).toHaveBeenCalledWith("export_hosts_csv", { path: null });
    expect(path).toBe("/Downloads/ottr-hosts.csv");
  });

  it("credentials.reveal 走单点明文通道", async () => {
    mockedInvoke.mockResolvedValue("pw");
    const secret = await vaultApi.credentials.reveal(7, "secret");
    expect(mockedInvoke).toHaveBeenCalledWith("credentials_reveal", { id: 7, field: "secret" });
    expect(secret).toBe("pw");
  });
});

describe("useVaultStore", () => {
  it("refresh 并发拉取四张列表（hosts/credentials/groups/jumpChains）并清 loading", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([sampleHost]);
      if (cmd === "credentials_list") return Promise.resolve([sampleCredential]);
      if (cmd === "host_groups_list") return Promise.resolve([]);
      if (cmd === "jc_list")
        return Promise.resolve([{ id: 7, name: "c", hops: [1], created_at: 0, updated_at: 0 }]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    await useVaultStore.getState().refresh();
    const state = useVaultStore.getState();
    expect(state.hosts).toEqual([sampleHost]);
    expect(state.credentials).toEqual([sampleCredential]);
    expect(state.hostGroups).toEqual([]);
    expect(state.jumpChains).toHaveLength(1);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("deleteHost 调 hosts_delete 并触发 refresh", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list") return Promise.resolve([]);
      if (cmd === "credentials_list") return Promise.resolve([]);
      if (cmd === "host_groups_list" || cmd === "jc_list") return Promise.resolve([]);
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

  it("createGroup/deleteGroup 走分组命令并触发 refresh（Task 5 新增动作）", async () => {
    const group = { id: 3, name: "生产组", parent_id: null, color: null, created_at: 1, updated_at: 1 };
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "host_groups_create") return Promise.resolve(group);
      if (cmd === "host_groups_delete") return Promise.resolve(undefined);
      if (cmd === "hosts_list" || cmd === "credentials_list") return Promise.resolve([]);
      if (cmd === "host_groups_list" || cmd === "jc_list") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    const created = await useVaultStore.getState().createGroup("生产组");
    expect(mockedInvoke).toHaveBeenCalledWith("host_groups_create", {
      name: "生产组",
      parentId: null,
      color: null,
    });
    expect(created.id).toBe(3);

    useVaultStore.setState({ hostGroups: [group] });
    await useVaultStore.getState().deleteGroup(3);
    expect(mockedInvoke).toHaveBeenCalledWith("host_groups_delete", { id: 3 });
    expect(useVaultStore.getState().hostGroups).toEqual([]);
  });
});
