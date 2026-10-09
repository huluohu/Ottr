import { Component, type ReactNode } from "react";

/**
 * 设置页内嵌面板的错误边界（2026-10-09 设置页重构）：告警/MCP 等面板嵌入
 * 设置对话框后，单个面板的异常只降级本面板，不沿渲染树掀掉整个设置页。
 * 后端在锁定态/测试态返回异常数据时曾出现此类上抛（AlertSettings channels
 * undefined 实测）。
 */
export class PaneErrorBoundary extends Component<
  { children: ReactNode; label: string; fallbackText: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[settings-pane] ${this.props.label}:`, error);
  }

  render() {
    if (this.state.error) {
      return <p className="form-error">{this.props.fallbackText}</p>;
    }
    return this.props.children;
  }
}
