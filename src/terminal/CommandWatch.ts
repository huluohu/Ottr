// OSC 133 命令边界监听（Task 13 报错即诊的数据源）：
// xterm parser 注册 OSC 133 handler——shell 集成片段（ottr-ssh shell_integration，
// T6 真机验证终稿）发出的 A/C/D 标记驱动：
//   A（提示符开始）→ 记提示符行号（buffer 绝对坐标 baseY+cursorY）
//   C（命令输出开始）→ 截取提示符行到光标前行 = 命令行文本（含提示符原文）
//   D;code（命令结束）→ code≠0 → onCommandFailed（aiStore 弹面板诊断）
//
// 边界与取舍：
// * 远端 shell 未装 shell 集成时不发 133 → 无事件 → 不诊断（MVP 不做注入，
//   注入与 prompt 正则兜底是文本层的后续任务，见 spec §5 与 Task 15 挂账）；
// * 命令文本含提示符原文（无法从流内得知提示符宽度）；提示符里的主机名由
//   脱敏引擎 hostname 规则兜底；
// * D 的 code 缺省（None）不触发（shell 未上报退出码，安全侧不打扰）；
// * 纯回调模型：不持有 xterm 类型（MinimalTerm 结构面），可无 DOM 测试。
import type { IDisposable } from "@xterm/xterm";

export type { IDisposable };

/** 本监听消费的 xterm 结构面（xterm.Terminal 的最小子集，测试可造假件）。 */
export interface MinimalTerm {
  parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): IDisposable;
  };
  buffer: {
    active: {
      /** 视口顶行在缓冲中的绝对行号（滚动后 ≠ 0）。 */
      baseY: number;
      /** 光标行/列（视口相对）。 */
      cursorY: number;
      cursorX: number;
      length: number;
      getLine(y: number): { translateToString(trimRight: boolean): string } | undefined;
    };
  };
}

/** 提取的命令事件（exit_code + 命令行文本）。 */
export interface CommandDoneEvent {
  exitCode: number | null;
  command: string;
}

const OSC_133 = 133;

/** 从缓冲提取 [fromRow, toRow) 的文本（\n 连接、去尾空白）。 */
export function bufferRangeText(
  buffer: MinimalTerm["buffer"],
  fromRow: number,
  toRow: number,
): string {
  const lines: string[] = [];
  for (let y = fromRow; y < toRow && y < buffer.active.length; y++) {
    const line = buffer.active.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** 解析 OSC 133 D 载荷（"D" / "D;0" / "D;127"）→ 退出码；非 D 载荷或
 * 无合法退出码（"D" / "D;abc"）→ null（调用方不触发诊断）。 */
export function parseExitCode(data: string): number | null {
  const m = /^D(?:;(-?\d+))?$/.exec(data);
  if (!m || m[1] === undefined) return null;
  return Number(m[1]);
}

/** 在 xterm 实例上挂 OSC133 监听；返回 dispose（组件卸载/重连清理用）。 */
export function createCommandWatch(
  term: MinimalTerm,
  handlers: {
    onPromptStart?: () => void;
    onCommandEnd?: (command: string) => void;
    onCommandDone: (ev: CommandDoneEvent) => void;
  },
): IDisposable {
  let promptRow: number | null = null;
  let lastCommand = "";

  return term.parser.registerOscHandler(OSC_133, (data) => {
    const buf = term.buffer.active;
    if (data === "A") {
      // 提示符将绘制在当前光标行：baseY+cursorY = 缓冲绝对行号
      promptRow = buf.baseY + buf.cursorY;
      handlers.onPromptStart?.();
      return false; // 不消费：xterm 照常渲染（OSC 对显示本就无副作用）
    }
    if (data === "C") {
      // preexec 时点：提示符+命令已画完、光标在下一行行首
      const commandEnd = buf.baseY + buf.cursorY;
      const from = promptRow ?? Math.max(0, commandEnd - 1);
      lastCommand = bufferRangeText(term.buffer, from, commandEnd);
      handlers.onCommandEnd?.(lastCommand);
      return false;
    }
    if (/^D(?:;|$)/.test(data)) {
      const exitCode = parseExitCode(data);
      if (exitCode === null || exitCode === 0) {
        // 无退出码（shell 未上报）或成功（exit 0）：不触发诊断，安全侧不打扰
        lastCommand = "";
        promptRow = null;
        return false;
      }
      // C 缺失的 shell（只发 D 的集成形态）：回退取光标上一行
      if (!lastCommand) {
        const done = buf.baseY + buf.cursorY;
        lastCommand = bufferRangeText(term.buffer, Math.max(0, done - 1), done);
      }
      handlers.onCommandDone({ exitCode, command: lastCommand });
      lastCommand = "";
      promptRow = null;
    }
    return false;
  });
}
