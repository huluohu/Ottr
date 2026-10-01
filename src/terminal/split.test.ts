// split.ts 纯函数 TDD（Task 8 Step 1）：嵌套分裂、关闭回收、布局切分、
// 分隔条命中面与拖拽路径。全部无 React/DOM，直调纯函数。
import { describe, expect, it } from "vitest";
import {
  MIN_RATIO,
  SPLIT_GAP,
  closeLeaf,
  dividers,
  layout,
  leaf,
  leaves,
  setRatioAt,
  splitLeaf,
  subtreeRect,
  type PaneTree,
  type Rect,
} from "./split";

const BOUNDS: Rect = { x: 0, y: 0, w: 1000, h: 500 };

function area(r: Rect): number {
  return r.w * r.h;
}

/** 矩形两两不重叠（允许间隙）。 */
function assertNoOverlap(rects: Rect[]) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const separated =
        a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;
      expect(separated, `${JSON.stringify(a)} 与 ${JSON.stringify(b)} 重叠`).toBe(true);
    }
  }
}

describe("splitLeaf（分裂）", () => {
  it("叶上分裂生成 split 节点，新叶在 second", () => {
    const t = splitLeaf(leaf("a"), "a", "b", "row");
    expect(t.kind).toBe("split");
    if (t.kind !== "split") return;
    expect(t.dir).toBe("row");
    expect(t.ratio).toBe(0.5);
    expect(leaves(t)).toEqual(["a", "b"]);
  });

  it("嵌套：对子树中的叶再分裂（右侧再上下分）", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "column");
    expect(leaves(t)).toEqual(["a", "b", "c"]);
    const split = t as Extract<PaneTree, { kind: "split" }>;
    expect(split.second.kind).toBe("split");
  });

  it("目标叶不存在 → 原树原样返回（不可变，不误分裂）", () => {
    const t = splitLeaf(leaf("a"), "missing", "b", "row");
    expect(t).toEqual(leaf("a"));
    const nested = splitLeaf(splitLeaf(leaf("a"), "a", "b", "row"), "missing", "c", "column");
    expect(leaves(nested)).toEqual(["a", "b"]);
  });

  it("纯函数：不改传入树", () => {
    const before = leaf("a");
    splitLeaf(before, "a", "b", "row");
    expect(before).toEqual(leaf("a"));
  });
});

describe("closeLeaf（关闭回收）", () => {
  it("关掉二叉 split 的一叶 → 父 split 回收，兄弟提升", () => {
    const t = splitLeaf(splitLeaf(leaf("a"), "a", "b", "row"), "b", "c", "row");
    const closed = closeLeaf(t, "b");
    expect(closed).not.toBeNull();
    expect(leaves(closed!)).toEqual(["a", "c"]);
    // 树里不允许单孩子 split：提升后的结构必须是 split(a, c) 二叉
    expect(closed!.kind === "split" && closed!.first.kind === "leaf" && closed!.first.id === "a").toBe(true);
  });

  it("嵌套关闭：兄弟可以是整棵子树（原样提升）", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "column"); // a | (c / b)
    const closed = closeLeaf(t, "c");
    // c 消失 → 其父 split 回收，b 提升到 second
    expect(leaves(closed!)).toEqual(["a", "b"]);
    expect((closed as Extract<PaneTree, { kind: "split" }>).dir).toBe("row");
  });

  it("关掉最后一个叶 → null（整树消亡，tab 关闭）", () => {
    expect(closeLeaf(leaf("only"), "only")).toBeNull();
    const t = splitLeaf(leaf("a"), "a", "b", "row");
    expect(closeLeaf(t, "a")).toEqual(leaf("b"));
    expect(closeLeaf(closeLeaf(t, "a")!, "b")).toBeNull();
  });

  it("关闭不存在的叶 → 树不变", () => {
    const t = splitLeaf(leaf("a"), "a", "b", "row");
    expect(closeLeaf(t, "missing")).toEqual(t);
  });
});

