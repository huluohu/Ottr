// 分屏去重单测（2026-10-14）：菜单事件链路偶发双发的非幂等防护。
import { describe, expect, it } from "vitest";
import { createSplitDedupe } from "./splitDedupe";

describe("createSplitDedupe", () => {
  it("同方向 250ms 窗口内重复 → 丢弃；超出窗口 → 放行", () => {
    const pass = createSplitDedupe(250);
    expect(pass("session.splitRight", 1000)).toBe(true);
    expect(pass("session.splitRight", 1100)).toBe(false); // 窗口内重复
    expect(pass("session.splitRight", 1300)).toBe(true); // 超窗放行
  });

  it("方向切换不互斥：右分屏后立刻下分屏放行（不同动作）", () => {
    const pass = createSplitDedupe(250);
    expect(pass("session.splitRight", 1000)).toBe(true);
    expect(pass("session.splitDown", 1050)).toBe(true);
  });

  it("非分屏动作恒放行（去重只作用于非幂等的分屏）", () => {
    const pass = createSplitDedupe(250);
    expect(pass("settings.open", 1000)).toBe(true);
    expect(pass("settings.open", 1001)).toBe(true);
    expect(pass("tool.cron", 1002)).toBe(true);
  });
});
