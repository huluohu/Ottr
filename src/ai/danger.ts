// danger.ts（Task 8 雏形 → Task 13 完善分级）：危险命令识别的**单一来源**——
// 终端粘贴确认（assessPaste）与 AI 修复命令插终端（classify 红黄绿）共用同一张
// 规则表（DANGER_RULES），禁止另起炉灶。
//
// 纪律（T8 原则沿袭）：
// * 只做**预检**（heuristic），不做放行判断——误报宁可多问一句，漏报由确认
//   交互兜底（red 插终端 = 二次确认红字，yellow = 确认，green = 直接插入）；
// * 正则一律不锚定行首（命令可能在管道/子 shell 里）、小写不敏感；
// * 规则带 level（red/yellow）：red = 不可逆/灾难面（递归强删、磁盘直写、格式化、
//   fork 炸弹、强推覆盖远端、丢弃工作区、DROP、对 PID 1 发 SIGKILL）；yellow =
//   需要过目但不必然灾难（sudo、重启关机、kill -9、777、重定向覆盖文件）。
//
// T13 清理（T8 评审挂账「死分支」）：disk-write 正则原含 fork 炸弹备选分支
// （`:\(\)\{\s*:\|\:&…`），与独立 fork-bomb 规则重复且**错标类目**（fork 炸弹
// 会同时命中 disk-write）；已移除——fork 炸弹只归 fork-bomb（回归见测试）。

/** 分档：red（灾难）/ yellow（需过目）/ green（放行）。 */
export type TrafficLight = "red" | "yellow" | "green";

/** 单条规则：kind 为类目（i18n 键 `ai.danger.<kind>`），level 定分档。
 * 匹配面二选一：`re`（常规正则）或 `match`（正则表达不了的 token 序列判定，
 * 命中返回 excerpt；如 rm 分离旗标 `rm -r -f`）。 */
export interface DangerRule {
  kind: string;
  level: TrafficLight;
  re?: RegExp;
  match?: (cmd: string) => string | null;
}

/**
 * rm 递归+强制组合的 token 序列判定（fix 1/5 I-2）：
 * 合并旗标（-rf/-fr/-Rf）与**分离旗标**（`rm -r -f`、`rm --recursive --force`）
 * 同判——正则无法表达「旗标分散在多个 token」，按段切分（\r\n ; | & 为界，
 * 段内归属同一命令）后扫描 token：
 *   * 命中 rm（含路径前缀形态，token 以斜杠 rm 结尾）后收集旗标 token：短旗标组含 r/R 且含 f，或长旗标
 *     等于 --recursive 且 --force，即递归强删；
 *   * 操作数不终止扫描（GNU rm 允许选项后置：`rm x -rf`）——保守侧宁多问；
 *   * 段边界保证 `rm a && rsync --recursive --force` 不误伤（旗标属各段）。
 * 返回命中片段（excerpt），未命中 null。
 */
