// 分屏布局引擎（Task 8，A1）：pane 树纯函数——无 React、无 DOM、无 IO，
// 全量 vitest 覆盖（嵌套分屏 / 关闭回收 / 布局切分 / 分隔条命中面）。
//
// 模型：二叉 split 树。叶 = 一个终端 pane（id = 会话 id，见 SessionStore.trees）；
// 分裂在**被聚焦的叶**上原地发生（iTerm 惯例）：splitLeaf 把该叶替换为一个
// split 节点。关闭叶后父 split 回收（兄弟子树提升）——树里永远没有单孩子 split。
//
// dir 语义（CSS flex 对齐）：
//   * "row"    = 孩子左右排布，分隔条为竖直方向；
//   * "column" = 孩子上下排布，分隔条为水平方向。
//
// ratio 约定：first 孩子占内区（扣除 gap）的比例，恒被 clamp 在
// [MIN_RATIO, 1 - MIN_RATIO]，拖拽再猛也不会把 pane 挤没。

/** 分隔条留缝（px）：layout 在两孩子之间留出的空档，也是分隔条的可点厚度。 */
export const SPLIT_GAP = 6;
/** first 孩子占比上下限（拖拽 clamp）。 */
export const MIN_RATIO = 0.15;

export type SplitDir = "row" | "column";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PaneTree =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: SplitDir; ratio: number; first: PaneTree; second: PaneTree };

export function leaf(id: string): PaneTree {
  return { kind: "leaf", id };
}

