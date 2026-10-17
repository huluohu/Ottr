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
  /** 关闭当前工作区宽幅视图（页签 ✕，2026-10-16 IA 重构）：总览撤销置顶
   * 标签，其余宽幅视图切回终端（内容状态保留，重开即恢复）。 */
  closeMainView: () => set({ overviewOpen: false, mainView: "terminal" }),
}));

interface WorkspaceState {
  /** 主区视图；terminal 恒为默认。 */
  mainView: MainView;
  /** 总览置顶标签是否打开（launch 默认落地；页签栏镜像 mainView）。 */
  overviewOpen: boolean;
  /** 切主区视图（幂等；纯状态迁移，无副作用）。 */
  openMainView: (v: MainView) => void;
  /** 打开总览置顶标签并激活（幂等）。 */
  openOverview: () => void;
  /** 关闭总览置顶标签（标签 ✕）。 */
  closeOverview: () => void;
  /** 关闭当前工作区宽幅视图（页签 ✕；总览走 closeOverview 语义）。 */
  closeMainView: () => void;
}

// 工具面板弹框（toolDialog 单槽）已于 2026-10-16 IA 重构退役：定时任务/
// 通知中心/端口转发/跳板链升主区宽幅视图，监控/插件转会话子页签，告警归
// 设置分区——历史语义见 git（本文件 v1.0.1 版本）。
