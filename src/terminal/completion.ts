// 智能补全（Phase 2 Task 8，B8）：fish 风格 ghost text。
//
// 分层（可测性裁定）：
//   1. 纯引擎 suggest()：当前行文本 + 光标位置 + 历史缓存（host 优先/全局/内置
//      表）→ 补全建议（suffix = 追加在光标后的灰字）或 null。无 DOM、无 xterm
//      依赖，TDD 钉死前缀匹配/两段式回退/排序/去重/空输入/超长行。
//   2. GhostController：xterm 6 decoration 渲染 + onData 按键语义。xterm 6 无
//      原生 ghost text——用 registerDecoration 自绘灰字，**纯视觉层，绝不污染
//      PTY 流**：除「Tab 采纳时把补全剩余文本写入 write_session」外，一切按键
//      原样透传（PTY 纯净性测试钉死）。
//
// Tab 语义（registry 守卫 T14 的产品裁定）：终端内 Tab 本是 shell 补全——
//   有 ghost = 拦截 Tab，写补全剩余文本（不发 \t）；
//   无 ghost = 放行 \t 给 shell。
// Esc = 忽略本次建议（吞掉，下次击键恢复）；Enter/Ctrl-C/Ctrl-D = 行已消失，
// 清态；方向键等控制序列 = 光标位移不可追，保守清态。
//
// 远端回显时差：onData 时本地回显未必到达，控制器维护 pending 增量（乐观击键
// 影子），refresh 时与缓冲现值对账（endsWith 即丢弃）。引擎数据源 = 当前行
// 文本（buffer.getLine 提取，按单元格宽换算列→字符索引，CJK 宽字符不漂移）。
import type { IDisposable } from "@xterm/xterm";
import { stripPromptPrefix } from "../history/format";

// ---------------------------------------------------------------------------
// 纯引擎
// ---------------------------------------------------------------------------

/** 补全查询：line = 光标所在行文本（提示符剥离后），cursor = 光标字符索引。 */
export interface CompletionQuery {
  line: string;
  cursor: number;
}

/** 补全来源（缓存形态：数组序 = 最近优先序，index 0 最新）。 */
export interface CompletionSources {
  /** 本 host 历史（history_search 空 query 拉取的最近 N 条，前端规范化）。 */
  hostHistory: readonly string[];
  /** 跨 host 历史（hostId=null 同款拉取）。 */
  globalHistory: readonly string[];
}

export type CompletionSourceKind = "host-history" | "global-history" | "builtin";

export interface CompletionSuggestion {
  /** 追加在光标后的 ghost 文本（不改动已输入部分）。 */
  suffix: string;
  source: CompletionSourceKind;
}

/** 输入行长度守卫：超长行（如 cat 大文件后编辑）不做补全。 */
export const MAX_INPUT_CHARS = 2000;
/** 建议长度守卫：超长补全（多行命令残留等）不展示也不采纳。 */
export const MAX_SUFFIX_CHARS = 500;

/** 内置常用命令表（约 56 条；命令本身 i18n 无关）。数组序 = 同输入下的
 * 内置表内优先序（常用者在前）。 */
export const BUILTIN_COMMANDS: readonly string[] = [
  "ls -la",
  "ls",
  "cd ..",
  "pwd",
  "git status",
  "git log --oneline",
  "git diff",
  "git pull",
  "git push",
  "git branch",
  "git checkout",
  "git add -A",
  "git stash",
  "docker ps -a",
  "docker ps",
  "docker images",
  "docker logs -f",
  "docker exec -it",
  "docker compose up -d",
  "docker compose down",
  "kubectl get pods -A",
  "kubectl get pods",
  "kubectl logs -f",
  "kubectl apply -f",
  "systemctl status",
  "systemctl restart",
  "journalctl -xe",
  "journalctl -u",
  "tail -f",
  "tail -n 100",
  "grep -rn",
  "find . -name",
  "df -h",
  "du -sh",
  "free -h",
  "ps aux",
  "top",
  "htop",
  "ss -tlnp",
  "lsof -i",
  "netstat -tlnp",
  "ping -c 4",
  "curl -I",
  "wget",
  "tar -czf",
  "tar -xzf",
  "mkdir -p",
  "rm -rf",
  "cp -r",
  "chmod +x",
  "ln -s",
  "vim",
  "nvim",
  "cat",
  "echo",
  "which",
  "history",
];

