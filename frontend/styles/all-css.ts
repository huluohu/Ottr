// 测试辅助（2026-10-08 App.css 拆分）：按文件名序拼接全部分节 CSS 文本，
// 供「对样式源做文本断言」的测试（dialogScroll/tokens/MainViewLayout/term-veil）
// 消费——拆分前它们读单文件 App.css?raw；拆分后样式散在分节文件，聚合视图
// 保持断言口径不变（新增分节文件自动纳入，无需改测试）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function allAppCss(): string {
  return readdirSync("src/styles")
    .filter((f) => f.endsWith(".css") && f !== "index.css")
    .sort()
    .map((f) => readFileSync(join("src/styles", f), "utf8"))
    .join("\n");
}
