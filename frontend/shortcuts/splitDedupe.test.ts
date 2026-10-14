// 菜单动作去重单测（2026-10-14 分屏首报，2026-10-16 推广非幂等全族）：
// 菜单事件链路偶发双发的防护——开关/翻转类动作双发即「开→关一闪」。
import { describe, expect, it } from "vitest";
import { createSplitDedupe } from "./splitDedupe";

describe("createSplitDedupe", () => {
  it("非幂等动作 250ms 窗口内重复 → 丢弃；超出窗口 → 放行", () => {
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

  it("开关二态全族窗口内去重（2026-10-16 帮助菜单「命令面板」一闪实测）", () => {
    const pass = createSplitDedupe(250);
    expect(pass("palette.toggle", 1000)).toBe(true);
    expect(pass("palette.toggle", 1001)).toBe(false); // 双发丢弃，不再闪
    expect(pass("palette.toggle", 1300)).toBe(true); // 超窗放行（真实再点）
    expect(pass("history.search", 1400)).toBe(true);
    expect(pass("history.search", 1450)).toBe(false);
  });

  it("翻转族工具弹框去重；非翻转 tool.*（导出 CSV）与幂等动作恒放行", () => {
    const pass = createSplitDedupe(250);
    expect(pass("tool.cron", 1000)).toBe(true);
    expect(pass("tool.cron", 1001)).toBe(false);
    expect(pass("tool.alerts", 1002)).toBe(true); // 不同动作互斥
    expect(pass("tool.export-hosts-csv", 1000)).toBe(true);
    expect(pass("tool.export-hosts-csv", 1001)).toBe(true); // 连发合法（同 Toast 复用）
    expect(pass("settings.open", 1000)).toBe(true);
    expect(pass("settings.open", 1001)).toBe(true);
    expect(pass("theme.set.dark", 1000)).toBe(true);
    expect(pass("theme.set.dark", 1001)).toBe(true); // 幂等：设两次同值无害
  });
});