/** 树内全部叶 id（= 活着的会话 id 集合，按布局顺序）。 */
export function leaves(tree: PaneTree): string[] {
  if (tree.kind === "leaf") return [tree.id];
  return [...leaves(tree.first), ...leaves(tree.second)];
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

/** 在指定叶处分裂（dir 为新 split 的方向）。找不到叶 → 原树原样返回（纯函数）。 */
export function splitLeaf(tree: PaneTree, leafId: string, newId: string, dir: SplitDir): PaneTree {
  if (tree.kind === "leaf") {
    if (tree.id !== leafId) return tree;
    return { kind: "split", dir, ratio: 0.5, first: tree, second: leaf(newId) };
  }
  return {
    ...tree,
    first: splitLeaf(tree.first, leafId, newId, dir),
    second: splitLeaf(tree.second, leafId, newId, dir),
  };
}

/** 关闭叶：父 split 回收（兄弟子树原地提升）。关掉最后一个叶 → null（整棵树消亡）。 */
export function closeLeaf(tree: PaneTree, leafId: string): PaneTree | null {
  if (tree.kind === "leaf") {
    return tree.id === leafId ? null : tree;
  }
  if (tree.first.kind === "leaf" && tree.first.id === leafId) return tree.second;
  if (tree.second.kind === "leaf" && tree.second.id === leafId) return tree.first;
  const first = closeLeaf(tree.first, leafId);
  if (first === null) return tree.second;
  const second = closeLeaf(tree.second, leafId);
  if (second === null) return first;
  return { ...tree, first, second };
}

/** 把 path 定位的 split 节点 ratio 置为新值（clamp）。path 与
 * [`dividers`] 的 path 同语义（[] = 根节点自身，[1,0] = second.first）。 */
export function setRatioAt(
  tree: PaneTree,
  path: readonly number[],
  ratio: number,
): PaneTree {
  if (tree.kind === "leaf") return tree;
  if (path.length === 0) return { ...tree, ratio: clampRatio(ratio) };
  const [head, ...rest] = path;
  return head === 0
    ? { ...tree, first: setRatioAt(tree.first, rest, ratio) }
    : { ...tree, second: setRatioAt(tree.second, rest, ratio) };
}

/** 沿 path 找 split 节点的 bounds（分隔条拖拽时把指针坐标换算成 ratio 用）。 */
export function subtreeRect(
  tree: PaneTree,
  path: readonly number[],
  bounds: Rect,
  gap: number = SPLIT_GAP,
): Rect | null {
  let node = tree;
  let rect = bounds;
  for (const step of path) {
    if (node.kind === "leaf") return null;
    const { firstRect } = divide(rect, node.dir, node.ratio, gap);
    const secondRect: Rect =
      node.dir === "row"
        ? { x: rect.x + firstRect.w + gap, y: rect.y, w: rect.w - firstRect.w - gap, h: rect.h }
        : { x: rect.x, y: rect.y + firstRect.h + gap, w: rect.w, h: rect.h - firstRect.h - gap };
    rect = step === 0 ? firstRect : secondRect;
    node = step === 0 ? node.first : node.second;
  }
  return rect;
}

/** 单层切分：按 dir/ratio/gap 返回 first孩子的矩形（second 的留缝见 subtreeRect 推导）。 */
function divide(rect: Rect, dir: SplitDir, ratio: number, gap: number): { firstRect: Rect } {
  if (dir === "row") {
    const w = Math.round((rect.w - gap) * ratio);
    return { firstRect: { x: rect.x, y: rect.y, w, h: rect.h } };
  }
  const h = Math.round((rect.h - gap) * ratio);
  return { firstRect: { x: rect.x, y: rect.y, w: rect.w, h } };
}

/** 布局：叶 id → 矩形。兄弟间留 gap；嵌套逐层内缩；相邻矩形不重叠。 */
export function layout(
  tree: PaneTree,
  bounds: Rect,
  gap: number = SPLIT_GAP,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (node: PaneTree, rect: Rect) => {
    if (node.kind === "leaf") {
      out.set(node.id, rect);
      return;
    }
    const { firstRect } = divide(rect, node.dir, node.ratio, gap);
    walk(node.first, firstRect);
    if (node.dir === "row") {
      walk(node.second, {
        x: rect.x + firstRect.w + gap,
        y: rect.y,
        w: Math.max(0, rect.w - firstRect.w - gap),
        h: rect.h,
      });
    } else {
      walk(node.second, {
        x: rect.x,
        y: rect.y + firstRect.h + gap,
        w: rect.w,
        h: Math.max(0, rect.h - firstRect.h - gap),
      });
    }
  };
  walk(tree, bounds);
  return out;
}

/** 分隔条描述：path 定位 split 节点（拖拽 → setRatioAt），rect 为可点命中面。 */
export interface Divider {
  path: number[];
  dir: SplitDir;
  rect: Rect;
}

/** 全部分隔条命中面（递归每个 split 节点一条；厚度 = gap，嵌套处不重叠）。 */
export function dividers(
  tree: PaneTree,
  bounds: Rect,
  gap: number = SPLIT_GAP,
): Divider[] {
  const out: Divider[] = [];
  const walk = (node: PaneTree, path: number[], rect: Rect) => {
    if (node.kind === "leaf") return;
    const { firstRect } = divide(rect, node.dir, node.ratio, gap);
    out.push({
      path,
      dir: node.dir,
      rect:
        node.dir === "row"
          ? { x: rect.x + firstRect.w, y: rect.y, w: gap, h: rect.h }
          : { x: rect.x, y: rect.y + firstRect.h, w: rect.w, h: gap },
    });
    if (node.dir === "row") {
      walk(node.first, [...path, 0], firstRect);
      walk(
        node.second,
        [...path, 1],
        { x: rect.x + firstRect.w + gap, y: rect.y, w: Math.max(0, rect.w - firstRect.w - gap), h: rect.h },
      );
    } else {
      walk(node.first, [...path, 0], firstRect);
      walk(
        node.second,
        [...path, 1],
        { x: rect.x, y: rect.y + firstRect.h + gap, w: rect.w, h: Math.max(0, rect.h - firstRect.h - gap) },
      );
    }
  };
  walk(tree, [], bounds);
  return out;
}
