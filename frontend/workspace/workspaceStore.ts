// workspaceStore（UI 批次一 Task 2）：工作区视图状态机——主区五视图 + 工具
// 面板弹框槽。HomeLayout 原有的视图/面板 setState 收口到这里；工具菜单条目
// 改调本 store。
//
// 【终端常驻不变量】本 store 是纯视图状态：任何动作只写 mainView/toolDialog，
// **永不触碰 SessionStore**。终端组件的保留由渲染侧执行
// （MainArea：非 terminal 视图时终端 DOM 以 visibility 隐藏常驻）。
//
// 【托盘关窗不影响】zustand store 挂在模块作用域、活在 webview 生命周期里；
// close-to-tray 只是隐藏窗口，store 状态原样保留，重开窗口即见原工作区。
//
// 【工具面板弹框语义（2026-10-12 用户裁定：dock 侧栏退役）】六工具面板
// （forwards/jumpchains/cron/alerts/mcp/notifications）统一以模态弹框呈现，
// 一次一个（toolDialog 单槽，异值打开即替换）。历代语义沿革：单槽 dock →
// 多页签 dock（2026-10-09「根治互相覆盖」）→ 弹框。弹框不参与 flex 布局，
// 终端永不被挤压；keep-alive 随页签一并退役——配置保存即落库、转发轮询
// 关闭即停（Rust 侧 ForwardManager 状态无损）。monitor/plugins 仍是终端
// 右栏自管侧栏，不经本槽。
//
// 【全局弹窗唯一槽（2026-10-14 用户裁定）】本 store 的 toolDialog 开/关动作
// 同步认领/释放 ui/modalStore 的 "toolDialog" 槽位；并订阅全局槽——任何其他
// 弹窗开启即清空 toolDialog（工具弹框被顶掉 = 销毁，侧栏激活态不残留）。
// 单向依赖（本模块 → modalStore），无环。
import { create } from "zustand";
import { useModalStore } from "../ui/modalStore";
import type { MainView, ToolDockPanel } from "./types";

export interface WorkspaceState {
  /** 主区视图；terminal 恒为默认（冷启动/恢复都落在终端）。 */
  mainView: MainView;
  /** 当前打开的工具面板弹框；null = 无。 */
  toolDialog: ToolDockPanel | null;
  /** 总览置顶标签是否打开（2026-10-16 用户需求：总览标签化、固定第一位）。
   * 标签是纯渲染层概念（TabBar 固定首项），不进 SessionStore——会话计数/
   * openHostIds 持久化/终端挂载等「tab=主机会话」假设全部不受扰。会话级
   * 状态：不持久化，重启后由启动默认落地逻辑按需重开。 */
  overviewOpen: boolean;
  /** 切主区视图（幂等；纯状态迁移，无副作用）。 */
  openMainView: (v: MainView) => void;
  /** 打开总览置顶标签并激活（幂等）。侧栏导航/菜单/启动落地统一走这里——
   * 「显示总览」与「总览标签在场」由同一动作保证不分叉。 */
  openOverview: () => void;
  /** 关闭总览置顶标签（标签 ✕）；正显示总览时切回终端视图（零会话即欢迎页），
   * 显示其他视图时只关标签不动视图（关闭 ≠ 跳走）。 */
  closeOverview: () => void;
  /** 打开工具面板弹框（幂等；异值即替换当前弹框，同时认领全局唯一槽）。 */
  openToolDialog: (p: ToolDockPanel) => void;
  /** 关闭当前弹框（幂等；无弹框时 no-op）。 */
  closeToolDialog: () => void;
  /** 同值关、异值开/换（侧栏导航行的开关二态语义）。 */
  toggleToolDialog: (p: ToolDockPanel) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mainView: "terminal",
  toolDialog: null,
  overviewOpen: false,
  openMainView: (v) => set({ mainView: v }),
  openOverview: () => set({ overviewOpen: true, mainView: "overview" }),
  closeOverview: () =>
    set((st) => ({
      overviewOpen: false,
      mainView: st.mainView === "overview" ? "terminal" : st.mainView,
    })),
  openToolDialog: (p) => {
    set({ toolDialog: p });
    useModalStore.getState().open("toolDialog");
  },
  closeToolDialog: () => {
    set({ toolDialog: null });
    useModalStore.getState().close("toolDialog");
  },
  toggleToolDialog: (p) => {
    if (get().toolDialog === p && useModalStore.getState().active === "toolDialog") {
      get().closeToolDialog();
    } else {
      get().openToolDialog(p);
    }
  },
}));

// 被顶掉即销毁：其他弹窗认领全局槽时清空 toolDialog（纯状态对齐，无副作用；
// ToolDialog 的渲染门另看全局槽，这里清值保证 Sidebar 激活高亮同步熄灭）。
useModalStore.subscribe((state) => {
  if (state.active !== "toolDialog" && useWorkspaceStore.getState().toolDialog !== null) {
    useWorkspaceStore.setState({ toolDialog: null });
  }
});
