// 自动档授权面的前端态（2026-11-04 第三步：逐主机自动执行授权）。
//
// 授权真源 = vault 的 `ai_host_policies` 表（**默认全拒**：没有授权行 =
// 该主机不允许 AI 自动执行任何命令）。本 store 只是**读缓存**——
// 真源永远是后端（前端缓存过期也只是少显示一个开关，不会放宽后端判定）。
//
// 为什么要有这层缓存：设置页要列全部主机 + 授权行，面板要按当前目标主机
// 判断「自动档能不能选」；两处都要读同一份，不能各拉各的。
import { create } from "zustand";
import { aiSessionApi, type AiHostPolicy, type AiWriteCategory } from "./sessionApi";

interface AiPolicyState {
  /** 已授权主机（按 hostId 升序）。 */
  policies: AiHostPolicy[];
  /** 从后端重读（设置页打开 / 同步导入后）。 */
  refresh: () => Promise<void>;
  /** 某主机是否被授权自动执行（未在册 = 未授权 = false）。 */
  authorized: (hostId: number) => boolean;
  /** 落/改某主机的授权（开关 + 写类别）。 */
  save: (
    hostId: number,
    autoEnabled: boolean,
    writeCategories: AiWriteCategory[],
  ) => Promise<void>;
  /** 回收某主机的授权（回到默认拒）。 */
  revoke: (hostId: number) => Promise<void>;
}

export const useAiPolicyStore = create<AiPolicyState>((set, get) => ({
  policies: [],
  refresh: async () => {
    const list = await aiSessionApi.policyList();
    set({ policies: Array.isArray(list) ? list : [] });
  },
  authorized: (hostId: number) =>
    get().policies.some((p) => p.hostId === hostId && p.autoEnabled),
  save: async (hostId, autoEnabled, writeCategories) => {
    const saved = await aiSessionApi.policySet(hostId, autoEnabled, writeCategories);
    set((st) => ({
      policies: [
        ...st.policies.filter((p) => p.hostId !== hostId),
        saved,
      ].sort((a, b) => a.hostId - b.hostId),
    }));
  },
  revoke: async (hostId) => {
    await aiSessionApi.policyDelete(hostId);
    set((st) => ({ policies: st.policies.filter((p) => p.hostId !== hostId) }));
  },
}));
