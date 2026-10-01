// redact.ts（Task 13，spec §6 脱敏引擎）：发送给 AI 前按规则表把敏感片段替换为
// 占位符；**回复中占位符原样返回**（模型看到的就是占位符，不做还原——还原即泄露）。
//
// 设计：
// * 规则 = { name, source, flags, valueGroup?, placeholder? }；默认五条
//   （ipv4/ipv6/password/email/hostname），hostname 可整体开关（settings
//   `redaction.hostname`），自定义规则存 settings `redaction.custom`；
// * 同一规则内相同源串 → 相同占位符（模型可关联「同一台主机/同一个密码」），
//   不同值递增编号（[REDACTED_IPV4_1]、[REDACTED_IPV4_2]…）；
// * 幂等：占位符不被任何规则二次吞掉（密码赋值规则对 [REDACTED 前缀的值直接
//   放行）——redact(redact(x)) === redact(x)；
// * 自定义规则的正则来自用户输入：编译失败静默跳过（不阻塞诊断主链路），
//   非法模式由设置页保存前预检兜底。
//
// 密码赋值规则的值字符集排除 shell 元字符（; | & 引号括号等）——
// `password=hunter2;` 只吞 hunter2 不吞分号；[ ] 保留在值字符集内，
// 使已生成的占位符能被幂等护栏识别。

/** 自定义规则（settings `redaction.custom` 的存储形态；pattern 为正则源串）。 */
export interface RedactRule {
  /** 规则名（占位符前缀 + 设置页展示）。 */
  name: string;
  /** JS 正则源串（编译于运行时，非法则跳过）。 */
  pattern: string;
  /** 正则 flags（缺省 "g"；password 类自带 gi）。 */
  flags?: string;
  /** 占位符前缀（缺省 = name 规格化大写）。 */
  placeholder?: string;
  enabled: boolean;
}

/** 规则编译形态（内部）。 */
interface CompiledRule {
  name: string;
  source: string;
  flags: string;
  /** 值捕获组序号（1 起；缺省 = 整个 match 即敏感串）。 */
  valueGroup?: number;
  placeholder: string;
}

/** 密码赋值的值字符集：排除空白与 shell 元字符；**保留方括号**（幂等护栏依赖）。 */
const PASSWORD_SOURCE =
  "(?<![a-z0-9])(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth)\\s*[:=]\\s*" +
  '("[^"]*"|\'[^\']*\'|[^\\s"\';|&()<>{}\\x60]+)';

/** 主机名 TLD 白名单（黑名单式「任何 xx.yy」会把 app.log/notes.txt 全吞）：
 * 只认常见 TLD/内网后缀——精确度优先，漏报由自定义规则补。 */
const HOSTNAME_TLDS =
  "com|net|org|edu|gov|int|mil|info|io|ai|dev|app|cloud|xyz|me|cn|uk|de|jp|fr|ru|" +
  "local|lan|internal|corp|example|test|invalid";

/** 默认规则表（顺序即应用顺序：email 先于 hostname，防域名被拆散）。 */
export const DEFAULT_REDACT_RULES: readonly { name: string }[] = [
  { name: "ipv4" },
  { name: "ipv6" },
  { name: "password" },
  { name: "email" },
  { name: "hostname" },
];

function compileDefaults(): CompiledRule[] {
  return [
    { name: "ipv4", source: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", flags: "g", placeholder: "IPV4" },
    {
      name: "ipv6",
      // 三分支：完整 8 组 / 压缩式（::）两种形态；lookaround 防吃 MAC 地址、
      // 时间戳（12:34:56 无 :: 且不足组数，天然不中）与 URL 端口。
      source:
        "(?<![\\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\\w:])" +
        "|(?<![\\w:])(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4})?(?![\\w:])" +
        "|(?<![\\w:])::(?:[0-9A-Fa-f]{1,4}:)*[0-9A-Fa-f]{1,4}(?![\\w:])",
      flags: "g",
      placeholder: "IPV6",
    },
    {
      name: "password",
      source: PASSWORD_SOURCE,
      flags: "gi",
      valueGroup: 2,
      placeholder: "PASSWORD",
    },
    {
      name: "email",
      source: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
      flags: "g",
      placeholder: "EMAIL",
    },
    {
      name: "hostname",
      source: `\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${HOSTNAME_TLDS})\\b`,
      flags: "gi",
      placeholder: "HOSTNAME",
    },
  ];
}

/** 占位符前缀：规则名规格化（非字母数字 → 下划线，大写）。 */
function placeholderOf(rule: { name: string; placeholder?: string }): string {
  return (rule.placeholder ?? rule.name).replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

export interface RedactFinding {
  /** 命中的规则名（默认规则名 / 自定义规则 name）。 */
  name: string;
  /** 替换的敏感片段数（同值多现逐一计数）。 */
  count: number;
}

export interface RedactResult {
  /** 脱敏后的文本（占位符原样，供 AI 消费与渲染）。 */
  text: string;
  /** 各规则命中计数（未命中的规则不出现）。 */
  findings: RedactFinding[];
}

export interface RedactOptions {
  /** 总开关（false = 原样返回；默认 true）。 */
  enabled?: boolean;
  /** 主机名规则开关（默认开；settings `redaction.hostname`）。 */
  hostname?: boolean;
  /** 自定义规则（settings `redaction.custom`）。 */
  custom?: RedactRule[];
}

/** 组装本次调用生效的规则序列（默认四规则 + 主机名（可关）+ 自定义）。 */
function effectiveRules(opts: RedactOptions): CompiledRule[] {
  const rules = compileDefaults().filter((r) => r.name !== "hostname" || opts.hostname !== false);
  for (const c of opts.custom ?? []) {
    if (!c.enabled) continue;
    rules.push({
      name: c.name,
      source: c.pattern,
      flags: c.flags ?? "g",
      placeholder: placeholderOf(c),
    });
  }
  return rules;
}

/**
 * 脱敏入口（spec §6：规则表 → 占位符；默认规则 IP/密码赋值/邮箱/主机名）。
 * 幂等：占位符不被二次替换（往返稳定，见测试）。
 */
export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  if (opts.enabled === false) return { text, findings: [] };
  let out = text;
  const findings: RedactFinding[] = [];
  for (const rule of effectiveRules(opts)) {
    let re: RegExp;
    try {
      re = new RegExp(rule.source, rule.flags.includes("g") ? rule.flags : rule.flags + "g");
    } catch {
      continue; // 非法自定义正则：跳过不阻塞主链路
    }
    const seen = new Map<string, string>();
    let count = 0;
    let seq = 0;
    out = out.replace(re, (...args) => {
      const match = args[0] as string;
      const secret =
        rule.valueGroup != null ? (args[rule.valueGroup] as string | undefined) ?? match : match;
      // 幂等护栏：值（剥引号后）已是占位符 → 原样返回
      if (secret.replace(/^["']|["']$/g, "").startsWith("[REDACTED")) return match;
      count += 1; // 逐出现计数（同值多现各自计入）
      let ph = seen.get(secret);
      if (ph === undefined) {
        seq += 1; // 编号只按新值推进（同值同占位符）
        ph = `[REDACTED_${rule.placeholder}_${seq}]`;
        seen.set(secret, ph);
      }
      return match.split(secret).join(ph);
    });
    if (count > 0) findings.push({ name: rule.name, count });
  }
  return { text: out, findings };
}
