// zustand store（Task 4）：hosts / credentials / hostGroups 全局状态 + 刷新动作。
// Task 5 的主机管理 UI 只消费这里，不直接 invoke——loading/error 统一收口。
// 低频读取（snippets、known_hosts、search 结果）走 vaultApi 直取，不进全局状态（YAGNI）。

import { create } from "zustand";
import {
  vaultApi,
  type Credential,
  type CredentialInput,
  type Host,
  type HostGroup,
  type HostInput,
} from "./api";

interface VaultStore {
  hosts: Host[];
  credentials: Credential[];
  hostGroups: HostGroup[];
  loading: boolean;
  error: string | null;

  /** 并发拉取三张列表；失败时置 error 并向上抛出。 */
  refresh: () => Promise<void>;
  createHost: (input: HostInput) => Promise<Host>;
  updateHost: (id: number, input: HostInput) => Promise<Host>;
  deleteHost: (id: number) => Promise<void>;
  createCredential: (input: CredentialInput) => Promise<Credential>;
  deleteCredential: (id: number) => Promise<void>;
  /** Task 5：分组创建（MVP 仅根级，parentId=null）/删除（组内主机经 FK 脱组）。 */
  createGroup: (name: string) => Promise<HostGroup>;
  deleteGroup: (id: number) => Promise<void>;
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  hosts: [],
  credentials: [],
  hostGroups: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [hosts, credentials, hostGroups] = await Promise.all([
        vaultApi.hosts.list(),
        vaultApi.credentials.list(),
        vaultApi.hostGroups.list(),
      ]);
      set({ hosts, credentials, hostGroups, loading: false });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false });
      throw e;
    }
  },

  createHost: async (input) => {
    const host = await vaultApi.hosts.create(input);
    await get().refresh();
    return host;
  },

  updateHost: async (id, input) => {
    const host = await vaultApi.hosts.update(id, input);
    await get().refresh();
    return host;
  },

  deleteHost: async (id) => {
    await vaultApi.hosts.remove(id);
    await get().refresh();
  },

  createCredential: async (input) => {
    const credential = await vaultApi.credentials.create(input);
    await get().refresh();
    return credential;
  },

  deleteCredential: async (id) => {
    // 删凭据会解绑引用它的主机（FK ON DELETE SET NULL），必须刷新 hosts。
    await vaultApi.credentials.remove(id);
    await get().refresh();
  },

  createGroup: async (name) => {
    // MVP 分组均为根级（parent_id=null）；嵌套树待有真实诉求再做
    const group = await vaultApi.hostGroups.create(name, null, null);
    await get().refresh();
    return group;
  },

  deleteGroup: async (id) => {
    // 删组 → 组内主机 group_id 置空、子组提根（FK SET NULL），必须刷新 hosts。
    await vaultApi.hostGroups.remove(id);
    await get().refresh();
  },
}));
