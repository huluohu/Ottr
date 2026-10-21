// 快捷键覆盖的装载/保存/广播（设置→快捷键的唯一持久化通道）。
//
// 错误恢复纪律（2026-10-21 设计裁定）：
// * 装载逐条校验——未知动作 id / 非串值 / 空串单条丢弃，好的保留；整个键读
//   不到 → 空覆盖（= 出厂键位，功能形同未上线），绝不让坏数据打断装载；
// * 保存先落库、成功后才 applyOverrides 进内存 + bump version + 发
//   `ottr://shortcuts-changed`（Rust 菜单重建触发器）——写失败行内报错、
//   内存不动，不出现「界面显示改了实际没改」的劈叉态；
// * 清空覆盖 = 恢复出厂键位（不存在「无触发的动作」死态）。
//
// `ottr://shortcuts-changed` 只是 mac 菜单重建的触发器：Rust 侧从 vault
// 现读覆盖（事件载荷不携带数据），事件丢失无害——下次启动/任意重建自愈。
import { create } from "zustand";
import { ACTIONS, applyOverrides, type ActionId } from "./registry";

const SETTINGS_KEY = "shortcuts.overrides";
export const SHORTCUTS_CHANGED_EVENT = "ottr://shortcuts-changed";

const ACTION_IDS = new Set<string>(ACTIONS.map((a) => a.id));

/** 装载面净化：未知动作 id / 非串值 / 空串单条丢弃（好的保留）。 */
export function sanitizeOverrides(raw: unknown): Partial<Record<ActionId, string>> {
  if (raw == null || typeof raw !== "object") return {};
  const out: Partial<Record<ActionId, string>> = {};
  for (const [id, accel] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACTION_IDS.has(id)) continue;
    if (typeof accel !== "string" || accel.trim() === "") continue;
    out[id as ActionId] = accel;
  }
  return out;
}

interface ShortcutStore {
  /** App 启动装载完成标记（装载前一律出厂键位）。 */
  loaded: boolean;
  overrides: Partial<Record<ActionId, string>>;
  /** 覆盖变化计数（提示组件订阅重渲染）。 */
  version: number;
  load: () => Promise<void>;
  /** 校验与持久化由调用方（设置页）先行；本方法只负责：落库 → 内存应用 → 广播。 */
  persistApply: (overrides: Partial<Record<ActionId, string>>) => Promise<void>;
  resetAll: () => Promise<void>;
}

export const useShortcutStore = create<ShortcutStore>()((set, get) => ({
  loaded: false,
  overrides: {},
  version: 0,

  load: async () => {
    if (get().loaded) return;
    try {
      const { vaultApi } = await import("../vault/api");
      const raw = await vaultApi.settings.get<unknown>(SETTINGS_KEY);
      const overrides = sanitizeOverrides(raw);
      applyOverrides(overrides);
      set({ loaded: true, overrides, version: get().version + 1 });
    } catch (e) {
      // 读不到（非 Tauri 环境/vault 未就绪）：出厂键位，功能形同未上线
      console.warn("[shortcuts] overrides load failed, using defaults:", e);
      applyOverrides({});
      set({ loaded: true, overrides: {}, version: get().version + 1 });
    }
  },

  persistApply: async (overrides) => {
    const { vaultApi } = await import("../vault/api");
    await vaultApi.settings.set(SETTINGS_KEY, overrides); // 先落库
    applyOverrides(overrides); // 成功后才进内存
    set({ overrides, version: get().version + 1 });
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit(SHORTCUTS_CHANGED_EVENT);
    } catch {
      // 非 Tauri 环境（纯浏览器 dev）：mac 菜单重建无从谈起，镜像已是持久化面
    }
  },

  resetAll: async () => {
    await get().persistApply({});
  },
}));

/** App 启动装载入口（init 链 await）：vault 覆盖 → 内存生效。 */
export async function initShortcutOverrides(): Promise<void> {
  await useShortcutStore.getState().load();
}
