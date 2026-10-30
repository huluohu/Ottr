// 双击缩放意图判定单测（2026-10-29 用户报障：「先最大化、又自动弹回默认尺寸」）。
//
// 场景矩阵（macOS：系统 performWindowDragWithEvent 自带双击缩放语义 + 我们
// 自己的 JS 处理可能同时动作）：
//   ① 只有系统缩放（我们那侧看到已是目标态）→ 不重复动作；
//   ② 只有我们处理（系统没缩放）→ 我们显式缩放到目标态；
//   ③ 两侧都动作 → 靠「当前是否已是目标态」判定，只让一侧生效。
import { describe, expect, it } from "vitest";
import { resolveDoubleClickZoom } from "./zoomIntent";

describe("resolveDoubleClickZoom（拖拽面双击缩放）", () => {
  it("未缩放 + 系统已缩放（now=true）→ 已是目标态，我们不再动作", () => {
    expect(resolveDoubleClickZoom(false, true)).toEqual({ target: true, act: false });
  });

  it("未缩放 + 系统没缩放（now=false）→ 我们显式最大化", () => {
    expect(resolveDoubleClickZoom(false, false)).toEqual({ target: true, act: true });
  });

  it("已缩放 + 系统已还原（now=false）→ 已是目标态，我们不再动作", () => {
    expect(resolveDoubleClickZoom(true, false)).toEqual({ target: false, act: false });
  });

  it("已缩放 + 系统没还原（now=true）→ 我们显式还原", () => {
    expect(resolveDoubleClickZoom(true, true)).toEqual({ target: false, act: true });
  });

  it("按下前状态未知 → 退回旧的 toggle 语义（必动作）", () => {
    expect(resolveDoubleClickZoom(null, false)).toEqual({ target: true, act: true });
    expect(resolveDoubleClickZoom(null, true)).toEqual({ target: false, act: true });
  });
});
