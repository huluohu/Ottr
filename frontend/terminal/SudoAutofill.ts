// sudo 密码自动填充（Phase 3 Task 6，B9；安全敏感——默认关）：
//   * 检测：终端输出行命中 `[sudo] password for <user>:`（sudo 的交互提示写
//     stderr，PTY 场景混入同一输出流——本模块只看流文本，不区分 fd）；
//   * 填充：该 host 绑定的 password 凭据（key/totp/ftp 不适用）+ 回车，走
//     writeToSession 同一写入路径（密码进 PTY——安全面评估见 task-6 报告）；
//   * 纪律：设置默认关 + 开启须确认框（SecuritySettings）+ password（主密码）
//     模式限定（keyring 模式 gate 恒 false）；每次提示只填一次（冷却窗防重放）。
//
// 真源锚点：夹具 sudo 1.x 的提示串逐字为 `[sudo] password for spike: `
// （desktop/tests/sudo_fixture.rs 实测断言）；正则容忍用户名缺失与空白变体。
//
// 关键时序（真夹具实测踩坑）：sudo 打印提示**之后**才 tcsetattr 关回显——
// TCSAFLUSH 语义会把尚未读取的入缓冲冲掉。检测到提示立刻喂密码 = 密码被冲、
// sudo 永远等不到。故填充前置 FILL_DELAY_MS 小延迟（等同人手节奏）再写 PTY。

/** settings 键（Rust security::SETTING_SUDO_AUTOFILL 同字面；SecuritySettings
 * 开关与 Terminal 运行时 gate 共用）。 */
export const SUDO_AUTOFILL_SETTING_KEY = "security.sudo_autofill";

/** sudo 密码提示（英文 sudo 1.8.4+ 默认形态；本地化提示不在检测面——挂账）。
 * 用户名段排除冒号（"spike: " 的冒号是提示符，不属于名字）；尾部空白可选。 */
export const SUDO_PROMPT_RE = /\[sudo\]\s+password(?:\s+for\s+[^\s:]+)?\s*:\s?/i;

/** 检测窗口：保留最近 200 字符（提示串 ≤ 60 字符，足够跨 chunk 拼接）。 */
const TAIL_KEEP = 200;

/** 同一提示的冷却窗（ms）：防重复填充；sudo 错密重试的第二次提示通常在
 * 数秒后，能再次触发。 */
export const SUDO_COOLDOWN_MS = 2_000;

/** 填充前置延迟（ms）：等 sudo 完成 tcsetattr（见模块文档的 TCSAFLUSH 踩坑）。 */
export const FILL_DELAY_MS = 250;

/** 检测器（跨 chunk 有状态；纯逻辑无 xterm 依赖）。feed 返回是否命中一次
 * 提示（冷却窗内的重复命中折叠为 false）。 */
export class SudoPromptDetector {
  private tail = "";
  /** -Infinity：首次命中永不在冷却（0 初值会把早期时间戳误判为窗内）。 */
  private lastFireAt = Number.NEGATIVE_INFINITY;

  /** 喂入一段终端输出文本；命中未冷却的提示 → true（并清账重开窗口）。
   * 冷却内的命中同样清账（I-2，fix round 1）：blocked 但保留 tail 的话，之后
   * 任意输出块会在冷却过期后携陈旧 tail 再次命中 → 把密码打进无关的提示符。
   * 清账不破坏错密重试：sudo 的第二次完整提示在后续 chunk 重达，照常触发。 */
  feed(text: string, now: number): boolean {
    if (text) this.tail = (this.tail + text).slice(-TAIL_KEEP);
    if (!SUDO_PROMPT_RE.test(this.tail)) return false;
    const blocked = now - this.lastFireAt < SUDO_COOLDOWN_MS;
    this.tail = "";
    if (blocked) return false;
    this.lastFireAt = now;
    return true;
  }

  /** 重连/清屏等场景重置（历史缓冲不再作为命中依据）。 */
  reset(): void {
    this.tail = "";
    this.lastFireAt = Number.NEGATIVE_INFINITY;
  }
}

/** 填充串：密码 + 回车（单次 write，密码与换行不分离——半程滞留面最小）。 */
export function sudoFillText(secret: string): string {
  return `${secret}\n`;
}

/** 跳过原因（告警行分派；disabled 静默不打扰）。 */
export type SudoSkipReason =
  | "disabled"
  | "no-host"
  | "no-credential"
  | "not-password"
  | "empty-secret";

export interface SudoAutofillHandlers {
  /** 该会话应填的密码（null = 不可填充）。gate 链：host → credential → kind。 */
  getSecret: () => Promise<string | null>;
  /** 写 PTY（writeToSession 同路）。 */
  fill: (text: string) => void;
  /** 跳过告知（enabled 链上的缺口；UI 侧分派告警行，disabled 建议静默）。 */
  onSkip?: (reason: SudoSkipReason) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 触发链（可测纯编排）：取密码 → 前置延迟（TCSAFLUSH）→ 填充。
 * 返回是否真正填充。密码取不到走 onSkip、绝不填充。
 */
export async function runSudoAutofill(handlers: SudoAutofillHandlers): Promise<boolean> {
  const secret = await handlers.getSecret();
  if (secret === null) return false; // 取密链已给出原因（onSkip 由取密方回调）
  if (secret === "") {
    handlers.onSkip?.("empty-secret");
    return false;
  }
  await sleep(FILL_DELAY_MS);
  handlers.fill(sudoFillText(secret));
  return true;
}
