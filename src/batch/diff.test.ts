// diff 纯函数测试（Phase 3 Task 4，B6）：等值分组 / 多数派 / 少数派 /
// 行级多重集差标注 / 归一化与 100 行截断。
import { describe, expect, it } from "vitest";
import { DIFF_LINE_CAP, diffOutputs, emptyDiff, normalizeLines } from "./diff";

const fx = (hostId: number, name: string, output: string) => ({ hostId, name, output });

describe("normalizeLines", () => {
  it("CRLF/CR 归一、去尾部空行", () => {
    expect(normalizeLines("a\r\nb\rc\n")).toEqual(["a", "b", "c"]);
  });
  it("截断到前 100 行", () => {
    const lines = normalizeLines(Array.from({ length: 150 }, (_, i) => `L${i}`).join("\n"));
    expect(lines).toHaveLength(DIFF_LINE_CAP);
    expect(lines[0]).toBe("L0");
    expect(lines[99]).toBe("L99");
  });
});

describe("diffOutputs", () => {
  it("输出全同的机器折叠为一组", () => {
    const d = diffOutputs([fx(1, "a", "spike\n"), fx(2, "b", "spike"), fx(3, "c", "spike\r\n")]);
    expect(d.singleGroup).toBe(true);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].hosts).toEqual(["a", "b", "c"]);
    expect(d.outlierIds.size).toBe(0);
  });

  it("42/43 场景：少数派高亮 + 行级标注整行 differs", () => {
    const d = diffOutputs([fx(1, "a", "42\n"), fx(2, "b", "42\n"), fx(3, "c", "43\n")]);
    expect(d.singleGroup).toBe(false);
    expect(d.majorityHosts).toEqual(["a", "b"]);
    expect([...d.outlierIds]).toEqual([3]);
    const marked = d.diffLines("43\n");
    expect(marked).toEqual([{ text: "43", differs: true }]);
    // 多数派自身的行标注为不差异
    expect(d.diffLines("42\n")).toEqual([{ text: "42", differs: false }]);
  });

  it("并列最大组取首现组为多数派", () => {
    const d = diffOutputs([fx(1, "a", "x"), fx(2, "b", "y"), fx(3, "c", "x"), fx(4, "d", "y")]);
    expect(d.majorityHosts).toEqual(["a", "c"]);
    expect([...d.outlierIds].sort()).toEqual([2, 4]);
  });

  it("行多重集差：相同行在多数派里配额耗尽后才标 differs", () => {
    // 多数派 = "a\nb\nb"；少数派 = "a\nb\nb\nc\nb" —— 前 3 行多重集内消化，
    // 多出来的 "c"/"b" 标 differs
    const d = diffOutputs([fx(1, "m", "a\nb\nb\n"), fx(2, "n", "a\nb\nb\n"), fx(3, "o", "a\nb\nb\nc\nb\n")]);
    expect(d.diffLines("a\nb\nb\nc\nb\n")).toEqual([
      { text: "a", differs: false },
      { text: "b", differs: false },
      { text: "b", differs: false },
      { text: "c", differs: true },
      { text: "b", differs: true },
    ]);
  });

  it("三组不同输出：最大组为多数派，其余两组全体入 outlierIds", () => {
    const d = diffOutputs([
      fx(1, "a", "v1"),
      fx(2, "b", "v1"),
      fx(3, "c", "v2"),
      fx(4, "d", "v3"),
      fx(5, "e", "v3"),
    ]);
    expect(d.groups.map((g) => g.hosts.length)).toEqual([2, 2, 1]);
    expect(d.majorityHosts).toEqual(["a", "b"]);
    expect([...d.outlierIds].sort()).toEqual([3, 4, 5]);
  });

  it("空输入返回零值（无组、无 outlier、diffLines 恒空）", () => {
    const d = emptyDiff();
    expect(d.groups).toEqual([]);
    expect(d.outlierIds.size).toBe(0);
    expect(d.singleGroup).toBe(true);
    expect(d.diffLines("anything")).toEqual([]);
  });
});
