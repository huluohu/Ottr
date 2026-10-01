// CommandWatch（OSC133 监听）测试：A/C/D 三标记驱动命令提取与失败触发。
import { describe, expect, it, vi } from "vitest";
import {
  bufferRangeText,
  createCommandWatch,
  parseExitCode,
  parseOsc7Cwd,
  type MinimalTerm,
} from "./CommandWatch";

function fakeTerm(lines: string[], baseY = 0, cursorY = lines.length - 1) {
  const active = {
    baseY,
    cursorY,
    cursorX: 0,
    length: lines.length,
    getLine: (y: number) => {
      const text = lines[y];
      return text === undefined ? undefined : { translateToString: () => text };
    },
  };
  // 按 ident 分发（T15 起 watch 同时挂 133 与 7 两个 handler）
  const byIdent = new Map<number, (data: string) => boolean>();
  const term: MinimalTerm = {
    parser: {
      registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
        byIdent.set(ident, cb);
        return { dispose: vi.fn() };
      },
    },
    buffer: { active },
  };
  const fire = (ident: number, data: string) => byIdent.get(ident)?.(data);
  return { term, fire, active };
}

describe("parseExitCode", () => {
  it("D;0 / D;127 / D;-1 → 数值；D / D;abc → null；A/C/其他 → null", () => {
    expect(parseExitCode("D;0")).toBe(0);
    expect(parseExitCode("D;127")).toBe(127);
    expect(parseExitCode("D;-1")).toBe(-1);
    expect(parseExitCode("D")).toBeNull();
    expect(parseExitCode("D;abc")).toBeNull();
    expect(parseExitCode("A")).toBeNull();
    expect(parseExitCode("C")).toBeNull();
    expect(parseExitCode("133;D;1")).toBeNull();
  });
});

describe("bufferRangeText", () => {
  it("行区间提取 + 尾部空白清理 + 越界截断", () => {
    const { active } = fakeTerm(["$ ls -la", "total 0", "", "output"]);
    expect(bufferRangeText({ active }, 0, 2)).toBe("$ ls -la\ntotal 0");
    expect(bufferRangeText({ active }, 5, 9)).toBe("");
  });
});

