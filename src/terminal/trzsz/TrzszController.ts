// TrzszController（Phase 2 Task 4，B10 下半）：trzsz.js TrzszFilter 的会话级
// 装配 + 流边界管理。协议栈全在库内（带内协议：检测 `::TRZSZ:TRANSFER:` 魔串 →
// 前端应答 OSC 选中文件 → 分块 base64 经 sendToServer 写 PTY → 进度条由库直绘
// 终端）；本文件只管三件事：
//
//   1. **数据面接管**：PTY 出口（Terminal.tsx sink.write）→ processServerOutput，
//      击键（term.onData）→ processTerminalInput——传输态下库吞协议帧/键入，
//      空闲态纯透传（零渲染差异）；列宽同步 setTerminalColumns（进度条换算）。
//   2. **魔串跨块**：Rust 合批/ssh 流的分块点可能劈开魔串（`::TRZSZ:TRANSFER:`
//      16 字节）——空闲态对**最长魔串真前缀后缀**做留验（≤15 字节，命中即继续
//      留、不命中下块并流），整串出现即整块交 filter（10ms 异步检测，期间字节
//      走透传，服务端在握手前不发协议数据，无丢失窗口）。
//   3. **文件对答**：chooseSendFiles/chooseSaveDirectory 注入（Terminal.tsx 用
//      tauri-plugin-dialog 实装）；uploadFiles(paths) 主动上传（拖拽入口）——
//      库自动发 Ctrl-C + `trz\r` 启动远端程序，失败（未装 trzsz/3s 无魔串）经
//      onError 上抛展示。
// 时序契约：ESM 依赖按声明序求值，本文件必须保证 requireShim **先于** trzsz
// 模块体执行（生产 webview 里 isRunningInBrowser 在 trzsz 求值时即判定）——
// 下方 import 顺序即契约，勿动（vitest 下 runner 自带 require，顺序不敏感）。
import "./requireShim";
import { TrzszFilter } from "trzsz";

/** trzsz 魔串（filter.ts trzszMagicKeyPrefix，未从包根导出 → 本地常量）。 */
const TRZSZ_MAGIC = "::TRZSZ:TRANSFER:";
/** 魔串完整形态（魔串 + 模式 + 版本 + 可选唯一 id；filter.ts trzszMagicKeyRegExp）。 */
const TRZSZ_MAGIC_RE = /::TRZSZ:TRANSFER:([SRD]):(\d+\.\d+\.\d+)(:\d+)?/;
/** 魔串尾验窗（真实 banner「\r\n::TRZSZ:TRANSFER:R:1.2.0:<14位id>\r\n」< 50 字节）。 */
const MAGIC_TAIL_WINDOW = 64;

export interface TrzszControllerOptions {
  /** 库的终端写出口（xterm term.write；透传与进度条渲染同一出口）。 */
  writeToTerminal: (output: Uint8Array | string) => void;
  /** 库的服务器写出口（write_session；击键与协议帧同路）。 */
  sendToServer: (input: Uint8Array | string) => void;
  /** 上传选文件（true = 目录模式）；取消/失败返回 undefined（= 拒绝传输）。 */
  chooseSendFiles: (directory: boolean) => Promise<string[] | undefined>;
  /** 下载选保存目录；取消/失败返回 undefined（= 拒绝传输）。 */
  chooseSaveDirectory: () => Promise<string | undefined>;
  /** 终端列数（进度条换算；fit 后同步）。 */
  terminalColumns?: number;
  /** 传输失败通知（如「Upload does not start」——远端未装 trzsz）。 */
  onError?: (message: string) => void;
  /** 主动上传后等远端 trz 启动的超时（默认 3000ms；测试收紧用）。 */
  dragInitTimeout?: number;
}

export interface TrzszController {
  /** PTY 出口喂入（Terminal sink.write 直连）。 */
  processServerOutput(output: Uint8Array): void;
  /** 击键喂入（term.onData 直连；传输态 Ctrl-C = 中止）。 */
  processTerminalInput(input: string): void;
  setTerminalColumns(columns: number): void;
  /** 主动上传（拖拽路径入口；库发 Ctrl-C + trz 命令后自动对答）。 */
  uploadFiles(paths: string[]): Promise<void>;
  isTransferring(): boolean;
  stopTransfer(): void;
  dispose(): void;
}

