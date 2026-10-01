// VaultInitGate（Task 16.5）：vault 后台初始化就绪门（前端面）。
//
// 背景：vault::init（含钥匙链 SecItem 访问）已移出 setup 主线程（T16 判别实验
// Exp10/14：主线程钥匙链访问在 macOS 27 + ad-hoc 重建签名场景把主窗 frame 归
// 零，见 task-16x5-report）。init 完成前 Rust 侧不 manage VaultState，首批 vault
// 命令（hosts_list 等）会被 Tauri 以 "state not managed" 拒绝——本门在 App 启动
// 时挡住这条路径：loading 态 → ottr://vault-ready → 放行启动链。T11 语义不变：
// 放行后照旧 vault_security_status → keyring 模式进主 UI / password 模式进
// LockScreen（VaultLockStore.init）。
//
// 消息丢失防护（事件可能先于监听器挂上——webview 加载慢于后台 init 时）：先订阅
// 事件、后查 `vault_init_status` 命令。命令与事件是同一 Rust 状态的两个读取面
// （Rust 侧 Ready 置位严格晚于 State manage、先于事件发出，见 vault.rs VaultInit
// 文档），两端夹逼无漏窗——查询见终态即用之，否则等事件，无需轮询。

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type VaultInitPhase = "initializing" | "ready" | "failed";

/** 事件名契约（Rust 侧 lib.rs vault-init 线程同源）。 */
export const VAULT_READY_EVENT = "ottr://vault-ready";
export const VAULT_INIT_FAILED_EVENT = "ottr://vault-init-failed";

/** Rust `vault_init_status` 返回同构（serde tag=status snake_case）。 */
export interface VaultInitStatusPayload {
  status: VaultInitPhase;
  error?: string;
}

interface VaultInitGate {
  phase: VaultInitPhase;
  /** 初始化失败消息（Rust 错误 Display；ready 时 null）。 */
  error: string | null;

  /** App 挂载时调用（仅 Tauri 运行时）：先挂事件监听再查一次状态。幂等。 */
  init: () => Promise<void>;
}

let unlisteners: (() => void)[] = [];

/** 终态收敛（事件与命令共用）：initializing 不动，等事件或后续查询。 */
function applyTerminal(s: VaultInitStatusPayload): void {
  if (s.status === "ready") {
    useVaultInitGate.setState({ phase: "ready", error: null });
  } else if (s.status === "failed") {
    useVaultInitGate.setState({
      phase: "failed",
      error: s.error ?? "vault init failed",
    });
  }
}

export const useVaultInitGate = create<VaultInitGate>((set) => ({
  phase: "initializing",
  error: null,

  init: async () => {
    try {
      // 幂等：重挂监听前先清理旧的。
      unlisteners.forEach((fn) => fn());
      unlisteners = [];
      unlisteners.push(
        await listen(VAULT_READY_EVENT, () => applyTerminal({ status: "ready" })),
      );
      unlisteners.push(
        await listen<string>(VAULT_INIT_FAILED_EVENT, (e) =>
          applyTerminal({ status: "failed", error: e.payload }),
        ),
      );
      // 后查命令兜住「事件已先行」的漏窗（监听挂上前的 terminal 事件收不到）。
      applyTerminal(await invoke<VaultInitStatusPayload>("vault_init_status"));
    } catch {
      // 非 Tauri 环境（纯浏览器 dev / vitest 无 mock 时）：门直通——调用方本就
      // 以 IS_TAURI 分流不进门，此处 catch 只是双保险降级（放行后命令失败由
      // 既有错误面承担，与 VaultLockStore 的降级口径一致）。
      set({ phase: "ready", error: null });
    }
  },
}));

/** 测试/SSR 清理：解除事件监听并复位状态（导出给组件测试用）。 */
export function resetVaultInitGateForTest(): void {
  unlisteners.forEach((fn) => fn());
  unlisteners = [];
  useVaultInitGate.setState({ phase: "initializing", error: null });
}