describe("createCommandWatch", () => {
  function setup(lines: string[], baseY = 0) {
    const { term, fire, active } = fakeTerm(lines, baseY);
    const onCommandDone = vi.fn();
    const onCommandEnd = vi.fn();
    const onCommandFinished = vi.fn();
    createCommandWatch(term, { onCommandEnd, onCommandDone, onCommandFinished });
    return { fire, active, onCommandDone, onCommandEnd, onCommandFinished };
  }

  it("A(记行) → C(截命令) → D;1(触发，带命令与退出码)", () => {
    // 布局：0=旧输出 1=提示符+命令 2=光标行（C 时刻） 3..=输出
    const { fire, active, onCommandDone, onCommandEnd } = setup([
      "prev output",
      "web01:~ user$ ls /nonexistent",
      "",
      "ls: /nonexistent: No such file or directory",
    ]);
    active.cursorY = 1; // A：提示符行
    fire(133, "A");
    active.cursorY = 2; // C：光标已到下一行行首
    fire(133, "C");
    expect(onCommandEnd).toHaveBeenCalledWith("web01:~ user$ ls /nonexistent");
    fire(133, "D;1");
    expect(onCommandDone).toHaveBeenCalledWith({
      exitCode: 1,
      command: "web01:~ user$ ls /nonexistent",
    });
  });

  it("exit 0 不触发诊断（成功不打扰）", () => {
    const { fire, onCommandDone } = setup(["$ true", ""]);
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("D 无退出码不触发诊断（shell 未上报，安全侧）", () => {
    const { fire, onCommandDone } = setup(["$ x", ""]);
    fire(133, "A");
    fire(133, "C");
    fire(133, "D");
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("多行命令：A..C 之间多行都提取", () => {
    const { fire, active, onCommandDone } = setup(["cmd1 \\", "  && cmd2", ""]);
    active.cursorY = 0;
    fire(133, "A");
    active.cursorY = 2;
    fire(133, "C");
    fire(133, "D;2");
    expect(onCommandDone).toHaveBeenCalledWith({
      exitCode: 2,
      command: "cmd1 \\\n  && cmd2",
    });
  });

  it("缺 C 事件（只发 D 的集成形态）回退取光标上一行", () => {
    const { fire, active, onCommandDone } = setup(["prev", "$ bad-command", ""]);
    active.cursorY = 2; // D 时光标在输出后
    fire(133, "D;127");
    expect(onCommandDone).toHaveBeenCalledWith({ exitCode: 127, command: "$ bad-command" });
  });

  it("滚动后 baseY 参与绝对行号换算", () => {
    // baseY=10：视口顶在缓冲第 10 行；提示符在视口第 0 行 = 缓冲第 10 行
    const lines = Array.from({ length: 13 }, (_, i) => `line-${i}`);
    const { fire, active, onCommandDone } = setup(lines, 10);
    active.cursorY = 0;
    fire(133, "A"); // promptRow = 10
    active.cursorY = 1;
    fire(133, "C"); // 提取 [10,11) = line-10
    fire(133, "D;1");
    expect(onCommandDone).toHaveBeenCalledWith({ exitCode: 1, command: "line-10" });
  });

  it("同一 watch 连续多轮：上一轮状态复位", () => {
    const { fire, active, onCommandDone } = setup(["$ a", "", "$ b", ""]);
    active.cursorY = 0;
    fire(133, "A");
    active.cursorY = 1;
    fire(133, "C");
    fire(133, "D;1");
    active.cursorY = 2;
    fire(133, "A");
    active.cursorY = 3;
    fire(133, "C");
    fire(133, "D;1");
    expect(onCommandDone).toHaveBeenCalledTimes(2);
    expect(onCommandDone.mock.calls[1][0]).toEqual({ exitCode: 1, command: "$ b" });
  });

  // --- Task 15：onCommandFinished 全量完成事件 + OSC 7 cwd -------------------

  it("T15：exit 0 也发 onCommandFinished（历史全量入库，诊断仍不触发）", () => {
    const { fire, onCommandFinished, onCommandDone } = setup(["$ git status", ""]);
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandFinished).toHaveBeenCalledWith({
      exitCode: 0,
      command: "$ git status",
      cwd: null,
    });
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("T15：D 无退出码 → finished 带 exitCode=null（历史照记，诊断不触发）", () => {
    const { fire, onCommandFinished, onCommandDone } = setup(["$ x", ""]);
    fire(133, "A");
    fire(133, "C");
    fire(133, "D");
    expect(onCommandFinished).toHaveBeenCalledWith({
      exitCode: null,
      command: "$ x",
      cwd: null,
    });
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("T15：OSC 7 上报的 cwd 跟进到最近的提示符时点，随 finished 事件携带", () => {
    const { fire, onCommandFinished } = setup(["$ cd /srv && ls", ""]);
    // 提示符时点集成片段先发 7（当前目录）再 A：precmd 顺序 D→A→7 的稳态是
    // 「本条命令运行前 lastCwd 已就位」
    fire(7, "file://web01/srv/ottr");
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandFinished).toHaveBeenCalledWith({
      exitCode: 0,
      command: "$ cd /srv && ls",
      cwd: "/srv/ottr",
    });
  });

  it("T15：OSC 7 percent 解码 + 非 file 前缀/坏序列不认", () => {
    const { fire, onCommandFinished } = setup(["$ ls", ""]);
    fire(7, "file://web01/my%20docs");
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandFinished.mock.calls[0][0].cwd).toBe("/my docs");

    fire(7, "kitty-cwd:///elsewhere"); // 非 file 前缀：不更新
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandFinished.mock.calls[1][0].cwd).toBe("/my docs");

    fire(7, "file://web01/bad%2"); // 坏 percent 序列：原样保留（不丢路径）
    fire(133, "A");
    fire(133, "C");
    fire(133, "D;0");
    expect(onCommandFinished.mock.calls[2][0].cwd).toBe("/bad%2");
  });

  it("T15：dispose 同时摘除 133 与 7 两个 handler", () => {
    const { term } = fakeTerm(["$ x", ""]);
    const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const spy = vi
      .spyOn(term.parser, "registerOscHandler")
      .mockImplementation(() => {
        const d = { dispose: vi.fn() };
        disposables.push(d);
        return d as never;
      });
    const watch = createCommandWatch(term, { onCommandDone: vi.fn() });
    expect(spy).toHaveBeenCalledTimes(2);
    watch.dispose();
    expect(disposables[0].dispose).toHaveBeenCalled();
    expect(disposables[1].dispose).toHaveBeenCalled();
  });
});

describe("parseOsc7Cwd", () => {
  it("file://host/path → path（host 剥离、percent 解码）；非 file → null", () => {
    expect(parseOsc7Cwd("file://web01/srv/app")).toBe("/srv/app");
    expect(parseOsc7Cwd("file:///home/u")).toBe("/home/u");
    expect(parseOsc7Cwd("file://web01/a%20b")).toBe("/a b");
    expect(parseOsc7Cwd("file://web01/bad%ZZ")).toBe("/bad%ZZ");
    expect(parseOsc7Cwd("file://web01")).toBeNull();
    expect(parseOsc7Cwd("kitty-cwd:///x")).toBeNull();
  });
});
