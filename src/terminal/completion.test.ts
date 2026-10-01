// 智能补全测试（Phase 2 Task 8，B8）：纯引擎 TDD（前缀/两段回退/排序/去重/
// 空输入/超长行/多行候选剔除）+ GhostController 组件语义（decoration 创建/
// 清除、Tab 拦截三态、Esc 忽略、命令执行清除、乐观增量/回显对账）+
// **PTY 流纯净性**（ghost 显示期间透传字节与无 ghost 逐字节一致——核心回归）。
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_COMMANDS,
  GhostController,
  activeSegmentStart,
  cellWidthOf,
  clipToCells,
  dedupeCommands,
  lineTextUpToColumn,
  suggest,
  type CompletionSources,
  type GhostBufferLine,
  type GhostCellView,
  type GhostDecoration,
  type GhostMarker,
  type GhostDecorationOptions,
  type GhostTerm,
} from "./completion";

const SRC = (host: string[] = [], globalList: string[] = []): CompletionSources => ({
  hostHistory: host,
  globalHistory: globalList,
});

function suffixOf(
  line: string,
  host: string[],
  globalList: string[] = [],
): string | null {
  return suggest({ line, cursor: line.length }, SRC(host, globalList))?.suffix ?? null;
}

describe("suggest：纯引擎", () => {
  it("Pass A 行前缀续接：`docker ` → `ps -a`（host 历史）", () => {
    expect(suffixOf("docker ", ["docker ps -a"], [])).toBe("ps -a");
  });

  it("Pass A 词中前缀：`doc` → `ker ps`（自输入长度起补）", () => {
    const s = suggest({ line: "doc", cursor: 3 }, SRC(["docker ps"]));
    expect(s?.suffix).toBe("ker ps");
    expect(s?.source).toBe("host-history");
  });

  it("Pass B token 回退：`com` 命中历史任一 token → `mit -m fix`", () => {
    expect(suffixOf("com", ["git commit -m fix"])).toBe("mit -m fix");
  });

  it("Pass B：已输全 token 仍有参数可补：`status` → ` -s`", () => {
    expect(suffixOf("status", ["git status -s"])).toBe(" -s");
  });

  it("Pass B 无锚点：段尾空白（`zz ` 无候选）不回退", () => {
    expect(suffixOf("zz ", [])).toBeNull();
  });

  it("排序：host 历史 > 全局历史 > 内置表", () => {
    const sources = SRC(["git status -sb"], ["git status"]);
    const s = suggest({ line: "git status", cursor: 10 }, sources);
    expect(s?.source).toBe("host-history");
    expect(s?.suffix).toBe(" -sb");

    const s2 = suggest({ line: "git stat", cursor: 8 }, SRC([], ["git status"]));
    expect(s2?.source).toBe("global-history");
    expect(s2?.suffix).toBe("us");

    const s3 = suggest({ line: "git stat", cursor: 8 }, SRC([], []));
    expect(s3?.source).toBe("builtin");
    expect(s3?.suffix).toBe("us");
  });

  it("历史排序（最近优先）：index 0 最先命中", () => {
    expect(suffixOf("ls", ["ls -la", "ls /tmp"])).toBe(" -la");
  });

  it("去重：同命令重复入缓存由 dedupeCommands 收敛（保序首现）", () => {
    expect(dedupeCommands(["ls", "ls -la", "ls", ""])).toEqual(["ls", "ls -la"]);
  });

  it("内置表合并：空历史也能补 `doc` → `ker ps -a`", () => {
    const s = suggest({ line: "doc", cursor: 3 }, SRC([], []));
    expect(s?.source).toBe("builtin");
    expect(s?.suffix).toBe("ker ps -a");
  });

  it("空输入/纯空白/分隔符后空白：null（不打扰）", () => {
    expect(suffixOf("", ["ls"])).toBeNull();
    expect(suffixOf("   ", ["ls"])).toBeNull();
    expect(suffixOf("ls && ", ["ls"])).toBeNull();
  });

  it("分隔符锚定：`cd /tmp && doc` 只看活性段（段起点在 && 后，trimStart 在 suggest 内做）", () => {
    expect(activeSegmentStart("cd /tmp && doc")).toBe(10);
    expect(suffixOf("cd /tmp && doc", ["docker ps"])).toBe("ker ps");
  });

  it("超长行守卫：> MAX_INPUT_CHARS → null", () => {
    const long = "a".repeat(2001);
    expect(suggest({ line: long, cursor: long.length }, SRC(["abc"]))).toBeNull();
  });

  it("多行候选剔除（Tab 采纳会提前执行首行——安全红线）", () => {
    expect(suffixOf("git add -A", ["git add -A\ngit commit"])).toBeNull();
  });

  it("内置表纪律：非空、单行、无重复", () => {
    expect(BUILTIN_COMMANDS.length).toBeGreaterThanOrEqual(50);
    expect(dedupeCommands(BUILTIN_COMMANDS).length).toBe(BUILTIN_COMMANDS.length);
    for (const cmd of BUILTIN_COMMANDS) {
      expect(cmd).toBe(cmd.trim());
      expect(cmd.includes("\n")).toBe(false);
    }
  });

  it("光标在行中：只看光标前文本", () => {
    expect(suggest({ line: "docker", cursor: 3 }, SRC(["docker ps"]))?.suffix).toBe("ker ps");
  });
});

