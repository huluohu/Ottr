// danger.ts 雏形（Task 8，A8）：粘贴多行 / 危险命令的正则预检——**单一来源约定**：
// 终端粘贴确认（本任务）与 Task 13 的 AI 命令分级共用本模块；Task 13 在此完成
// 分级（把 level 细化、引入上下文与白名单），不另起炉灶。
//
// 纪律：
// * 只做**预检**（heuristic），不做放行判断——误报宁可多问一句，漏报由确认交互兜底；
// * 正则一律小写不敏感、不锚定行首（命令可能在管道/子 shell 里）；
// * skeleton 语境：分级只分 none/warn/danger 三档，覆盖最常见破坏面
//   （递归强删 / 磁盘直写 / 撤销性 VCS 操作 / 服务中断），完整威胁模型 Task 13。

/** 单条命中：kind 为规则类目（i18n / Task 13 分级用），excerpt 为命中片段。 */
export interface DangerFinding {
  kind: string;
  excerpt: string;
}

/** 危险命令规则骨架（kind 命名与 Task 13 分级对齐，勿随意改）。 */
export const DANGER_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "recursive-delete", re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i },
  { kind: "delete-root", re: /\brm\s+[^|;\n]*\s\/(\s|$)/i },
  { kind: "disk-write", re: /\b(dd\s+[^\n]*of=\/dev\/|mkfs(\.\w+)?\s|:\(\)\{\s*:\|\:&\s*\}\s*;?\s*:)/i },
  { kind: "fork-bomb", re: /:\(\)\{.*\};\s*:/s },
  { kind: "privileged", re: /\bsudo\s+rm\b/i },
  { kind: "perm-open", re: /\bchmod\s+(-R\s+)?777\b/i },
  { kind: "owner-change", re: /\bchown\s+(-R\s+)?[\w.-]+\s+\/(\s|$)/i },
  { kind: "service-stop", re: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { kind: "force-push", re: /\bgit\s+push\s+(-f|--force)(\s|--)/i },
  { kind: "hard-reset", re: /\bgit\s+reset\s+--hard\b/i },
  { kind: "sql-drop", re: /\bdrop\s+(table|database)\b/i },
];

/** 是否包含换行（粘贴确认的主触发条件：多行内容进了交互式 shell，
 * 回车即执行后续行——用户往往只看到第一行）。 */
export function isMultiline(text: string): boolean {
  return /\r\n|\r|\n/.test(text);
}

/** 逐规则扫描，返回全部命中（同一规则多行命中各报一条，带行号语义的
 * 定位由消费方按 excerpt 自行展示）。 */
export function scanDanger(text: string): DangerFinding[] {
  const findings: DangerFinding[] = [];
  for (const { kind, re } of DANGER_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({ kind, excerpt: m[0].trim().slice(0, 80) });
    }
  }
  return findings;
}

export type DangerLevel = "none" | "warn" | "danger";

/** 粘贴预检结论（粘贴确认弹层的输入）：
 *  * danger — 命中危险规则（无论单行多行，都要确认）；
 *  * warn   — 无规则命中但内容多行（回车连发风险）；
 *  * none   — 放行。 */
export function assessPaste(text: string): { level: DangerLevel; findings: DangerFinding[]; multiline: boolean } {
  const findings = scanDanger(text);
  const multiline = /\r\n|\r|\n/.test(text);
  if (findings.length > 0) return { level: "danger", findings, multiline };
  if (multiline) return { level: "warn", findings, multiline };
  return { level: "none", findings, multiline };
}
