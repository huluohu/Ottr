// 全仓守卫（Task 1，UI 审计 A2 防再犯）：src/ 全部 .tsx 禁止裸写原生勾选框与
// 旧三联主题按钮——一律走 src/ui/ 基础控件（Switch/Checkbox/SegmentedControl）。
// 白名单：src/ui/ 自身（组件的自绘实现是唯一合法挂载点）与测试文件（*.test.*）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIR = join("src", "ui");

function collectOffenders(dir: string): string[] {
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === UI_DIR) continue; // 组件自绘实现 = 唯一合法挂载点
    if (/\.(test|spec)\.(tsx|ts)$/.test(p)) continue; // 测试文件白名单
    if (statSync(p).isDirectory()) {
      offenders.push(...collectOffenders(p));
    } else if (p.endsWith(".tsx")) {
      const text = readFileSync(p, "utf8");
      if (text.includes('<input type="checkbox"')) offenders.push(`${p}: 裸 input[type=checkbox]`);
      if (text.includes('className="theme-switch"')) offenders.push(`${p}: theme-switch 三联残留`);
    }
  }
  return offenders;
}

describe("全仓无裸原生勾选控件（A2 守卫）", () => {
  it("src/ 的 .tsx（ui/ 与测试除外）不出现 <input type=\"checkbox\" 与 className=\"theme-switch\"", () => {
    expect(collectOffenders("src")).toEqual([]);
  });
});
