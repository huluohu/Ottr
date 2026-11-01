// 前端 ↔ Rust 命令契约守卫（2026-11-01 功能审计 P2-1）。
//
// 背景：`frontend/vault/bindings.generated.ts`（Tauri Specta 生成）由 Rust 侧
// 契约测试保证与后端一致，但前端手写封装与直接 invoke 调用容易发生参数名漂移。
// 本测试将「生成绑定」真正作为契约消费：逐条比对前端每个 invoke 调用的
// (命令名, 参数键集) 与生成绑定的对应项——参数名不一致即红。
//
// 规则（Tauri v2 参数映射）：JS 侧 camelCase → Rust snake_case 自动转换；
// 因此允许「生成键」本身或它的 snake_case 形态。specta 未登记的命令
// （参数走 serde_json::Value 或特殊 IPC）不在比对范围。

import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GEN = path.resolve(ROOT, "frontend/vault/bindings.generated.ts");

/** camelCase → snake_case（生成键的 Rust 侧形态）。 */
function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** 从 open brace 起找到配对的 close brace 下标。 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** 按顶层逗号切分（忽略嵌套括号与引号内的逗号）。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of body) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth += 1;
    if (c === "}" || c === "]" || c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 扫出 `__TAURI_INVOKE("cmd", { ... })`：命令名 → 顶层参数键集。 */
function scanGenerated(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /__TAURI_INVOKE\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const cmd = m[1];
    const keys = new Set<string>();
    if (m[0].includes("{")) {
      const start = src.indexOf("{", m.index);
      const end = matchBrace(src, start);
      for (const part of splitTopLevel(src.slice(start + 1, end))) {
        const key = part.split(":")[0].trim().replace(/^\.\.\./, "");
        if (key) keys.add(key);
      }
    }
    out.set(cmd, keys);
  }
  return out;
}

/** 扫出 `invoke<...>("cmd", { ... })`：命令名 → 各调用点的参数键集列表。 */
function scanFrontend(src: string): Map<string, Set<string>[]> {
  const out = new Map<string, Set<string>[]>();
  const re = /invoke(?:<[^>()]*>)?\(\s*"([a-z0-9_]+)"\s*(?:,\s*\{)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const cmd = m[1];
    const keys = new Set<string>();
    if (m[0].includes("{")) {
      const start = src.indexOf("{", m.index);
      const end = matchBrace(src, start);
      for (const part of splitTopLevel(src.slice(start + 1, end))) {
        const key = part.split(":")[0].trim().replace(/^\.\.\./, "");
        if (key) keys.add(key);
      }
    }
    const list = out.get(cmd) ?? [];
    list.push(keys);
    out.set(cmd, list);
  }
  return out;
}

/** 收集前端源码文件（排除测试与生成物）。 */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name === "bindings.generated.ts") continue;
      out.push(p);
    }
  };
  walk(root);
  return out;
}

describe("前端 ↔ Rust 命令契约（参数形状）", () => {
  const gen = scanGenerated(readFileSync(GEN, "utf-8"));

  it("生成的绑定里确有命令（生成面非空）", () => {
    expect(gen.size).toBeGreaterThan(10);
  });

  it("全前端文件（api.ts 与直接 invoke 的组件）参数键集与后端契约对齐", () => {
    const problems: string[] = [];
    let checked = 0;
    let skipped = 0;
    const files = collectSourceFiles(path.resolve(ROOT, "frontend"));
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const [cmd, calls] of scanFrontend(src)) {
        const expected = gen.get(cmd);
        if (!expected) {
          // specta 未覆盖的命令面（参数走 serde_json::Value）不在比对范围。
          skipped += calls.length;
          continue;
        }
        const allowed = new Set<string>();
        for (const k of expected) {
          allowed.add(k);
          allowed.add(snake(k));
        }
        for (const keys of calls) {
          checked += 1;
          for (const k of keys) {
            if (!allowed.has(k)) {
              problems.push(
                `${path.relative(ROOT, file)} → ${cmd}: 传了「${k}」，后端签名没有（生成键：${[...expected].join(",")}）`,
              );
            }
          }
        }
      }
    }
    expect(checked, "应当扫到若干可比对的 invoke 调用点").toBeGreaterThan(20);
    expect(problems, problems.slice(0, 10).join("\n")).toEqual([]);
    expect(skipped, "未纳入比对的调用点（specta 未覆盖）").toBeGreaterThan(0);
  });
});
