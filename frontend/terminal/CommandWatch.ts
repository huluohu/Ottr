// OSC 133 命令边界监听（Task 13 报错即诊的数据源；Task 15 扩展命令完成全量面）：
// xterm parser 注册 OSC 133 handler——shell 集成片段（ottr-ssh shell_integration，
// T6 真机验证终稿）发出的 A/C/D 标记驱动：
//   A（提示符开始）→ 记提示符行号（buffer 绝对坐标 baseY+cursorY）
//   C（命令输出开始）→ 截取提示符行到光标前行 = 命令行文本（含提示符原文）
//   D;code（命令结束）→ code≠0 → onCommandFailed（aiStore 弹面板诊断）
//   D;任意 / D（code 缺省）→ onCommandFinished（**全量**命令完成事件，Task 15
//     历史入库消费——成功/退出码缺失也记录，与诊断「仅失败触发」的门槛不同）
//
// OSC 7 cwd（Task 15）：shell 集成在每个提示符时点发 `7;file://<host><pwd>`，
// 监听并跟踪最近一次上报 = 当前命令的运行目录（precmd 顺序 D→A→7：D 时刻的
// lastCwd 恰是**上一条命令之后**的目录，即本条命令的运行目录——`cd /x && long`
// 的 D 落在下个提示符，lastCwd 已是 /x）。未上报（无集成/其他终端）= null。
//
// 边界与取舍：
// * 远端 shell 未装 shell 集成时不发 133 → 无事件 → 不诊断/不入库（MVP 不做注入，
//   注入与 prompt 正则兜底是文本层的后续任务，见 spec §5 与 Task 15 挂账）；
// * 命令文本含提示符原文（无法从流内得知提示符宽度）；提示符里的主机名由
//   脱敏引擎 hostname 规则兜底；插入终端侧的提示符剥离是保守启发式
//   （src/history/format.ts stripPromptPrefix，⌘R 面板消费）；
// * D 无退出码（shell 未上报）：诊断不触发（T13 安全侧），历史照记（exit_code
//   落 NULL——历史列可空，命令确实完成了）；
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

/** 命令完成全量事件（Task 15 历史入库面）：cwd = 提示符时点 OSC 7 上报的
 * 运行目录；shell 未上报 = null。`integrated` = 命令文本是否来自真实的
 * OSC133 C 边界（缺陷 45，2026-10-04）：D-without-C 的回退提取（只发 D 的
 * 部分集成形态）拿到的是**输出行/提示符行**而非命令行——false 时历史入库
 * 保守停用（宁缺勿污，src/history/record.ts 消费），诊断事件流不受影响。 */
export interface CommandFinishedEvent extends CommandDoneEvent {
  cwd: string | null;
  integrated: boolean;
}

const OSC_133 = 133;
const OSC_7 = 7;

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
 * 无合法退出码（"D" / "D;abc"）→ null（诊断不触发；历史落 NULL）。 */
export function parseExitCode(data: string): number | null {
  const m = /^D(?:;(-?\d+))?$/.exec(data);
  if (!m || m[1] === undefined) return null;
  return Number(m[1]);
}

/** 解析 OSC 7 载荷（`file://<host><path>`）→ 路径；非 file 前缀 → null。
 * percent 解码尽力：坏序列原样返回（残留编码好过丢路径）。 */
export function parseOsc7Cwd(data: string): string | null {
  if (!data.startsWith("file://")) return null;
  const rest = data.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null; // file://host 无路径：不认
  const path = rest.slice(slash);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 在 xterm 实例上挂 OSC133/OSC7 监听；返回 dispose（组件卸载/重连清理用，
 * 复合两个 handler 一起摘）。 */
export function createCommandWatch(
  term: MinimalTerm,
  handlers: {
    onPromptStart?: () => void;
    onCommandEnd?: (command: string) => void;
    onCommandDone: (ev: CommandDoneEvent) => void;
    /** 全量命令完成（Task 15 历史入库；含 exit 0 与退出码缺失）。 */
    onCommandFinished?: (ev: CommandFinishedEvent) => void;
  },
): IDisposable {
  let promptRow: number | null = null;
  let lastCommand = "";
  let lastCwd: string | null = null;
  // 当前命令是否见过 C 边界（缺陷 45）：C 是命令文本可信的唯一来源标志；
  // D 时刻据此打 integrated 标，随后复位（逐命令独立判定）。
  let commandFromBoundary = false;

  const osc133 = term.parser.registerOscHandler(OSC_133, (data) => {
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
      commandFromBoundary = true;
      handlers.onCommandEnd?.(lastCommand);
      return false;
    }
    if (/^D(?:;|$)/.test(data)) {
      const exitCode = parseExitCode(data);
      // C 缺失的 shell（只发 D 的集成形态）：回退取光标上一行（诊断/历史共用）。
      // 该提取是输出行/提示符行而非命令行 → integrated=false（缺陷 45）。
      if (!lastCommand) {
        const done = buf.baseY + buf.cursorY;
        lastCommand = bufferRangeText(term.buffer, Math.max(0, done - 1), done);
      }
      // 全量完成事件先发（历史消费；成功/缺码也进），诊断门槛保持 T13 语义
      handlers.onCommandFinished?.({
        exitCode,
        command: lastCommand,
        cwd: lastCwd,
        integrated: commandFromBoundary,
      });
      if (exitCode === null || exitCode === 0) {
        // 无退出码（shell 未上报）或成功（exit 0）：不触发诊断，安全侧不打扰
      } else {
        handlers.onCommandDone({ exitCode, command: lastCommand });
      }
      lastCommand = "";
      promptRow = null;
      commandFromBoundary = false;
    }
    return false;
  });

  const osc7 = term.parser.registerOscHandler(OSC_7, (data) => {
    const cwd = parseOsc7Cwd(data);
    if (cwd !== null) lastCwd = cwd;
    return false;
  });

  return {
    dispose: () => {
      osc133.dispose();
      osc7.dispose();
    },
  };
}
