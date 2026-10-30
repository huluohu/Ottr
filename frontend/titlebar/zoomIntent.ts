// 标题栏拖拽面「双击缩放」的意图判定（2026-10-29 用户报障：「双击左边栏顶部
// 最大化，有时候会出现先最大化、然后又自动恢复默认尺寸的情况」）。
//
// 机理：macOS 上拖拽区走 Tauri 的 start_dragging → tao 的
// `performWindowDragWithEvent:`（tao/src/platform_impl/macos/window.rs 的
// send_event：LeftMouseDown 时调用）。**该 API 保留系统「双击标题栏缩放」
// 语义**——系统那侧在第二次按下时就可能已经缩放过；我们再叠一层
// `toggleMaximize()`，两侧动作方向相反时互相抵消 = 「先放大 → 又弹回」。
//
// 判定：两侧对「目标态」的结论其实一致（系统是 toggle，我们要的也是
// toggle 到另一态）——所以只需看**当前状态是否已经是目标态**：
//   · 已是目标态 → 系统（或我们）已经处理过 → 不重复动作；
//   · 仍是原态   → 没人处理 → 我们显式 max/unmax 到目标态。
//
// 纯函数（可测）：preMax = 双击前（第一次按下时抓的）最大化状态；now =
// 判定时刻的实际最大化状态。
export interface ZoomDecision {
  /** 目标态：true = 最大化。 */
  target: boolean;
  /** 是否需要我们动手（false = 已被系统那侧处理，别重复动作）。 */
  act: boolean;
}

export function resolveDoubleClickZoom(preMax: boolean | null, now: boolean): ZoomDecision {
  // preMax 未知（没抓到按下时的状态）→ 退回旧的 toggle 语义（target = !now，
  // 必然 act = true）。
  const target = preMax === null ? !now : !preMax;
  return { target, act: now !== target };
}