// ---------------------------------------------------------------------------
// GhostController（造假件）
// ---------------------------------------------------------------------------

interface FakeOpts {
  rows: string[];
  cursorY?: number;
  cursorX?: number;
  baseY?: number;
  cols?: number;
  /** 单元格级行（宽字符建模）：Array<[chars, width]>[]，优先于 rows。 */
  cellRows?: Array<Array<[string, number]>>;
}

function makeCell(chars: string, width: number): GhostCellView {
  return {
    getChars: () => chars,
    getWidth: () => width,
  };
}

/** 单元格行视图：cells 为逐格 [chars, width] 序列（宽字符一格计 2 列）。 */
function cellLineView(cells: Array<[string, number]>): GhostBufferLine {
  return {
    translateToString(trimRight: boolean): string {
      let text = cells.map(([c]) => c).join("");
      if (trimRight) text = text.replace(/\s+$/, "");
      return text;
    },
    getCell(x: number): GhostCellView | undefined {
      const got = cells[x];
      return got ? makeCell(got[0], got[1]) : undefined;
    },
  };
}

type FakeDecoration = GhostDecoration & {
  fireRender(): void;
  element?: HTMLElement;
};

function fakeTerm(opts: FakeOpts): GhostTerm & {
  markers: GhostMarker[];
  decorations: FakeDecoration[];
  decorationOptions: GhostDecorationOptions[];
  /** 测试期改写某行视图（模拟远端回显到达后的缓冲变化）。 */
  setRow(index: number, view: GhostBufferLine): void;
} {
  const markers: GhostMarker[] = [];
  const decorations: FakeDecoration[] = [];
  const decorationOptions: GhostDecorationOptions[] = [];
  const baseY = opts.baseY ?? 0;
  const lines: GhostBufferLine[] =
    opts.cellRows?.map(cellLineView) ??
    opts.rows.map((row) => {
      const cells = [...row].map<[string, number]>((ch) => [ch, cellWidthOf(ch)]);
      return cellLineView(cells);
    });
  return {
    cols: opts.cols ?? 80,
    markers,
    decorations,
    decorationOptions,
    buffer: {
      active: {
        baseY,
        cursorY: opts.cursorY ?? 0,
        cursorX: opts.cursorX ?? 0,
        length: lines.length,
        getLine(y: number) {
          return lines[y - baseY];
        },
      },
    },
    setRow(index: number, view: GhostBufferLine): void {
      lines[index - baseY] = view;
    },
    registerMarker() {
      const m: GhostMarker = {
        line: baseY + (opts.cursorY ?? 0),
        dispose: vi.fn(),
      };
      markers.push(m);
      return m;
    },
    registerDecoration(o: GhostDecorationOptions) {
      decorationOptions.push(o);
      let renderCb: ((el: HTMLElement) => void) | null = null;
      const d: FakeDecoration = {
        onRender(cb) {
          renderCb = cb;
          return { dispose: vi.fn() };
        },
        dispose: vi.fn(),
        fireRender() {
          const el = document.createElement("div");
          d.element = el;
          renderCb?.(el);
        },
      };
      decorations.push(d);
      return d;
    },
  };
}

/** 逐键驱动控制器，收集透传字节（返回 false 的 onData 原文）。 */
function type(controller: GhostController, keys: string[]): string[] {
  const forwarded: string[] = [];
  for (const k of keys) {
    if (!controller.handleData(k)) forwarded.push(k);
  }
  return forwarded;
}

