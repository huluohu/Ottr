// modalStore（2026-10-14 用户裁定「全局弹窗机制一致」）：应用级弹窗唯一槽位。
//
// 规则：**同时最多一个弹窗**。open(id) = 新弹窗占用槽位并顶掉当前弹窗
// （无论它是谁——设置、⌘K、工具面板、主机密钥审批……一律先销毁再让位）；
// close(id) 仅在 id 仍持有槽位时清空（防被顶掉的旧弹窗的迟滞关闭回调把
// 新弹窗一起关掉）。
//
// 接入面（渲染门 = `active === id`，同步互斥）：
//   * App 根部九个弹窗（hostForm/importHosts/credentials/settings/sync/
//     palette/history/nl2cmd）——App 以 active===id 作渲染条件，
//     并保留「正常关闭播退场动画、被顶掉立即销毁」的口径（见 App 内
//     `owned(id) || activeModal === null` 门）；
//     store 的槽位认领上，且订阅外部弹窗开启即清槽（Sidebar 激活态不残留）；
//   * SessionStore.hostKeyAsk（Rust 事件驱动）——置问询即认领 hostKey 槽；
//   * McpApprovalDialog 审批队列、FilePanel 文件操作小对话框——事件/交互
//     点同步认领，渲染门 = 本地态 && 槽位在手。
//
// 门外（有意不进槽位）：LockScreen / VaultInitGateOverlay 是安全门卫遮罩
// （盖住一切、非用户弹窗）；各面板内右键菜单、侧栏弹层、Toast 是菜单/反馈面。
import { create } from "zustand";

/** 应用级弹窗 id（与各渲染门字面量逐字对齐）。 */
export type ModalId =
  | "hostForm"
  | "importHosts"
  | "exportHosts"
  | "credentials"
  | "settings"
  | "sync"
  | "palette"
  | "history"
  | "nl2cmd"
  | "hostKey"
  | "mcpApproval"
  | "filesDialog";

export interface ModalStore {
  /** 当前持有槽位的弹窗；null = 无弹窗。 */
  active: ModalId | null;
  /** 打开（顶掉当前）：新弹窗显示，其他弹窗先销毁。 */
  open: (id: ModalId) => void;
  /** 关闭（幂等）：仅当 id 仍持槽时清空。 */
  close: (id: ModalId) => void;
}

export const useModalStore = create<ModalStore>()((set, get) => ({
  active: null,
  open: (id) => set({ active: id }),
  close: (id) => {
    if (get().active === id) set({ active: null });
  },
}));
