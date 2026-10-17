// 工作区宽幅视图元数据（2026-10-16 IA 重构）：图标轨一级入口的五个库级视图
// ——页签栏镜像当前激活视图（label/icon/✕），批量执行保持原对话框语义不入列。
import type { ComponentType } from "react";
import type { MainView } from "./types";

/** 库级宽幅视图（图标轨一级入口；会话级子页签 monitor/plugins 不在此列）。 */
export type WorkspaceView = Extract<
  MainView,
  "overview" | "cron" | "notifications" | "forwards" | "jumpchains"
>;

export function workspaceViewOf(mainView: MainView): WorkspaceView | null {
  switch (mainView) {
    case "overview":
    case "cron":
    case "notifications":
    case "forwards":
    case "jumpchains":
      return mainView;
    default:
      return null;
  }
}

const GridIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.4" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.4" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.4" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1.4" />
  </svg>
);

const ClockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.4 1.6" strokeLinecap="round" />
  </svg>
);

const InboxIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 8.5h3l1 2h3l1-2h3" />
    <path d="M4.6 3.5h6.8l2.1 5v3.3c0 .9-.7 1.6-1.6 1.6H4.1c-.9 0-1.6-.7-1.6-1.6V8.5l2.1-5Z" />
  </svg>
);

const ShuffleIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4h2.6l6.8 8H14M14 4h-2.6l-2.2 2.6M2 12h2.6l2.2-2.6" />
  </svg>
);

const NetworkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.8" />
    <circle cx="12.5" cy="3.5" r="1.8" />
    <circle cx="12.5" cy="12.5" r="1.8" />
    <path d="M5.3 7.2 10.8 4.2M5.3 8.8l5.5 3" />
  </svg>
);

export const WORKSPACE_VIEW_META: Record<
  WorkspaceView,
  { labelKey: string; icon: ComponentType<{ width?: number; height?: number; "aria-hidden"?: true }> }
> = {
  overview: { labelKey: "overview.title", icon: GridIcon },
  cron: { labelKey: "nav.cron", icon: ClockIcon },
  notifications: { labelKey: "nav.notifications", icon: InboxIcon },
  forwards: { labelKey: "forward.title", icon: ShuffleIcon },
  jumpchains: { labelKey: "jump.title", icon: NetworkIcon },
};
