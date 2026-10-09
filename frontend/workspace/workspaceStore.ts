// workspaceStore（UI 批次一 Task 2；2026-10-09 dock 多页签改造）：工作区视图
// 状态机——主区五视图 + 右侧 dock 多页签。HomeLayout 原有的视图/面板 setState
// 收口到这里；工具菜单条目改调本 store。
//
// 【终端常驻不变量】本 store 是纯视图状态：任何动作只写 mainView/dockTabs/
// dockActive，**永不触碰 SessionStore**。终端组件的保留由渲染侧执行
// （MainArea：非 terminal 视图时终端 DOM 以 visibility 隐藏常驻）。
//
// 【托盘关窗不影响】zustand store 挂在模块作用域、活在 webview 生命周期里；
// close-to-tray 只是隐藏窗口，store 状态原样保留，重开窗口即见原工作区。
//
// 【dock 多页签语义（2026-10-09 用户裁定「根治互相覆盖」）】面板以页签共存
// （dockTabs 保序、dockActive 指向活动页）：openDock 打开（新则追加）并激活；
// 切换页签不卸载面板（keep-alive，隐藏由渲染层执行）、不互相关闭——旧「单槽
// openDock 换值即替换」语义废除。closeTab 移除单页签并把活动权交给右邻
// （无右邻则最右）。monitor/plugins 仍是终端右栏自管侧栏（不经 dock 壳），
// 本 store 不接受其值（与旧版「预留同一单槽 API」不同，多页签无此需要）。
import { create } from "zustand";
import type { MainView, ToolDockPanel } from "./types";

export interface WorkspaceState {
  /** 主区视图；terminal 恒为默认（冷启动/恢复都落在终端）。 */
  mainView: MainView;
  /** 已打开的 dock 页签（保序；打开过即保留，切换/关闭互不影响）。 */
  dockTabs: ToolDockPanel[];
  /** 当前活动的 dock 页签；null = dock 关闭。 */
  dockActive: ToolDockPanel | null;
  /** 切主区视图（幂等；纯状态迁移，无副作用）。 */
  openMainView: (v: MainView) => void;
  /** 打开 dock 页签（已开则仅激活，新则追加到末尾并激活）。 */
  openDock: (p: ToolDockPanel) => void;
  /** 关闭单页签；若关的是活动页，活动权移交右邻（无右邻则最左/最右兜底）。 */
  closeTab: (p: ToolDockPanel) => void;
  /** 关闭全部页签（dock 整体收起；页签清空）。 */
  closeDock: () => void;
  /** 同值关、异值开/激活（侧栏导航行的开关二态语义）。 */
  toggleDock: (p: ToolDockPanel) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mainView: "terminal",
  dockTabs: [],
  dockActive: null,
  openMainView: (v) => set({ mainView: v }),
  openDock: (p) =>
    set((s) => ({
      dockTabs: s.dockTabs.includes(p) ? s.dockTabs : [...s.dockTabs, p],
      dockActive: p,
    })),
  closeTab: (p) => {
    const { dockTabs, dockActive } = get();
    const idx = dockTabs.indexOf(p);
    if (idx === -1) return;
    const tabs = dockTabs.filter((t) => t !== p);
    const active =
      dockActive === p ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : dockActive;
    set({ dockTabs: tabs, dockActive: active });
  },
  closeDock: () => set({ dockTabs: [], dockActive: null }),
  toggleDock: (p) => (get().dockActive === p ? get().closeTab(p) : get().openDock(p)),
}));
