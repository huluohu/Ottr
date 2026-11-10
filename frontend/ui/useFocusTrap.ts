// 弹窗焦点陷阱（2026-11-01 UI 审计 P1-4）。
//
// 此前所有弹窗只声明 `aria-modal="true"`，**没有任何实现**：键盘 Tab 会从弹窗
// 一路走到背后的图标轨、主机树、终端（锁屏时甚至能 Tab 进仍可交互的应用）。
//
// 实现取**全局**口径而非逐个弹窗接线：`useGlobalFocusTrap` 挂在 App 根，
// 监听所有带 `aria-modal="true"` 的弹窗（role=dialog / role=alertdialog 都
// 覆盖）——一处实现即覆盖全部弹窗，逐个组件加 ref 既漏又难维护。
//
// 三件事：
//   1) 弹窗出现时把焦点送进去（首个可聚焦元素；没有则容器本身）；
//   2) Tab / Shift+Tab 在最上层弹窗内循环（焦点跑到弹窗外时拉回来）；
//   3) 弹窗消失时把焦点还给触发者（触发者可能已卸载 → 判存在再聚焦）。
//
// 可见性判定不依赖布局（jsdom 无 offsetParent）：只排 hidden / aria-hidden。
import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** 弹窗内可聚焦元素（顺序 = DOM 顺序）。 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * @param open 弹窗是否打开（false 时不做任何事）
 * @param containerRef 弹窗内容容器（focus trap 的作用域）
 */
export function useFocusTrap(open: boolean, containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    // 触发者：关闭时焦点归位。
    const previous = document.activeElement as HTMLElement | null;

    // 打开即聚焦（首个可聚焦元素；一个都没有则容器本身兜底）。
    const first = focusableWithin(container)[0];
    if (first) {
      first.focus();
    } else {
      if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
      container.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      if (idx === -1) {
        // 焦点在弹窗外（鼠标点到背景等）→ 拉回第一个。
        e.preventDefault();
        items[0].focus();
        return;
      }
      const next = e.shiftKey ? idx - 1 : idx + 1;
      if (next < 0 || next >= items.length) {
        e.preventDefault();
        items[e.shiftKey ? items.length - 1 : 0].focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open, containerRef]);
}

/**
 * 当前最上层弹窗（带 aria-modal 的元素中 z 序最高者）。
 *
 * 2026-11-10 审计修正：此前取「DOM 顺序最后一个」，并假设「渲染最晚 = 层级
 * 最高」——但锁屏（--z-lock 200）在 App.tsx 里排在命令面板/历史搜索
 * （--z-overlay 50）**之前**渲染：自动锁定瞬间若历史搜索面板还开着，焦点
 * 陷阱会把焦点锁进那个被锁屏盖住、看不见的面板里（Tab 在暗处打转、锁屏
 * 密码框拿不到焦点）。现按**实际 z-index**取最上层（读 computed style，
 * 同值时 DOM 靠后者为准）。
 */
function topModal(): HTMLElement | null {
  const list = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
  if (list.length === 0) return null;
  const zOf = (el: HTMLElement): number => {
    const raw = window.getComputedStyle(el).zIndex;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  let best = list[0];
  let bestZ = zOf(best);
  for (const el of list.slice(1)) {
    const z = zOf(el);
    // 同 z 时取 DOM 更靠后者（后来渲染的盖在上面）
    if (z >= bestZ) {
      best = el;
      bestZ = z;
    }
  }
  return best;
}

/**
 * 全局焦点陷阱（App 根挂一次即覆盖全部弹窗）。
 *
 * 弹窗出现/消失靠 MutationObserver 感知（弹窗都 portal 到 body 子树），
 * 因此新增的弹窗不需要改一行组件代码。
 */
export function useGlobalFocusTrap(): void {
  useEffect(() => {
    const triggers = new Map<HTMLElement, HTMLElement | null>();
    const known = new Set<HTMLElement>();

    const focusFirst = (dialog: HTMLElement) => {
      const items = focusableWithin(dialog);
      if (items.length) {
        items[0].focus();
      } else {
        if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
        dialog.focus();
      }
    };

    const sync = () => {
      const current = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'));
      const currentSet = new Set(current);
      // 消失的弹窗：焦点归位（触发者可能已卸载 → 判存在再聚焦）。
      for (const d of known) {
        if (!currentSet.has(d)) {
          const trigger = triggers.get(d);
          triggers.delete(d);
          known.delete(d);
          if (trigger && document.contains(trigger)) trigger.focus();
        }
      }
      // 新出现的弹窗：记住触发者 + 聚焦进去（先尝试即时聚焦，并在 rAF 兜底
      // 防异步挂载子节点）。
      for (const d of current) {
        if (!known.has(d)) {
          known.add(d);
          triggers.set(d, document.activeElement as HTMLElement | null);
          focusFirst(d);
          requestAnimationFrame(() => {
            if (document.contains(d) && !d.contains(document.activeElement)) {
              focusFirst(d);
            }
          });
        }
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const dialog = topModal();
      if (!dialog) return;
      const items = focusableWithin(dialog);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      if (idx === -1) {
        // 焦点在弹窗外 → 拉回第一个（而不是继续 Tab 到背景）。
        e.preventDefault();
        items[0].focus();
        return;
      }
      const next = e.shiftKey ? idx - 1 : idx + 1;
      if (next < 0 || next >= items.length) {
        e.preventDefault();
        items[e.shiftKey ? items.length - 1 : 0].focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
