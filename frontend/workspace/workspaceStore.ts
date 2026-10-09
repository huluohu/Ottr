// workspaceStore（UI 批次一 Task 2）：工作区视图状态机——主区五视图 + 右侧
// dock 单槽。HomeLayout 原有的视图/面板 setState（filesOpen/procsOpen/
// overviewOpen/batchOpen/forwardsOpen/jumpChainsOpen/cronOpen/mcpOpen/
// alertSettingsOpen）收口到这里；工具菜单条目（原就地 setState 打开器，本就
// 不经 ActionId——注册表面零变化，T14 守卫测试不动）改调本 store。
//
// 【终端常驻不变量】本 store 是纯视图状态：任何动作只写 mainView/dockPanel
// 两个字段，**永不触碰 SessionStore**。终端组件的保留由渲染侧执行
// （MainArea：非 terminal 视图时终端 DOM 以 visibility 隐藏常驻，沿 Task 10
// 文件视图先例——xterm 缓冲/滚动回看不丢，运行中会话不卸载）。切走再切回，
// 会话与终端缓冲原样恢复。
//
// 【托盘关窗不影响】zustand store 挂在模块作用域、活在 webview 生命周期里；
// close-to-tray 只是隐藏窗口，store 状态（含视图位置、开着的 dock 面板）原样
// 保留，重开窗口即见原工作区。
//
// 【互斥语义】见 types.ts 头注（mainView 单值互斥；dockPanel 单槽替换；
// monitor/plugins 并存语义沿现状）。
import { create } from "zustand";
import type { DockPanel, MainView } from "./types";

export interface WorkspaceState {
  /** 主区视图；terminal 恒为默认（冷启动/恢复都落在终端）。 */
  mainView: MainView;
  /** 右侧 dock 当前面板；null = 关闭。同时至多一个（openDock 换值即替换）。 */
  dockPanel: DockPanel | null;
  /** 切主区视图（幂等；纯状态迁移，无副作用）。 */
  openMainView: (v: MainView) => void;
  /** 打开 dock 面板（替换已开面板——单槽互斥）。 */
  openDock: (p: DockPanel) => void;
  /** 关闭 dock（幂等）。 */
  closeDock: () => void;
  /** 同值关、异值换（工具菜单/未来 dock 栏按钮的开关二态语义）。 */
  toggleDock: (p: DockPanel) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mainView: "terminal",
  dockPanel: null,
  openMainView: (v) => set({ mainView: v }),
  openDock: (p) => set({ dockPanel: p }),
  closeDock: () => set({ dockPanel: null }),
  toggleDock: (p) => set({ dockPanel: get().dockPanel === p ? null : p }),
}));