/** bytes 的最长后缀同时是 MAGIC 真前缀的长度（0..MAGIC.length-1）。 */
export function partialMagicSuffixLength(bytes: Uint8Array): number {
  const max = Math.min(TRZSZ_MAGIC.length - 1, bytes.length);
  for (let len = max; len > 0; len--) {
    let ok = true;
    for (let i = 0; i < len; i++) {
      if (bytes[bytes.length - len + i] !== TRZSZ_MAGIC.charCodeAt(i)) {
        ok = false;
        break;
      }
    }
    if (ok) return len;
  }
  return 0;
}

/**
 * 空闲态留验长度：魔串（含版本/id 载荷）可能被合批边界劈开——
 *   * 尾窗内有完整魔串起点 → 候选串（到首个非可打印字节为止）：
 *       候选被控制字节（\r\n 等）截断 → banner 已完 → 放行；
 *       候选顶到缓冲尾：已完整匹配且尾字符不可延展（数字/点）→ 放行；
 *       候选超尾窗仍不成形 → 放弃留验（库内 regex/uniqueId 去重兜底）；
 *       否则扣住候选（等下一块补全）。
 *   * 无完整起点 → 只验「魔串真前缀后缀」（partialMagicSuffixLength）。
 * 留验上限即尾窗 64 字节：误扣的垃圾随下一块并流，不会永久滞留。
 */
export function magicHoldLength(bytes: Uint8Array): number {
  const searchFrom = Math.max(0, bytes.length - MAGIC_TAIL_WINDOW - TRZSZ_MAGIC.length);
  let idx = -1;
  for (let i = bytes.length - TRZSZ_MAGIC.length; i >= searchFrom; i--) {
    let ok = true;
    for (let j = 0; j < TRZSZ_MAGIC.length; j++) {
      if (bytes[i + j] !== TRZSZ_MAGIC.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return partialMagicSuffixLength(bytes);
  // 候选串 = 魔串起点到首个非可打印字节（banner 以 \r\n 收尾 → 候选自然截断）
  let end = idx;
  while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] <= 0x7e) end++;
  if (end < bytes.length) return 0; // 控制字节截断 → banner 完整落在缓冲内 → 放行
  const candidate = String.fromCharCode(...bytes.subarray(idx, end));
  const complete = TRZSZ_MAGIC_RE.test(candidate);
  const extendable = /[.\d]$/.test(candidate);
  if (complete && !extendable) return 0;
  if (end - idx >= MAGIC_TAIL_WINDOW) return 0; // 超窗不成形：放弃（非 banner 垃圾）
  return bytes.length - idx;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function createTrzszController(options: TrzszControllerOptions): TrzszController {
  let disposed = false;
  let pending: Uint8Array | null = null; // 空闲态留验的魔串部分后缀

  const filter = new TrzszFilter({
    writeToTerminal: (output) => {
      if (disposed) return;
      options.writeToTerminal(output as Uint8Array | string);
    },
    sendToServer: (input) => {
      if (disposed) return;
      options.sendToServer(input);
    },
    chooseSendFiles: (directory?: boolean) => {
      if (disposed) return Promise.resolve(undefined);
      return options.chooseSendFiles(directory === true);
    },
    chooseSaveDirectory: () => {
      if (disposed) return Promise.resolve(undefined);
      return options.chooseSaveDirectory();
    },
    terminalColumns: options.terminalColumns,
    dragInitTimeout: options.dragInitTimeout,
  });

  return {
    processServerOutput(output: Uint8Array): void {
      if (disposed) return;
      if (filter.isTransferringFiles()) {
        // 传输态：整块交库（内部缓冲协议帧，进度条经 writeToTerminal 渲染）
        filter.processServerOutput(output);
        return;
      }
      let combined = output;
      if (pending) {
        combined = concatBytes(pending, output);
        pending = null;
      }
      const hold = magicHoldLength(combined);
      if (hold > 0) {
        pending = combined.slice(combined.length - hold);
        combined = combined.slice(0, combined.length - hold);
      }
      if (combined.length > 0) filter.processServerOutput(combined);
    },

    processTerminalInput(input: string): void {
      if (disposed) return;
      filter.processTerminalInput(input);
    },

    setTerminalColumns(columns: number): void {
      filter.setTerminalColumns(columns);
    },

    async uploadFiles(paths: string[]): Promise<void> {
      try {
        await filter.uploadFiles(paths);
      } catch (e) {
        options.onError?.(e instanceof Error ? e.message : String(e));
      }
    },

    isTransferring(): boolean {
      return filter.isTransferringFiles();
    },

    stopTransfer(): void {
      filter.stopTransferringFiles();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      pending = null;
      if (filter.isTransferringFiles()) filter.stopTransferringFiles();
    },
  };
}
