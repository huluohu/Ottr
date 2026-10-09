// 模糊匹配单测（Task 14）：命中/断裂/打分序/高亮区间。
import { describe, expect, it } from "vitest";
import { fuzzyBest, fuzzyMatch, highlightRanges } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("空查询全量命中（无高亮）", () => {
    expect(fuzzyMatch("", "web-01")).toEqual({ score: 0, indices: [] });
  });

  it("子序列命中（跨分隔符）与断裂拒绝", () => {
    expect(fuzzyMatch("wb01", "web-01")).not.toBeNull();
    expect(fuzzyMatch("eb1", "web-01")).not.toBeNull();
    expect(fuzzyMatch("xyz", "web-01")).toBeNull();
    // 顺序颠倒不是子序列
    expect(fuzzyMatch("10web", "web-01")).toBeNull();
  });

  it("中文逐字子序列命中", () => {
    expect(fuzzyMatch("设置", "设置")).not.toBeNull();
    expect(fuzzyMatch("切语", "切换语言（中文/English）")).not.toBeNull();
    expect(fuzzyMatch("言语", "切换语言")).toBeNull();
  });

  it("打分序：前缀 > 连续 > 散点；词首加权", () => {
    const q = "web";
    const prefix = fuzzyMatch(q, "web-01")!; // 前缀 + 连续
    const scattered = fuzzyMatch(q, "wp-eggs-banana")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
    // 同为子序列，分隔符后词首命中强于词中拼接
    const atBoundary = fuzzyMatch(q, "a-web")!;
    const midWord = fuzzyMatch(q, "aweb")!;
    expect(atBoundary.score).toBeGreaterThan(midWord.score);
  });

  it("大小写不敏感", () => {
    expect(fuzzyMatch("WEB", "web-01")).not.toBeNull();
    expect(fuzzyMatch("web", "WEB-01")!.indices).toEqual([0, 1, 2]);
  });
});

describe("fuzzyBest（带权字段）", () => {
  it("主字段（高权重）命中压过次字段", () => {
    const name = fuzzyBest("web", [
      { text: "db-01", weight: 1 },
      { text: "web", weight: 0.5 },
    ])!;
    const viaAddress = fuzzyBest("web", [
      { text: "db-01", weight: 1 },
      { text: "10.0.0.web", weight: 0.5 },
    ])!;
    expect(name.score).toBeGreaterThan(viaAddress.score);
  });

  it("全部字段不命中 → null", () => {
    expect(
      fuzzyBest("zzz", [{ text: "web-01", weight: 1 }, { text: "10.0.0.1", weight: 0.8 }]),
    ).toBeNull();
  });
});

describe("highlightRanges", () => {
  it("相邻命中合并、离散命中独立", () => {
    expect(highlightRanges([0, 1, 2])).toEqual([{ start: 0, end: 3 }]);
    expect(highlightRanges([0, 3, 4])).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 5 },
    ]);
    expect(highlightRanges([])).toEqual([]);
  });
});