describe("layout（布局切分）", () => {
  it("两分屏（row）：左右均分，中间留 gap", () => {
    const rects = layout(splitLeaf(leaf("a"), "a", "b", "row"), BOUNDS);
    const a = rects.get("a")!;
    const b = rects.get("b")!;
    expect(a).toEqual({ x: 0, y: 0, w: Math.round((1000 - SPLIT_GAP) / 2), h: 500 });
    expect(b.x).toBe(a.w + SPLIT_GAP);
    expect(b.w).toBe(1000 - a.w - SPLIT_GAP);
    expect(b.h).toBe(500);
    assertNoOverlap([a, b]);
  });

  it("嵌套三分屏：矩形铺满 bounds、互不重叠", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "column");
    const rects = [...layout(t, BOUNDS).values()];
    assertNoOverlap(rects);
    for (const r of rects) {
      expect(r.w).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(BOUNDS.w);
      expect(r.y + r.h).toBeLessThanOrEqual(BOUNDS.h);
    }
  });

  it("ratio=0.5 的嵌套布局面积守恒（扣 gap）", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "row");
    const rects = layout(t, BOUNDS);
    const total = [...rects.values()].reduce((s, r) => s + area(r), 0);
    // 每个 split 层留一条 gap；两级共 2 条竖缝，宽各 SPLIT_GAP
    expect(total).toBe(1000 * 500 - SPLIT_GAP * 2 * 500);
  });

  it("单叶：整块 bounds", () => {
    const rects = layout(leaf("a"), BOUNDS);
    expect(rects.get("a")).toEqual(BOUNDS);
  });
});

describe("dividers（分隔条）", () => {
  it("单 split 一条分隔条，dir 与 split 一致，厚度 = gap", () => {
    const ds = dividers(splitLeaf(leaf("a"), "a", "b", "row"), BOUNDS);
    expect(ds).toHaveLength(1);
    expect(ds[0].dir).toBe("row");
    expect(ds[0].path).toEqual([]);
    expect(ds[0].rect.w).toBe(SPLIT_GAP);
    expect(ds[0].rect.h).toBe(BOUNDS.h);
  });

  it("嵌套 split 每节点一条，命中面互不重叠", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "column");
    const ds = dividers(t, BOUNDS);
    expect(ds).toHaveLength(2);
    assertNoOverlap(ds.map((d) => d.rect));
    expect(ds.map((d) => d.dir).sort()).toEqual(["column", "row"]);
  });

  it("subtreeRect + setRatioAt 支撑拖拽：path=[1] 命中 second 子树的 bounds", () => {
    let t: PaneTree = leaf("a");
    t = splitLeaf(t, "a", "b", "row");
    t = splitLeaf(t, "b", "c", "column");
    const inner = subtreeRect(t, [1], BOUNDS)!;
    expect(inner.w).toBeGreaterThan(0);
    expect(inner.x).toBeGreaterThan(0);

    // 拖内层分隔条到 30%：只影响 path 命中的节点，外层 ratio 不动
    const outerRatio = (t as Extract<PaneTree, { kind: "split" }>).ratio;
    const next = setRatioAt(t, [1], 0.3);
    expect((next as Extract<PaneTree, { kind: "split" }>).ratio).toBe(outerRatio);
    const innerSplit = (next as Extract<PaneTree, { kind: "split" }>).second as Extract<
      PaneTree,
      { kind: "split" }
    >;
    expect(innerSplit.ratio).toBe(0.3);
  });

  it("setRatioAt clamp：拖过头也保留 MIN_RATIO 活口（path=[] = 根节点自身）", () => {
    const t = splitLeaf(leaf("a"), "a", "b", "row");
    const extreme = setRatioAt(t, [], 0.0001) as Extract<PaneTree, { kind: "split" }>;
    expect(extreme.ratio).toBe(MIN_RATIO);
    const other = setRatioAt(t, [], 99) as Extract<PaneTree, { kind: "split" }>;
    expect(other.ratio).toBe(1 - MIN_RATIO);
  });
});
