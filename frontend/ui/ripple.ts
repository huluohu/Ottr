// 涟漪反馈（2026-10-16 视觉重设计 M2「造浪」）：水品牌的按压反馈，叠加既有
// scale 按压态。三类目标与 00-base.css 的 :is() 选择器同源同词——改一处必改两处：
//   .btn-accent             主按钮（涟漪 = on-accent 色，实底上的白/墨随主题）
//   .host-row               主机树行（涟漪 = accent 半透明）
//   .sidebar-flyout button  侧栏/图标轨弹层行
// 机制：document 级 pointerdown 委托——命中目标即写 --ripple-x/y（触点坐标，
// 圆心取真实触点）并重放 .rippling 类（remove → 强制 reflow → add，同类内
// 再点也从触点重播）；CSS ::after 播一圈涟漪后自动归零。
// 弱动效偏好：CSS @media (prefers-reduced-motion: reduce) 下 ::after 整体
// display:none——涟漪自动消失，无需 JS 判定。
const RIPPLE_TARGET = ".btn-accent, .host-row, .sidebar-flyout button";

export function initRipple(): () => void {
  const onDown = (e: PointerEvent) => {
    const host = (e.target as Element | null)?.closest(RIPPLE_TARGET);
    if (!(host instanceof HTMLElement)) return;
    const rect = host.getBoundingClientRect();
    host.style.setProperty("--ripple-x", `${e.clientX - rect.left}px`);
    host.style.setProperty("--ripple-y", `${e.clientY - rect.top}px`);
    host.classList.remove("rippling");
    void host.offsetWidth;
    host.classList.add("rippling");
  };
  document.addEventListener("pointerdown", onDown);
  return () => document.removeEventListener("pointerdown", onDown);
}
