// SudoAutofill 测试（B9 裁定 #3）：检测正则（含真夹具金样提示串）、跨 chunk
// 拼接、冷却折叠、reset；触发链（取密 → 延迟 → 填充）与缺口分派。
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FILL_DELAY_MS,
  SUDO_COOLDOWN_MS,
  SudoPromptDetector,
  runSudoAutofill,
  sudoFillText,
} from "./SudoAutofill";

afterEach(() => {
  vi.useRealTimers();
});

describe("SudoPromptDetector", () => {
  // 真夹具金样：desktop/tests/sudo_fixture.rs 实测的逐字提示
  // （ssh -tt spike@127.0.0.1 'sudo -S true' 的 PTY 流原样字节）。
  const FIXTURE_PROMPT = "[sudo] password for spike: ";

  it("真夹具金样提示命中；命令回显等噪声不命中", () => {
    const d = new SudoPromptDetector();
    expect(d.feed(FIXTURE_PROMPT, 1_000)).toBe(true);
    const d2 = new SudoPromptDetector();
    expect(d2.feed("sudo -S true\r\n", 1_000)).toBe(false);
    expect(d2.feed("$ ls -la\r\nottr README.md\r\n", 1_000)).toBe(false);
    expect(d2.feed("export SUDO_PROMPT_TESTING=1\r\n", 1_000)).toBe(false);
  });

  it("跨 chunk 拼接：提示串被传输切片也能命中", () => {
    const d = new SudoPromptDetector();
    const parts = ["[su", "do] pass", "word for s", "pike: "];
    const results = parts.map((p, i) => d.feed(p, 1_000 + i));
    expect(results).toEqual([false, false, false, true]);
  });

  it("变体：无用户名形 / 大写 SUDO / 多空白", () => {
    for (const line of ["[sudo] password: ", "[SUDO] Password for spike :", "[sudo]  password   for  ops:"]) {
      const d = new SudoPromptDetector();
      expect(d.feed(line, 1_000), line).toBe(true);
    }
  });

  it("冷却窗内重复命中折叠为 false；窗外再次提示（错密重试）再触发", () => {
    const d = new SudoPromptDetector();
    expect(d.feed(FIXTURE_PROMPT, 1_000)).toBe(true);
    expect(d.feed(FIXTURE_PROMPT, 1_000 + SUDO_COOLDOWN_MS - 1)).toBe(false);
    expect(d.feed(FIXTURE_PROMPT, 1_000 + SUDO_COOLDOWN_MS)).toBe(true);
  });

  it("blocked 命中清账（I-2 回归）：冷却内的陈旧 tail 不再随后续输出块再触发", () => {
    const d = new SudoPromptDetector();
    expect(d.feed(FIXTURE_PROMPT, 1_000)).toBe(true); // 真命中 → 填充
    // 2s 内误命中（输出里又出现提示样文本）：blocked，但 tail 必须清
    expect(d.feed(FIXTURE_PROMPT, 1_500)).toBe(false);
    // 冷却过期后任意无关输出进来：陈旧 tail 已清，不得再次触发
    // （否则 = 明文密码打进用户当前的普通提示符）
    expect(d.feed("user@host:~$ ls\r\n", 1_000 + SUDO_COOLDOWN_MS + 1)).toBe(false);
    // 错密重试不破坏：sudo 的**完整**提示随后 chunk 重达 → 照常触发
    expect(d.feed(FIXTURE_PROMPT, 1_000 + SUDO_COOLDOWN_MS + 2)).toBe(true);
  });

  it("reset 清账：重连后历史缓冲不再命中", () => {
    const d = new SudoPromptDetector();
    d.feed("…[sudo] password for spike: ", 1_000);
    d.reset();
    expect(d.feed("", 5_000)).toBe(false);
  });

  it("长噪声滚动后提示仍在 200 字符窗口内", () => {
    const d = new SudoPromptDetector();
    d.feed("x".repeat(5_000), 1_000);
    expect(d.feed(FIXTURE_PROMPT, 1_500)).toBe(true);
  });
});

describe("sudoFillText / runSudoAutofill", () => {
  it("填充串 = 密码 + 回车（单次写）", () => {
    expect(sudoFillText("spike-pass")).toBe("spike-pass\n");
  });

  it("触发链：取密 → 延迟 → 填充（延迟 ≥ FILL_DELAY_MS，等 sudo tcsetattr）", async () => {
    vi.useFakeTimers();
    const filled: string[] = [];
    const t0 = Date.now();
    let nowAtFill = 0;
    const p = runSudoAutofill({
      getSecret: async () => "spike-pass",
      fill: (text) => {
        nowAtFill = Date.now();
        filled.push(text);
      },
    });
    // sleep 未到点：尚未填充
    await vi.advanceTimersByTimeAsync(FILL_DELAY_MS - 1);
    expect(filled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(true);
    expect(filled).toEqual(["spike-pass\n"]);
    expect(nowAtFill - t0).toBeGreaterThanOrEqual(FILL_DELAY_MS);
  });

  it("取密 null（gate 链缺口）不填充；空串走 onSkip(empty-secret)", async () => {
    const skips: string[] = [];
    const filled: string[] = [];
    const fill = (t: string) => filled.push(t);
    expect(
      await runSudoAutofill({ getSecret: async () => null, fill, onSkip: (r) => skips.push(r) }),
    ).toBe(false);
    expect(
      await runSudoAutofill({ getSecret: async () => "", fill, onSkip: (r) => skips.push(r) }),
    ).toBe(false);
    expect(skips).toEqual(["empty-secret"]);
    expect(filled).toEqual([]);
  });
});