/** 命令分隔符后的段起点（`ls && doc` → 补全只看 `doc` 起的活性段）。 */
export function activeSegmentStart(before: string): number {
  let start = 0;
  for (const sep of ["&&", "||", ";", "|"]) {
    const i = before.lastIndexOf(sep);
    if (i >= 0) start = Math.max(start, i + sep.length);
  }
  return start;
}

/** 去重（保序，首个出现者胜 = 最近者优先）；空串剔除。 */
export function dedupeCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cmd of commands) {
    if (cmd === "" || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

function usableCandidate(cmd: string): boolean {
  // 多行候选剔除（Tab 采纳会写入 \n 提前执行首行——安全红线）
  return cmd !== "" && !cmd.includes("\n");
}

function clippedSuffix(suffix: string): string | null {
  return suffix.length > MAX_SUFFIX_CHARS ? null : suffix;
}

/** cmd 中首个以 token 为前缀的词 → 自「已输入长度」起的剩余文本；无可补
 * （命中词后无内容）→ null。`com` vs `git commit -m x` → `mit -m x`。 */
function tokenRemainder(cmd: string, token: string): string | null {
  const word = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(cmd)) !== null) {
    if (!m[0].startsWith(token)) continue;
    const rest = cmd.slice(m.index + token.length);
    if (rest.trim() === "") continue; // 命中词是命令末尾：没有可补内容
    return rest;
  }
  return null;
}

/**
 * 补全主入口。匹配两段式（fish 语义）：
 *   Pass A 行前缀续接：`doc` → `ker ps -a`、`docker ` → `ps -a`；
 *   Pass B token 前缀回退：当前词命中历史任一 token → 补该词余部 + 后文。
 * 排序 = 来源优先（host 历史 > 全局历史 > 内置表），来源内数组序（最近优先）
 * 首个命中即返回（去重由缓存层 + 首中即返共同保证）。无候选 → null。
 */
