// CommandWatch（OSC133 监听）测试：A/C/D 三标记驱动命令提取与失败触发。
import { describe, expect, it, vi } from "vitest";
import {
  bufferRangeText,
  createCommandWatch,
  parseExitCode,
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
  const handler = vi.fn();
  const term: MinimalTerm = {
    parser: {
      registerOscHandler: (_ident: number, cb: (data: string) => boolean) => {
        handler.mockImplementation((data: string) => cb(data));
        return { dispose: vi.fn() };
      },
    },
    buffer: { active },
  };
  return { term, handler, active };
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
    const { term, handler, active } = fakeTerm(lines, baseY);
    const onCommandDone = vi.fn();
    const onCommandEnd = vi.fn();
    createCommandWatch(term, { onCommandEnd, onCommandDone });
    return { handler, active, onCommandDone, onCommandEnd };
  }

  it("A(记行) → C(截命令) → D;1(触发，带命令与退出码)", () => {
    // 布局：0=旧输出 1=提示符+命令 2=光标行（C 时刻） 3..=输出
    const { handler, active, onCommandDone, onCommandEnd } = setup([
      "prev output",
      "web01:~ user$ ls /nonexistent",
      "",
      "ls: /nonexistent: No such file or directory",
    ]);
    active.cursorY = 1; // A：提示符行
    handler("A");
    active.cursorY = 2; // C：光标已到下一行行首
    handler("C");
    expect(onCommandEnd).toHaveBeenCalledWith("web01:~ user$ ls /nonexistent");
    handler("D;1");
    expect(onCommandDone).toHaveBeenCalledWith({
      exitCode: 1,
      command: "web01:~ user$ ls /nonexistent",
    });
  });

  it("exit 0 不触发（成功不打扰）", () => {
    const { handler, onCommandDone } = setup(["$ true", ""]);
    handler("A");
    handler("C");
    handler("D;0");
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("D 无退出码不触发（shell 未上报，安全侧）", () => {
    const { handler, onCommandDone } = setup(["$ x", ""]);
    handler("A");
    handler("C");
    handler("D");
    expect(onCommandDone).not.toHaveBeenCalled();
  });

  it("多行命令：A..C 之间多行都提取", () => {
    const { handler, active, onCommandDone } = setup(["cmd1 \\", "  && cmd2", ""]);
    active.cursorY = 0;
    handler("A");
    active.cursorY = 2;
    handler("C");
    handler("D;2");
    expect(onCommandDone).toHaveBeenCalledWith({
      exitCode: 2,
      command: "cmd1 \\\n  && cmd2",
    });
  });

  it("缺 C 事件（只发 D 的集成形态）回退取光标上一行", () => {
    const { handler, active, onCommandDone } = setup(["prev", "$ bad-command", ""]);
    active.cursorY = 2; // D 时光标在输出后
    handler("D;127");
    expect(onCommandDone).toHaveBeenCalledWith({ exitCode: 127, command: "$ bad-command" });
  });

  it("滚动后 baseY 参与绝对行号换算", () => {
    // baseY=10：视口顶在缓冲第 10 行；提示符在视口第 0 行 = 缓冲第 10 行
    const lines = Array.from({ length: 13 }, (_, i) => `line-${i}`);
    const { handler, active, onCommandDone } = setup(lines, 10);
    active.cursorY = 0;
    handler("A"); // promptRow = 10
    active.cursorY = 1;
    handler("C"); // 提取 [10,11) = line-10
    handler("D;1");
    expect(onCommandDone).toHaveBeenCalledWith({ exitCode: 1, command: "line-10" });
  });

  it("同一 watch 连续多轮：上一轮状态复位", () => {
    const { handler, active, onCommandDone } = setup(["$ a", "", "$ b", ""]);
    active.cursorY = 0;
    handler("A");
    active.cursorY = 1;
    handler("C");
    handler("D;1");
    active.cursorY = 2;
    handler("A");
    active.cursorY = 3;
    handler("C");
    handler("D;1");
    expect(onCommandDone).toHaveBeenCalledTimes(2);
    expect(onCommandDone.mock.calls[1][0]).toEqual({ exitCode: 1, command: "$ b" });
  });
});
