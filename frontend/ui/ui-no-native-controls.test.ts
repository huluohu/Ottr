// 全仓守卫（Task 1，UI 审计 A2 防再犯）：src/ 全部 .tsx 禁止裸写原生勾选框与
// 旧三联主题按钮——一律走 src/ui/ 基础控件（Switch/Checkbox/SegmentedControl）。
// 白名单：src/ui/ 自身（组件的自绘实现是唯一合法挂载点）与测试文件（*.test.*）。
// 边界说明（fix round 1，M-1）：本测试是 grep 式文本扫描，存在固有局限——
// .ts 文件里 createElement("input")/setAttribute("type","checkbox")、字符串
// 拼接变体（type={"checkbox"}、className={`theme-`+x}）、以及经第三方组件透传
// 的原生控件都拦不住。它防的是「顺手裸写 JSX」这一主要复发路径，不构成完备
// 语义级防线；语义级回归仍靠渲染测试（ui/ 三组件 + 消费方行为测试）兜底。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIR = join("frontend", "ui");

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
    expect(collectOffenders("frontend")).toEqual([]);
  });
});
