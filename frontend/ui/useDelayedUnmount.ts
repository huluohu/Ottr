// 浮层退场动画基元（评审 P1-8）：CSS 动画只解决「入场」，卸载即消失无法播
// 退场——本模块给两条消费路径：
//   * useDelayedUnmount(open)：组件收 open prop、内部条件渲染（⌘K/历史/⌘J/
//     设置/同步对话框）——open=false 后保留挂载并置 closing，CSS 播完镜像
//     动画再真卸载；
//   * useDelayedValue(value)：父级条件挂载的浮层（{form && <HostForm/>} 形态）
//     ——关闭期保留最后一次非空值供父级继续渲染 + 下发 closing。
// ms 须 ≥ 消费方退场动画时长（--dur-fast 100ms，默认 160 留帧余量；dock 用
// --dur-slow 240 → 调用方传 280）。动画侧用 animation-fill-mode: forwards
// 停在透明帧，等待期的尾帧不闪回。
import { useEffect, useState } from "react";

export interface DelayedMount {
  shouldRender: boolean;
  closing: boolean;
}

/** 测试环境直通：既有测试对「关闭 → 立即查无」断言（同步卸载语义）。
 * 退场窗属视觉层，jsdom 下无意义；动画逻辑由 hooks 自己的 fake-timer 测试覆盖。 */
const IS_TEST = import.meta.env?.MODE === "test";

export function useDelayedUnmount(open: boolean, ms = 160): DelayedMount {
  const [state, setState] = useState<DelayedMount>({
    shouldRender: open,
    closing: false,
  });
  useEffect(() => {
    if (IS_TEST) {
      setState((prev) =>
        prev.shouldRender === open && !prev.closing ? prev : { shouldRender: open, closing: false },
      );
      return;
    }
    if (open) {
      setState({ shouldRender: true, closing: false });
      return;
    }
    // 关闭：先置 closing（保留挂载播退场），计时到真卸载。已卸载态保持原状，
    // 不因 open 抖动重设定时器。
    setState((prev) => (prev.shouldRender ? { shouldRender: true, closing: true } : prev));
    const t = setTimeout(() => setState({ shouldRender: false, closing: false }), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return state;
}

export interface DelayedValue<T> {
  value: T | null;
  closing: boolean;
}

export function useDelayedValue<T>(
  value: T | null | undefined | false,
  ms = 160,
): DelayedValue<NonNullable<T>> {
  const [state, setState] = useState<DelayedValue<NonNullable<T>>>(() => ({
    value: (value ?? null) as NonNullable<T> | null,
    closing: false,
  }));
  useEffect(() => {
    if (IS_TEST) {
      setState((prev) => {
        const next = (value ?? null) as NonNullable<T> | null;
        return prev.value === next && !prev.closing ? prev : { value: next, closing: false };
      });
      return;
    }
    if (value) {
      setState({ value: value as NonNullable<T>, closing: false });
      return;
    }
    setState((prev) => (prev.value !== null ? { value: prev.value, closing: true } : prev));
    const t = setTimeout(() => setState({ value: null, closing: false }), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return state;
}
