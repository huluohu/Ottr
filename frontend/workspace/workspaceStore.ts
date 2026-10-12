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
import { create } from "zustand";
import type { MainView, ToolDockPanel } from "./types";

export interface WorkspaceState {
  /** 主区视图；terminal 恒为默认（冷启动/恢复都落在终端）。 */
  mainView: MainView;
  /** 当前打开的工具面板弹框；null = 无。 */
  toolDialog: ToolDockPanel | null;
  /** 切主区视图（幂等；纯状态迁移，无副作用）。 */
  openMainView: (v: MainView) => void;
  /** 打开工具面板弹框（幂等；异值即替换当前弹框）。 */
  openToolDialog: (p: ToolDockPanel) => void;
  /** 关闭当前弹框（幂等；无弹框时 no-op）。 */
  closeToolDialog: () => void;
  /** 同值关、异值开/换（侧栏导航行的开关二态语义）。 */
  toggleToolDialog: (p: ToolDockPanel) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mainView: "terminal",
  toolDialog: null,
  openMainView: (v) => set({ mainView: v }),
  openToolDialog: (p) => set({ toolDialog: p }),
  closeToolDialog: () => set({ toolDialog: null }),
  toggleToolDialog: (p) => set({ toolDialog: get().toolDialog === p ? null : p }),
}));