/** 活着的 decoration（dispose 未被调用的）——重建语义下应恒 ≤1。 */
function liveDecorations(term: ReturnType<typeof fakeTerm>): FakeDecoration[] {
  return term.decorations.filter(
    (d) => (d.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 0,
  );
}

function lastDecoration(term: ReturnType<typeof fakeTerm>): FakeDecoration {
  const last = term.decorations[term.decorations.length - 1];
  expect(last).toBeTruthy();
  return last;
}

describe("GhostController：渲染与按键语义", () => {
  function setup(host: string[] = ["docker ps -a"], enabled = true) {
    const term = fakeTerm({ rows: ["root@h:~$ "], cursorX: 10, cols: 80 });
    const onAccept = vi.fn();
    const controller = new GhostController(term, {
      sources: () => SRC(host, []),
      enabled: () => enabled,
      onAccept,
    });
    return { term, controller, onAccept };
  }

  it("打字 → decoration 创建（x/y/宽度正确，灰字内容在 onRender 填充）", () => {
    const { term, controller } = setup();
    type(controller, ["d", "o", "c"]);
    // 每击键重建（位置随光标走）：只应有一只活着的
    expect(term.decorations.length).toBeGreaterThanOrEqual(1);
    expect(liveDecorations(term)).toHaveLength(1);
    const deco = lastDecoration(term);
    deco.fireRender();
    const el = (deco as unknown as { element: HTMLElement }).element;
    expect(el.textContent).toBe("ker ps -a");
    expect(el.style.whiteSpace).toBe("pre");
    expect(el.style.pointerEvents).toBe("none");
    expect(el.className).toBe("ottr-ghost");
  });

  it("无建议时打字 → 不创建 decoration（输入对全部来源都不命中）", () => {
    const term = fakeTerm({ rows: ["root@h:~$ "], cursorX: 10, cols: 80 });
    const controller = new GhostController(term, {
      sources: () => SRC(["aaaa"], ["bbbb"]),
      enabled: () => true,
      onAccept: vi.fn(),
    });
    type(controller, ["z", "z"]);
    expect(term.decorations).toHaveLength(0);
    expect(liveDecorations(term)).toHaveLength(0);
  });

  it("Tab 三态①有 ghost：拦截采纳——写剩余文本、\t 不透传、ghost 清除", () => {
    const { term, controller, onAccept } = setup();
    type(controller, ["d", "o", "c"]);
    const passed = type(controller, ["\t"]);
    expect(passed).toEqual([]); // \t 被拦截
    expect(onAccept).toHaveBeenCalledWith("ker ps -a");
    expect(liveDecorations(term)).toHaveLength(0); // 采纳后清除
    // 采纳后再 Tab（无 ghost）→ 放行
    expect(controller.handleData("\t")).toBe(false);
  });

  it("Tab 三态②无 ghost：放行 shell（\t 原样透传、不写 PTY）", () => {
    const { term, controller, onAccept } = setup([]);
    const passed = type(controller, ["\t"]);
    expect(passed).toEqual(["\t"]);
    expect(onAccept).not.toHaveBeenCalled();
    expect(term.decorations).toHaveLength(0);
  });

  it("Tab 三态③Esc 忽略：吞掉 Esc、ghost 清除、下次击键恢复", () => {
    const { term, controller, onAccept } = setup();
    type(controller, ["d", "o", "c"]);
    expect(controller.handleData("\x1b")).toBe(true); // Esc 被吞
    expect(onAccept).not.toHaveBeenCalled();
    expect(liveDecorations(term)).toHaveLength(0);
    // dismissed：refresh 不再打扰；下一次击键解除忽略 → 重建
    controller.refresh();
    expect(liveDecorations(term)).toHaveLength(0);
    expect(controller.handleData("d")).toBe(false);
    expect(liveDecorations(term)).toHaveLength(1);
  });

  it("命令执行清除：Enter 透传且 ghost 清除", () => {
    const { term, controller } = setup();
    type(controller, ["d", "o", "c"]);
    expect(controller.handleData("\r")).toBe(false);
    expect(liveDecorations(term)).toHaveLength(0);
  });

  it("PTY 纯净性：可打印字节全量透传，被拦截的只有 Tab/Esc，采纳走 onAccept", () => {
    const keys = ["l", "s", "\t", " ", "-", "l", "\x7f", "a", "\t", "\r"];
    const term = fakeTerm({ rows: ["root@h:~$ "], cursorX: 10, cols: 80 });
    const onAccept = vi.fn();
    const ghosted = new GhostController(term, {
      sources: () => SRC(["ls -la"], []),
      enabled: () => true,
      onAccept,
    });
    const consumed: string[] = [];
    const forwarded: string[] = [];
    for (const k of keys) (ghosted.handleData(k) ? consumed : forwarded).push(k);
    // ghost 显示期间：被拦截的键只允许是 Tab（采纳）——其余一切原样透传
    expect(consumed).toEqual(["\t"]);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith(" -la");
    expect(forwarded.join("")).toBe("ls -l\u007fa\t\r"); // 第二个 \t 无 ghost → 放行 shell
    // A/B 对照：同一击键流在开关关闭（无 ghost 路径）下逐字节一致
    const offTerm = fakeTerm({ rows: ["root@h:~$ "], cursorX: 10, cols: 80 });
    const off = new GhostController(offTerm, {
      sources: () => SRC(["ls -la"], []),
      enabled: () => false,
      onAccept: vi.fn(),
    });
    const printableKeys = keys.slice(0, 8); // l s \t 空 - l \x7f a
    const passedOff = type(off, printableKeys);
    const passedOn = (() => {
      const out: string[] = [];
      for (const k of printableKeys) if (!ghosted.handleData(k)) out.push(k);
      return out;
    })();
    // 第二轮 ghosted 的首个 \t 已无 ghost（第一轮已采纳）→ 只可比可打印段
    expect(passedOn.filter((k) => k !== "\t")).toEqual(passedOff.filter((k) => k !== "\t"));
    expect(offTerm.decorations).toHaveLength(0); // 关闭态零渲染
  });

  it("回显对账：远端回显到达后 pending 丢弃，建议稳定不重建", () => {
    const { term, controller } = setup();
    type(controller, ["d", "o", "c"]);
    expect(liveDecorations(term)).toHaveLength(1);
    const countBefore = term.decorations.length;
    // 回显到达：缓冲行含 "doc"，光标右移 3 格（x = 13 + 0 = 旧 10+3，位置不变）
    term.setRow(
      0,
      cellLineView([...("root@h:~$ doc")].map<[string, number]>((ch) => [ch, cellWidthOf(ch)])),
    );
    term.buffer.active.cursorX = 13;
    controller.refresh();
    // 建议不变 → 不重建（防闪烁）；pending 已对账丢弃
    expect(term.decorations).toHaveLength(countBefore);
    expect(liveDecorations(term)).toHaveLength(1);
  });

  it("退格收缩 pending：建议跟随变短", () => {
    const { term, controller, onAccept } = setup();
    type(controller, ["d", "o", "c"]);
    type(controller, ["\x7f"]); // "do"
    expect(liveDecorations(term)).toHaveLength(1);
    type(controller, ["\t"]);
    expect(onAccept).toHaveBeenCalledWith("cker ps -a");
  });

  it("控制序列（方向键）→ 保守清态", () => {
    const { term, controller } = setup();
    type(controller, ["d", "o", "c"]);
    expect(controller.handleData("\x1b[A")).toBe(false);
    expect(liveDecorations(term)).toHaveLength(0);
    // 且后续 Tab 放行（无 ghost）
    expect(controller.handleData("\t")).toBe(false);
  });

  it("设置开关关闭：一切透传、零渲染", () => {
    const { term, controller } = setup(["docker ps -a"], false);
    const passed = type(controller, ["d", "o", "c", "\t"]);
    expect(passed).toEqual(["d", "o", "c", "\t"]);
    expect(term.decorations).toHaveLength(0);
  });

  it("CJK：缓冲列→字符换算不漂移，ghost 位置含 pending 宽度", () => {
    // 提示符含中文："用户@主机:~$ "（13 格），光标列 13；用户再打 "doc"（pending）
    const prompt = "用户@主机:~$ ";
    const term = fakeTerm({ rows: [prompt], cursorX: cellWidthOf(prompt), cols: 80 });
    const controller = new GhostController(term, {
      sources: () => SRC(["docker ps -a"], []),
      enabled: () => true,
      onAccept: vi.fn(),
    });
    type(controller, ["d", "o", "c"]);
    expect(liveDecorations(term)).toHaveLength(1);
    // ghost 逻辑位置 = 缓冲光标列 13 + pending "doc" 宽 3 = 16
    expect(term.decorationOptions[term.decorationOptions.length - 1].x).toBe(16);
    expect(term.decorationOptions[term.decorationOptions.length - 1].width).toBe(
      cellWidthOf("ker ps -a"),
    );
  });

  it("宽度工具：CJK 计 2 列、按列截断", () => {
    expect(cellWidthOf("中a")).toBe(3);
    expect(clipToCells("ab中", 3)).toBe("ab");
    expect(clipToCells("ab中", 5)).toBe("ab中");
  });

  it("lineTextUpToColumn：宽字符行按列取前缀", () => {
    const view = cellLineView([
      ["中", 2],
      ["d", 1],
      ["o", 1],
    ]);
    expect(lineTextUpToColumn(view, 2)).toBe("中"); // 列 2 = 「中」之后
    expect(lineTextUpToColumn(view, 4)).toBe("中do");
    expect(lineTextUpToColumn(view, 3)).toBe("中d");
    expect(lineTextUpToColumn(view, 0)).toBe("");
  });
});
