// zustand store（Task 4）：hosts / credentials / hostGroups 全局状态 + 刷新动作。
// Task 5 的主机管理 UI 只消费这里，不直接 invoke——loading/error 统一收口。
// 低频读取（snippets、known_hosts、search 结果）走 vaultApi 直取，不进全局状态（YAGNI）。

import { create } from "zustand";
import {
  vaultApi,
  type Credential,
  type CredentialInput,
  type CredentialPatch,
  type Host,
  type HostGroup,
  type HostInput,
  type JumpChain,
  type JumpChainInput,
} from "./api";
import { invalidateHostNotes } from "../ai/hostContext";

interface VaultStore {
  hosts: Host[];
  credentials: Credential[];
  hostGroups: HostGroup[];
  /** 跳板链（Phase 2 Task 2）：HostForm 链选择与 JumpChainEditor 消费。 */
  jumpChains: JumpChain[];
  loading: boolean;
  error: string | null;

  /** 并发拉取四张列表；失败时置 error 并向上抛出（成功的表照常落态，见实现）。 */
  refresh: () => Promise<void>;
  createHost: (input: HostInput) => Promise<Host>;
  updateHost: (id: number, input: HostInput) => Promise<Host>;
  deleteHost: (id: number) => Promise<void>;
  createCredential: (input: CredentialInput) => Promise<Credential>;
  /** Task 6：patch null = 保留现值（未重输的密钥不重密封）。 */
  updateCredential: (id: number, patch: CredentialPatch) => Promise<Credential>;
  deleteCredential: (id: number) => Promise<void>;
  /** Task 5：分组创建（MVP 仅根级，parentId=null）/删除（组内主机经 FK 脱组）。 */
  createGroup: (name: string) => Promise<HostGroup>;
  deleteGroup: (id: number) => Promise<void>;
  /** Phase 2 Task 2：跳板链 CRUD（删链在 Rust 侧解绑引用主机，故连 hosts 刷）。 */
  createJumpChain: (input: JumpChainInput) => Promise<JumpChain>;
  updateJumpChain: (id: number, input: JumpChainInput) => Promise<JumpChain>;
  deleteJumpChain: (id: number) => Promise<void>;
}

export const useVaultStore = create<VaultStore>((set, get) => {
  /** 变更失败也要落 store.error（2026-11-01 功能审计 P2-7）：此前只有 refresh()
   *  会写 error，而 refresh 在**变更本身**失败时根本走不到——删除主机失败 =
   *  静默回弹、零提示（store.error 恒 null，用户无法判断到底删没删掉）。
   *  成功路径的 refresh() 会清掉 error（下一轮刷新即恢复）。 */
  const mutate = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };
  return ({
  hosts: [],
  credentials: [],
  hostGroups: [],
  jumpChains: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    // 2026-11-12 真机实证（隔离库塞进一行非 Vec<i64> 的跳板链 hops 即触发）：
    // 四张表此前用 Promise.all 并发拉，任一张表有一行脏数据 → 整组 reject →
    // **四张表全不落态** → 主机树/凭据/分组/跳板链同时空白，用户看到「应用被
    // 清空」（侧栏「还没有主机」+ 顶部红横幅 sqlite error），而真正的故障点
    // 只是其中一张表的一行。改 allSettled：成功的表照常落态，失败的表保留上
    // 次数据，错误汇总上报。**仍然上抛**——App 就绪链与导入后刷新都以
    // rejection 为失败信号（见 frontend/sync/entityRefresh.ts:57），失败不可
    // 被静默吞掉；变的是「一张表坏 ≠ 整个应用空白」。
    const [hosts, credentials, hostGroups, jumpChains] = await Promise.allSettled([
      vaultApi.hosts.list(),
      vaultApi.credentials.list(),
      vaultApi.hostGroups.list(),
      vaultApi.jumpChains.list(),
    ]);
    const failures: string[] = [];
    /** 成功取新值；失败保留上次数据并记一条错误（不让一张表拖垮其余）。 */
    const take = <T,>(r: PromiseSettledResult<T[]>, prev: T[]): T[] => {
      if (r.status === "fulfilled") return r.value;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // 去重：四张表常因同一原因同时失败（如 vault locked）——横幅里同一句
      // 报错重复四遍只会更难读。
      if (!failures.includes(msg)) failures.push(msg);
      return prev;
    };
    const nextHosts = take(hosts, get().hosts);
    const nextCredentials = take(credentials, get().credentials);
    const nextHostGroups = take(hostGroups, get().hostGroups);
    const nextJumpChains = take(jumpChains, get().jumpChains);
    if (failures.length === 0) {
      set({
        hosts: nextHosts,
        credentials: nextCredentials,
        hostGroups: nextHostGroups,
        jumpChains: nextJumpChains,
        loading: false,
        error: null,
      });
      return;
    }
    const message = failures.join("；");
    set({
      hosts: nextHosts,
      credentials: nextCredentials,
      hostGroups: nextHostGroups,
      jumpChains: nextJumpChains,
      loading: false,
      error: message,
    });
    throw new Error(message);
  },

  createHost: async (input) =>
    mutate(async () => {
      const host = await vaultApi.hosts.create(input);
      await get().refresh();
      return host;
    }),

  updateHost: async (id, input) =>
    mutate(async () => {
      const host = await vaultApi.hosts.update(id, input);
      // 主机备注被 AI 备忘注入缓存（frontend/ai/hostContext.ts）——改了备注要
      // 让缓存失效，否则下一轮 AI 仍用旧上下文。删缓存在 store 层做（唯一的
      // 主机写入收口），避免各写入点各漏一处。
      invalidateHostNotes(id);
      await get().refresh();
      return host;
    }),

  deleteHost: async (id) =>
    mutate(async () => {
      await vaultApi.hosts.remove(id);
      invalidateHostNotes(id);
      await get().refresh();
    }),

  createCredential: async (input) =>
    mutate(async () => {
      const credential = await vaultApi.credentials.create(input);
      await get().refresh();
      return credential;
    }),

  updateCredential: async (id, patch) =>
    mutate(async () => {
      const credential = await vaultApi.credentials.update(id, patch);
      await get().refresh();
      return credential;
    }),

  deleteCredential: async (id) =>
    // 删凭据会解绑引用它的主机（FK ON DELETE SET NULL），必须刷新 hosts。
    mutate(async () => {
      await vaultApi.credentials.remove(id);
      await get().refresh();
    }),

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

  createJumpChain: async (input) => {
    const chain = await vaultApi.jumpChains.create(input);
    await get().refresh();
    return chain;
  },

  updateJumpChain: async (id, input) => {
    const chain = await vaultApi.jumpChains.update(id, input);
    await get().refresh();
    return chain;
  },

  deleteJumpChain: async (id) => {
    // 删链 → 引用该链的主机 jump_chain_id 置 NULL（Rust 存储层解绑），必须刷新。
    await vaultApi.jumpChains.remove(id);
    await get().refresh();
  },
  });
});
