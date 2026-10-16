// workspaceStore（UI 批次一 Task 2；2026-10-16 IA 重构）：主区视图状态机。
// 【终端常驻不变量】纯视图状态，任何动作只写 mainView——终端组件的保留由
// 渲染侧执行（MainArea：非 terminal 视图时终端 DOM visibility 隐藏常驻）。
// 【托盘关窗不影响】zustand store 挂在模块作用域、活在 webview 生命周期里；
// close-to-tray 只是隐藏窗口，store 状态原样保留，重开窗口即见原工作区。
// 【IA 重构】工具弹框（toolDialog 单槽）退役：定时任务/通知中心/端口转发/
// 跳板链升主区宽幅视图，监控/插件转会话子页签，告警归设置分区——本 store
// 不再持有工具弹框状态（历代：单槽 dock → 多页签 dock → 弹框 → 视图）。
import { create } from "zustand";
import type { MainView } from "./types";

export { MAIN_VIEWS } from "./types";

export interface WorkspaceState {
  /** 主区视图；terminal 恒为默认（冷启动/恢复都落在终端）。 */
  mainView: MainView;
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
      }

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  mainView: "terminal",
  overviewOpen: false,
  openMainView: (v) => set({ mainView: v }),
  openOverview: () => set({ overviewOpen: true, mainView: "overview" }),
  closeOverview: () =>
    set((st) => ({
      overviewOpen: false,
      mainView: st.mainView === "overview" ? "terminal" : st.mainView,
    })),
}));