export function matchRmRecursiveForce(cmd: string): string | null {
  for (const segment of cmd.split(/[\r\n;|&]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let sawRm = false;
    let recursive = false;
    let force = false;
    for (const tok of tokens) {
      if (!sawRm) {
        if (tok === "rm" || tok.endsWith("/rm")) sawRm = true;
        continue;
      }
      if (tok.startsWith("--")) {
        if (tok === "--recursive") recursive = true;
        if (tok === "--force") force = true;
      } else if (/^-[a-zA-Z]+$/.test(tok)) {
        const letters = tok.slice(1);
        if (/[rR]/.test(letters)) recursive = true;
        if (/f/.test(letters)) force = true;
      }
    }
    if (sawRm && recursive && force) {
      return segment.trim().slice(0, 80);
    }
  }
  return null;
}

/**
 * 危险命令规则表（红黄两档；green = 无命中，不设规则）。
 * kind 命名与 i18n ai.danger.* 对齐，勿随意改（词典键存在性测试钉住）。
 */
export const DANGER_RULES: readonly DangerRule[] = [
  // --- red：不可逆 / 灾难面 ---------------------------------------------------
  {
    kind: "recursive-delete",
    level: "red",
    // 合并+分离旗标统一走 token 判定（fix 1/5 I-2：`rm -r -f` 曾漏报判 green）
    match: matchRmRecursiveForce,
  },
  { kind: "delete-root", level: "red", re: /\brm\s+[^|;\n]*\s+\/(\s|$|\*)/i },
  { kind: "disk-write", level: "red", re: /\b(dd\s+[^\n]*of=\/dev\/|mkfs(\.\w+)?\s)/i },
  { kind: "fork-bomb", level: "red", re: /:\(\)\{.*\};\s*:/s },
  // kill -9 对 PID 1 / 全部进程（容器/init 杀手）；普通 kill -9 归 yellow
  { kind: "kill9-init", level: "red", re: /\bkill\s+(-9|--sigkill|-s\s+sigkill)\s+(-1|1)\b/i },
  { kind: "perm-open-recursive-root", level: "red", re: /\bchmod\s+-R\s+777\s+\/(\s|$)/i },
  { kind: "owner-change-root", level: "red", re: /\bchown\s+(-R\s+)?[\w.-]+\s+\/(\s|$)/i },
  { kind: "force-push", level: "red", re: /\bgit\s+push\s+(-f|--force|--force-with-lease)(\s|$)/i },
  { kind: "hard-reset", level: "red", re: /\bgit\s+reset\s+--hard\b/i },
  { kind: "sql-drop", level: "red", re: /\bdrop\s+(table|database|schema)\b/i },
  // 重定向直写块设备（> 覆盖写 /dev/sdX 等，与 dd of= 同级灾难）
  { kind: "device-redirect", level: "red", re: />>?\s*\/dev\/(?:sd|hd|nvme|vd|disk|mapper)/i },
  { kind: "disk-erase", level: "red", re: /\b(shred|wipefs|blkdiscard)\b/i },

  // --- yellow：需要过目（确认后放行）------------------------------------------
  { kind: "sudo", level: "yellow", re: /\bsudo\s+\S/i },
  { kind: "service-stop", level: "yellow", re: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i },
  { kind: "kill9", level: "yellow", re: /\bkill\s+(-9|--sigkill|-s\s+sigkill)\b/i },
  { kind: "perm-open", level: "yellow", re: /\bchmod\s+(-R\s+)?777\b/i },
  { kind: "owner-change", level: "yellow", re: /\bchown\s+(-R\s+)?[\w.-]+\s+\S/i },
  // 重定向覆盖已有写法（> 覆盖文件内容；>> 追加不拦；>&/2> 等 fd 复制不拦；
  // > /dev/null 不拦——黑洞是丢弃不是破坏）
  { kind: "overwrite-redirect", level: "yellow", re: /(^|[\s;|&])>(?![>&])\s*(?!\/dev\/null\b)\S/ },
  { kind: "pkg-purge", level: "yellow", re: /\b(apt|apt-get|yum|dnf|pacman|brew)\s+(remove|purge|erase|-R)\b/i },
];

/** 单条命中：kind 为规则类目（i18n / 分级展示用），excerpt 为命中片段。 */
export interface DangerFinding {
  kind: string;
  level: TrafficLight;
  excerpt: string;
}

/** 兼容别名（T8 粘贴面沿用 none/warn/danger 三档命名；warn↔yellow、danger↔red）。 */
export type DangerLevel = "none" | "warn" | "danger";

/**
 * 红黄绿分档（AI 修复命令插终端的判定入口，spec §6）：
 * 返回最高命中档（red > yellow > green）与全部命中。
 */
export function classify(cmd: string): { level: TrafficLight; findings: DangerFinding[] } {
  const findings = scanDanger(cmd);
  const level: TrafficLight = findings.some((f) => f.level === "red")
    ? "red"
    : findings.some((f) => f.level === "yellow")
      ? "yellow"
      : "green";
  return { level, findings };
}

/** 是否包含换行（粘贴确认的主触发条件：多行内容进了交互式 shell，
 * 回车即执行后续行——用户往往只看到第一行）。 */
export function isMultiline(text: string): boolean {
  return /\r\n|\r|\n/.test(text);
}

/** 逐规则扫描，返回全部命中（同一规则多行命中各报一条，带行号语义的
 * 定位由消费方按 excerpt 自行展示）。 */
export function scanDanger(text: string): DangerFinding[] {
  const findings: DangerFinding[] = [];
  for (const { kind, level, re, match } of DANGER_RULES) {
    const hit = match ? match(text) : re ? re.exec(text)?.[0] : null;
    if (hit) {
      findings.push({ kind, level, excerpt: hit.trim().slice(0, 80) });
    }
  }
  return findings;
}

/** 粘贴预检结论（粘贴确认弹层的输入；T8 语义原样——任何规则命中都要确认，
 * red/yellow 在此同档，分级细节由 classify 面向 AI 插终端场景表达）：
 *  * danger — 命中危险规则（无论单行多行，都要确认）；
 *  * warn   — 无规则命中但内容多行（回车连发风险）；
 *  * none   — 放行。 */
export function assessPaste(text: string): {
  level: DangerLevel;
  findings: DangerFinding[];
  multiline: boolean;
} {
  const findings = scanDanger(text);
  const multiline = isMultiline(text);
  if (findings.length > 0) return { level: "danger", findings, multiline };
  if (multiline) return { level: "warn", findings, multiline };
  return { level: "none", findings, multiline };
}

/**
 * 输入侧危险提醒（Phase 2 Task 11，B11 收口）：击键流上滚动的**当前输入行**
 * 逐次 classify——red/yellow 档命中 → 行内提醒（green 不打扰）。防打扰双闸：
 *   * 同类规则 30s 限频（minIntervalMs 可注入供测试）——rm -rf 提醒过后紧随的
 *     重复编辑不刷屏；
 *   * green 纯静默（sudo 类日常命令反复出现也不弹）。
 * 边界如实声明：shell 拥有输入行，本观察面只看得到**本会话键入的字符**
 * （↑ 历史召回/Tab 补全产生的文本不可见——那部分由确认交互/粘贴确认兜底），
 * 是 best-effort 预检而非行编辑器。
 */
export class InputDangerWatch {
  private readonly lastRemindedAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number = 30_000) {}

  /** 观察当前输入行累积文本（逐键膨胀；now 注入便于测试）。返回应展示的命中：
   * 无命中 / green / 同类限频窗口内 → null。 */
  observe(text: string, now: number): DangerFinding | null {
    const { level, findings } = classify(text);
    if (level === "green") return null;
    const top = findings.find((f) => f.level === level) ?? findings[0];
    const last = this.lastRemindedAt.get(top.kind);
    if (last !== undefined && now - last < this.minIntervalMs) return null;
    this.lastRemindedAt.set(top.kind, now);
    return top;
  }
}
