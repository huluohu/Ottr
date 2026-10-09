// 命令面板模糊匹配（Task 14，A12）：手写 subsequence + 打分，刻意不引 fuse.js
// （台账裁定「依赖从简」：面板条目量级 = 全部主机 + 9 个命令，O(n·m) 逐条
// 打分远够用；fuse.js 的 bitap/权重配置面在此是过度建设）。
//
// 语义：
//   * 子序列命中即可（"wb01" 命中 web-01，"连设置" 逐字命中「设置」标签）；
//   * 打分偏向：连续命中 > 词首命中（空格/-/_/./@/:/分隔后）> 首前缀；跨字距惩罚；
//   * 返回命中的下标序列供高亮（<mark> 切分）。

export interface FuzzyResult {
  score: number;
  /** 命中字符在 target 中的下标（升序，供高亮）。 */
  indices: number[];
}

const SEPARATORS = new Set([" ", "-", "_", ".", "@", ":", "/", "(", "）", "（"]);

function isBoundary(target: string, idx: number): boolean {
  return idx === 0 || SEPARATORS.has(target[idx - 1]);
}

/** 空查询 = 全量命中（score 0，无高亮）。子序列断裂 = null。 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };

  let score = 0;
  let prevHit = -2;
  let from = 0;
  const indices: number[] = [];
  for (const qc of q) {
    const idx = t.indexOf(qc, from);
    if (idx === -1) return null;
    indices.push(idx);
    score += 1;
    if (idx === prevHit + 1) score += 3; // 连续命中（拼写字前缀的手感）
    if (isBoundary(t, idx)) score += 2; // 词首命中
    if (prevHit >= 0) {
      score -= Math.min(2, idx - prevHit - 1) * 0.25; // 跨字距轻惩
    }
    prevHit = idx;
    from = idx + 1;
  }
  if (t.startsWith(q)) score += 4; // 整串前缀（最常见输入路径）
  return { score, indices };
}

/** 带权字段打分：取各字段最佳（主字段命中 > 次字段命中），供条目排序。 */
export function fuzzyBest(
  query: string,
  fields: { text: string; weight: number }[],
): FuzzyResult | null {
  let best: FuzzyResult | null = null;
  for (const { text, weight } of fields) {
    const r = fuzzyMatch(query, text);
    if (r && (best === null || r.score * weight > best.score)) {
      best = { score: r.score * weight, indices: r.indices };
    }
  }
  return best;
}

/** 命中下标 → 高亮区间 [start, endExclusive) 列表（相邻命中合并）。 */
export function highlightRanges(indices: number[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const i of indices) {
    const last = ranges[ranges.length - 1];
    if (last && i === last.end) last.end = i + 1;
    else ranges.push({ start: i, end: i + 1 });
  }
  return ranges;
}