export function suggest(
  query: CompletionQuery,
  sources: CompletionSources,
): CompletionSuggestion | null {
  const { line } = query;
  if (line.length > MAX_INPUT_CHARS) return null; // 超长行守卫
  const cursor = Math.min(Math.max(query.cursor, 0), line.length);
  const before = line.slice(0, cursor);
  const segment = before.slice(activeSegmentStart(before)).replace(/^\s+/, "");
  if (segment === "") return null; // 空输入/纯空白：不打扰
  const lists: Array<[readonly string[], CompletionSourceKind]> = [
    [sources.hostHistory, "host-history"],
    [sources.globalHistory, "global-history"],
    [BUILTIN_COMMANDS, "builtin"],
  ];
  for (const [list, source] of lists) {
    for (const cmd of list) {
      if (!usableCandidate(cmd) || !cmd.startsWith(segment)) continue;
      const suffix = clippedSuffix(cmd.slice(segment.length));
      if (suffix !== null && suffix !== "") return { suffix, source };
    }
  }
  const tokenMatch = /(\S+)$/.exec(segment);
  if (!tokenMatch) return null; // 段尾是空白：token 回退无锚点
  const token = tokenMatch[1];
  for (const [list, source] of lists) {
    for (const cmd of list) {
      if (!usableCandidate(cmd)) continue;
      const rest = tokenRemainder(cmd, token);
      const suffix = rest !== null ? clippedSuffix(rest) : null;
      if (suffix !== null) return { suffix, source };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 渲染层：xterm 缓冲/装饰的结构面（测试造假件；真 XTerm 结构兼容——方法
// 双变参数，同 CommandWatch MinimalTerm 惯例）
// ---------------------------------------------------------------------------

export interface GhostCell {
  chars: string;
  width: number;
}

export interface GhostBufferLine {
  translateToString(trimRight: boolean): string;
  getCell(x: number, cell: GhostCell): GhostCell | undefined;
}

export interface GhostMarker {
  line: number;
  dispose(): void;
}

export interface GhostDecoration {
  onRender(cb: (element: HTMLElement) => void): { dispose(): void };
  dispose(): void;
}

export interface GhostDecorationOptions {
  marker: GhostMarker;
  x?: number;
  width?: number;
}

/** GhostController 消费的 xterm 最小结构面。 */
export interface GhostTerm {
  cols: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      cursorX: number;
      length: number;
      getLine(y: number): GhostBufferLine | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): GhostMarker | undefined;
  registerDecoration(options: GhostDecorationOptions): GhostDecoration | undefined;
}

// ---------------------------------------------------------------------------
// 宽度工具（CJK 宽字符的列↔字符换算；emoji/全角按 2 列）
// ---------------------------------------------------------------------------

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

export function charCellWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

export function cellWidthOf(text: string): number {
  let width = 0;
  for (const ch of text) width += charCellWidth(ch);
  return width;
}

/** 按 ≤maxCells 列截断文本（装饰宽度与文本一致，防溢出换行）。 */
export function clipToCells(text: string, maxCells: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charCellWidth(ch);
    if (width + w > maxCells) break;
    out += ch;
    width += w;
  }
  return out;
}

/** 行内光标列（单元格数）→ 字符前缀（CJK 宽字符不漂移；空单元格计空白）。 */
export function lineTextUpToColumn(line: GhostBufferLine, colX: number): string {
  let text = "";
  let width = 0;
  const cell: GhostCell = { chars: "", width: 1 };
  for (let x = 0; width < colX && x < 5000; x++) {
    const got = line.getCell(x, cell);
    if (!got) break;
    text += got.chars === "" ? " " : got.chars;
    if (got.width === 0) continue; // 组合字符：不占列
    width += got.width;
  }
  return text;
}

// ---------------------------------------------------------------------------
// GhostController：decoration 渲染 + onData 按键语义
// ---------------------------------------------------------------------------

export interface GhostHooks {
  /** 补全来源现取（会话 host 维度，缓存层供）。 */
  sources: () => CompletionSources;
  /** 设置开关（completion.enabled，默认开；关 = 一切透传零渲染）。 */
  enabled: () => boolean;
  /** Tab 采纳回调：把补全剩余文本写入 PTY（与击键同一 write_session 路）。 */
  onAccept: (suffix: string) => void;
}

const ESC = "\x1b";
const TAB = "\t";

export class GhostController {
  private decoration: GhostDecoration | null = null;
  private marker: GhostMarker | null = null;
  /** 当前可见建议（null = 无 ghost；Tab/Esc 语义以此为锚）。 */
  private suffix: string | null = null;
  /** 乐观击键增量（远端回显未达时的本地影子；refresh 与缓冲对账）。 */
  private pending = "";
  /** Esc 忽略后不再打扰，直到下一次击键。 */
  private dismissed = false;
  private color = "#808080";

  constructor(
    private readonly term: GhostTerm,
    private readonly hooks: GhostHooks,
  ) {}

  /** ghost 灰字颜色（语义令牌：主题 ANSI brightBlack = 注释灰）。 */
  setColor(color: string): void {
    this.color = color;
  }

  /** onData 前置处理。返回 true = 已消费（调用方不得再透传 PTY）。 */
  handleData(data: string): boolean {
    if (!this.hooks.enabled()) {
      this.reset();
      return false;
    }
    if (data === TAB) {
      if (this.suffix !== null) {
        const accepted = this.suffix;
        this.reset();
        this.hooks.onAccept(accepted);
        return true; // 拦截：\t 不进 shell
      }
      return false; // 无 ghost：放行 shell 补全
    }
    if (data === ESC) {
      if (this.suffix !== null) {
        this.reset();
        this.dismissed = true;
        return true; // Esc 忽略建议：吞掉，不惊动 shell
      }
      return false;
    }
    if (data.includes("\r") || data.includes("\n") || data === "\x03" || data === "\x04") {
      this.reset(); // Enter/Ctrl-C/Ctrl-D：行不复存在（命令执行即清）
      return false;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.pending !== "") {
        this.pending = [...this.pending].slice(0, -1).join("");
        this.dismissed = false;
        this.refresh();
      } else {
        this.reset(); // 删到本地影子之外（回显区）：保守清态
      }
      return false;
    }
    if (isPrintable(data)) {
      this.pending += data;
      this.dismissed = false;
      this.refresh(); // 打字刷新
      return false;
    }
    this.reset(); // 方向键/控制序列：光标位移不可追，保守清态
    return false;
  }

  /** 从缓冲现值 + 乐观增量重算 ghost（onData 打字驱动）。 */
  refresh(): void {
    if (!this.hooks.enabled() || this.dismissed) {
      this.clearDecoration();
      return;
    }
    const buf = this.term.buffer.active;
    const row = buf.getLine(buf.baseY + buf.cursorY);
    if (!row) {
      this.clearDecoration();
      return;
    }
    const echoed = lineTextUpToColumn(row, buf.cursorX);
    // 回显对账：pending 已被远端回显覆盖 → 丢弃增量，以缓冲为准
    if (this.pending !== "" && echoed.endsWith(this.pending)) this.pending = "";
    const raw = echoed + this.pending;
    // 提示符剥离（保守启发式，同 ⌘R 面板口径）：前缀剥掉后光标恒在行尾
    const line = stripPromptPrefix(raw);
    if (line === "") {
      this.clearDecoration();
      return;
    }
    const suggestion = suggest(
      { line, cursor: line.length },
      this.hooks.sources(),
    );
    if (!suggestion) {
      this.clearDecoration();
      return;
    }
    this.render(suggestion.suffix);
  }

  /** 全量清态（新提示符/断连/失焦/禁用）。 */
  reset(): void {
    this.pending = "";
    this.dismissed = false;
    this.clearDecoration();
  }

  dispose(): void {
    this.reset();
  }

  private clearDecoration(): void {
    this.suffix = null;
    try {
      this.decoration?.dispose();
      this.marker?.dispose();
    } catch {
      // 已 dispose 竞态（终端重装/alt buffer），忽略
    }
    this.decoration = null;
    this.marker = null;
  }

  private render(suffix: string): void {
    if (this.suffix === suffix && this.decoration !== null) return; // 同建议不重建（防闪烁）
    this.clearDecoration();
    try {
      const buf = this.term.buffer.active;
      const marker = this.term.registerMarker(0);
      if (!marker) return;
      // 乐观增量尚未回显时，ghost 逻辑位置在 pending 之后
      const x = buf.cursorX + cellWidthOf(this.pending);
      const colsLeft = this.term.cols - x;
      const cells = Math.min(cellWidthOf(suffix), colsLeft);
      if (cells <= 0) {
        marker.dispose();
        return;
      }
      const deco = this.term.registerDecoration({ marker, x, width: cells });
      if (!deco) {
        marker.dispose();
        return;
      }
      const shown = clipToCells(suffix, cells);
      deco.onRender((el) => {
        el.textContent = shown;
        el.className = "ottr-ghost";
        el.style.color = this.color;
        el.style.whiteSpace = "pre";
        el.style.pointerEvents = "none";
      });
      this.decoration = deco;
      this.marker = marker;
      this.suffix = suffix;
    } catch {
      this.clearDecoration(); // 未 open 的终端（jsdom/竞态）→ 放弃渲染
    }
  }
}

function isPrintable(data: string): boolean {
  if (data === "") return false;
  for (const ch of data) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

export type { IDisposable };
