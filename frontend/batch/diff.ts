// 差异高亮纯函数（Phase 3 Task 4，B6 Step 2）。
//
// 【算法选型（简报要求报告说明）】选**行集合精确等值分组**，不用 LCS：
// * 批量 diff 的用户问题是「哪几台和机群不一样」，不是「两台之间逐字符怎么变」
//   ——前者是分组问题（等值即同类），LCS 的最长公共子序列面对 N 台主机没有
//   自然定义（两两 LCS 是 O(N²·L²) 且不产出分组）；
// * 等值分组 = 归一化后整串比较（Map 分桶），O(N·L)，确定性、可单测；
// * 多数派 = 最大组（并列取首现组）；少数派行高亮 = **多重集差**——少数派输出
//   中「多数派行集合里数得出来」的行不标，剩下的行标 differs（42/43 场景即
//   整行标红；`whoami` 同文场景整组折叠）。LCS 的逐行对齐展示挂账不本期做。
//
// 输入上限（简报口径）：每台输出参与 diff 的部分截断到**前 100 行**（Rust 摘要
// 已把单流裁到 ≤100 行，这里是第二道防线，防未来上限放宽后 diff 退化）。

/** 参与 diff 的每台输出行数上限（简报定值）。 */
export const DIFF_LINE_CAP = 100;

/** 归一化：CRLF/CR → LF、切行、去尾部空行（trailing newline 是 echo 伪差）、
 * 截断到前 100 行。 */
export function normalizeLines(output: string): string[] {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, DIFF_LINE_CAP);
}

/** 单行标注：differs = 该行不在多数派输出的行多重集余量里。 */
export interface DiffLine {
  text: string;
  differs: boolean;
}

/** 一组「输出全同」的主机（折叠为一组展示）。 */
export interface OutputGroup {
  lines: string[];
  /** 主机名（展示序 = 输入序）。 */
  hosts: string[];
}

export interface OutputDiff {
  /** 全部等值组，按组大小降序（并列取首现序）。 */
  groups: OutputGroup[];
  /** 多数派组的 host 名（单组/空输入时 = 全部或空）。 */
  majorityHosts: string[];
  /** 与多数派输出不同的主机（少数派组全体；仅一组时为空集）。 */
  outlierIds: ReadonlySet<number>;
  /** 是否只有一个等值组（无「少数派」可言）。 */
  singleGroup: boolean;
  /** 行级标注：对某台少数派输出逐行标 differs（基于多数派行多重集）。 */
  diffLines(output: string): DiffLine[];
}

/** diff 输入行：批量结果里 ok 态的 stdout（failed/timeout 无输出可比较，
 * 由调用方排除）。 */
export interface DiffInput {
  hostId: number;
  name: string;
  output: string;
}

/** 空输入的零值（组件侧免分支）。 */
export function emptyDiff(): OutputDiff {
  return {
    groups: [],
    majorityHosts: [],
    outlierIds: new Set(),
    singleGroup: true,
    diffLines: () => [],
  };
}

/** 主入口：等值分组 + 多数派 + 少数派集合 + 行级标注闭包。 */
export function diffOutputs(inputs: readonly DiffInput[]): OutputDiff {
  if (inputs.length === 0) return emptyDiff();
  // ① 等值分组（归一化后的行序列作 key）
  const byKey = new Map<string, { lines: string[]; hosts: string[]; ids: number[] }>();
  const order: string[] = [];
  for (const { hostId, name, output } of inputs) {
    const lines = normalizeLines(output);
    const key = JSON.stringify(lines);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { lines, hosts: [], ids: [] };
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.hosts.push(name);
    bucket.ids.push(hostId);
  }
  // ② 组排序：大小降序，并列取首现序
  const groups = order
    .map((key) => byKey.get(key)!)
    .sort((a, b) => b.hosts.length - a.hosts.length);
  const majority = groups[0];
  const outlierIds = new Set<number>();
  for (const g of groups.slice(1)) for (const id of g.ids) outlierIds.add(id);
  // ③ 多数派行多重集（行级标注基准）
  const majorityCounts = new Map<string, number>();
  for (const line of majority.lines) {
    majorityCounts.set(line, (majorityCounts.get(line) ?? 0) + 1);
  }
  return {
    groups: groups.map((g) => ({ lines: g.lines, hosts: g.hosts })),
    majorityHosts: [...majority.hosts],
    outlierIds,
    singleGroup: groups.length === 1,
    diffLines(output: string): DiffLine[] {
      const counts = new Map(majorityCounts);
      return normalizeLines(output).map((text) => {
        const left = counts.get(text) ?? 0;
        if (left > 0) {
          counts.set(text, left - 1);
          return { text, differs: false };
        }
        return { text, differs: true };
      });
    },
  };
}
