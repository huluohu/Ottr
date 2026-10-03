// VaultLockStore（T11，A7）：vault 解锁状态机（前端面）。
//
// 语义（与 Rust 侧一一对应，矩阵见 task-11-report）：
//   * keyring 模式：无锁概念——status 查回 mode=keyring & locked=false，恒 unlocked；
//   * password 模式：open 即锁定（启动 / 自动锁定 / 手动锁定）→ LockScreen →
//     unlock_with_password；
//   * 事件贯通：ottr://vault-locked / ottr://vault-unlocked 由 Rust 侧统一发
//     （自动锁定、手动锁定、解锁、升级成功），本 store 订阅后置状态——多入口
//     触发单一收口，前端不自行推演。
//
// phase=boot：status 查询进行中（首帧，App 不渲染遮罩防闪烁）。

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { vaultApi } from "../vault/api";
import { useVaultStore } from "../vault/store";

export type LockPhase = "boot" | "locked" | "unlocked";
export type VaultMode = "keyring" | "password";

/** 事件名契约（Rust 侧 vault.rs / security.rs 同源）。 */
export const VAULT_LOCKED_EVENT = "ottr://vault-locked";
export const VAULT_UNLOCKED_EVENT = "ottr://vault-unlocked";

// T4 顺带修（T3 评审转办）：解锁后 vault 数据重拉——锁定期间启动链的
// refresh 被 Rust Locked 门卫拒绝（store.error 挂横幅 + hosts 空），解锁后
// 无人再拉，用户可困死在「主机树空 / 加载失败横幅」。在解锁的两个收口点
// （Rust 事件 + unlock 成功兜底）直接驱动 vault 域刷新。
//
// 【跨域实现说明】security 域 → hosts 域为单向依赖（vault/store 不反向
// import security，无环）；经 zustand getState() 直调动作而非经 React 组件
// ——解锁收口在 store 事件回调里，不依赖任何组件挂载时序。fire-and-forget：
// 刷新失败由 useVaultStore.error 横幅面呈现（用户手动重试路径仍在），不反噬
// 解锁主流程。事件与 unlock 兜底可能双触发 → refresh 幂等（四张 list 重拉
// 一次，无副作用），不为去重加状态。
function refreshVaultAfterUnlock(): void {
  void useVaultStore.getState().refresh().catch(() => {
    // 失败留在 useVaultStore.error（主区横幅），此处静默不打断解锁
  });
}

interface VaultLockStore {
  phase: LockPhase;
  mode: VaultMode | null;
  /** 解锁失败消息（LockScreen 红字；成功/重试时清）。 */
  error: string | null;
  /** 解锁命令在途（按钮转圈防重复提交）。 */
  unlocking: boolean;

  /** App 挂载时调用：查 status + 订阅事件。幂等（重复调用重挂监听前先清理）。 */
  init: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  /** 手动锁定（password 模式；keyring 模式 Rust 侧 no-op）。 */
  lock: () => Promise<void>;
}

let unlisteners: (() => void)[] = [];

export const useVaultLockStore = create<VaultLockStore>((set) => ({
  phase: "boot",
  mode: null,
  error: null,
  unlocking: false,

  init: async () => {
    try {
      const status = await vaultApi.security.status();
      set({
        mode: status.mode,
        phase: status.locked ? "locked" : "unlocked",
        error: null,
      });
    } catch {
      // status 查询失败（后端不可达等）：按锁定收敛——遮罩优于裸奔。
      set({ phase: "locked", error: null });
    }
    // 事件订阅（幂等：先清理旧监听）。
    unlisteners.forEach((fn) => fn());
    unlisteners = [];
    try {
      unlisteners.push(
        await listen(VAULT_LOCKED_EVENT, () => {
          set({ phase: "locked", error: null });
        }),
      );
      unlisteners.push(
        await listen(VAULT_UNLOCKED_EVENT, () => {
          set({ phase: "unlocked", error: null });
          // T4 顺带修：解锁（含自动升级/多入口）单一收口即重拉 vault 数据。
          refreshVaultAfterUnlock();
        }),
      );
    } catch {
      // 非 Tauri 环境（纯浏览器 dev / vitest 无 mock 时）：静默降级，
      // 状态机仍由 init/unlock/lock 动作驱动。
    }
  },

  unlock: async (password: string) => {
    set({ unlocking: true, error: null });
    try {
      await vaultApi.security.unlock(password);
      // 状态以 Rust 侧 ottr://vault-unlocked 事件为准；事件丢失兜底在此直置。
      set({ phase: "unlocked", unlocking: false, error: null });
      // T4 顺带修：兜底路径同享解锁后重拉（事件照常到达时 refresh 幂等）。
      refreshVaultAfterUnlock();
      return true;
    } catch (e) {
      set({
        unlocking: false,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  },

  lock: async () => {
    try {
      await vaultApi.security.lock();
    } catch {
      // 命令失败不阻塞本地状态翻转（keyring 模式 Rust no-op 也成功）。
    }
    set({ phase: "locked", error: null });
  },
}));

/** 测试/SSR 清理：解除事件监听并复位状态（导出给组件测试用）。 */
export function resetVaultLockStoreForTest(): void {
  unlisteners.forEach((fn) => fn());
  unlisteners = [];
  useVaultLockStore.setState({
    phase: "boot",
    mode: null,
    error: null,
    unlocking: false,
  });
}
