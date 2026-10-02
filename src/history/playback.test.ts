// playback 纯调度核测试（Task 5 Step 3，TDD）：tick 事件消费边界、倍速缩放、
// seek 前跳增量/后跳全量重放、duration/ended、空录制。
import { describe, expect, it } from "vitest";
import { PlaybackController, formatPlaybackTime, PLAYBACK_SPEEDS } from "./playback";

const events = [
  { time: 0.1, data: "a" },
  { time: 0.5, data: "b" },
  { time: 1.0, data: "c" },
  { time: 2.0, data: "d" },
];

describe("PlaybackController", () => {
  it("tick 按墙钟×倍速推进并消费 (old, new] 区间事件", () => {
    const c = new PlaybackController(events);
    expect(c.duration).toBe(2.0);
    expect(c.pos).toBe(0);
    expect(c.tick(0.1)).toEqual(["a"]); // t=0.1：time<=0.1 的事件消费
    expect(c.tick(0.2)).toEqual([]); // t=0.3：无事件
    expect(c.tick(0.2)).toEqual(["b"]); // t=0.5
    expect(c.tick(0.5)).toEqual(["c"]); // t=1.0
    expect(c.pos).toBe(1);
    // 倍速：4× 下 tick(0.25) 推进 1s
    c.setSpeed(4);
    expect(c.tick(0.25)).toEqual(["d"]);
    expect(c.pos).toBe(2);
    expect(c.ended).toBe(true);
    // 结束后再 tick 不再产块、不越界
    expect(c.tick(10)).toEqual([]);
    expect(c.pos).toBe(2);
  });

  it("0.5× 倍速下推进减半；speed 档位表 = 0.5/1/2/4", () => {
    const c = new PlaybackController(events);
    c.setSpeed(0.5);
    expect(c.tick(1)).toEqual(["a", "b"]); // 墙钟 1s → 播放头 0.5s，两个事件
    expect(c.pos).toBeCloseTo(0.5);
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 4]);
  });

  it("seek 前跳 = 增量；后跳 = 全量重放且 cursor 复位", () => {
    const c = new PlaybackController(events);
    c.tick(1.0); // 消费 a b c
    // 前跳 1.9：末事件在 2.0 未过 → 空增量
    expect(c.seek(1.9)).toEqual({ forward: true, chunks: [] });
    // 前跳 2.0：只补 d
    expect(c.seek(2.0)).toEqual({ forward: true, chunks: ["d"] });
    // 后跳 0.5：全量 [0, 0.5]
    expect(c.seek(0.5)).toEqual({ forward: false, chunks: ["a", "b"] });
    expect(c.pos).toBe(0.5);
    // 从 0.5 继续 tick：只补后文
    expect(c.tick(0.5)).toEqual(["c"]);
    // 越界 seek 夹到 [0, duration]（t=0 重放到头，a 在 0.1 未过 → 空）
    expect(c.seek(-1)).toEqual({ forward: false, chunks: [] });
    expect(c.seek(99)).toEqual({ forward: true, chunks: ["a", "b", "c", "d"] });
    expect(c.pos).toBe(2);
  });

  it("空录制：duration 0、tick/seek 恒空、ended 恒真", () => {
    const c = new PlaybackController([]);
    expect(c.duration).toBe(0);
    expect(c.tick(1)).toEqual([]);
    expect(c.seek(0.5)).toEqual({ forward: true, chunks: [] });
    expect(c.ended).toBe(true);
  });

  it("打乱输入时间序仍按序消费（导出再导入防御）", () => {
    const c = new PlaybackController([events[2], events[0], events[1]]);
    expect(c.tick(0.5)).toEqual(["a", "b"]);
  });
});

describe("formatPlaybackTime", () => {
  it("mm:ss 补零", () => {
    expect(formatPlaybackTime(0)).toBe("00:00");
    expect(formatPlaybackTime(65.7)).toBe("01:05");
    expect(formatPlaybackTime(-3)).toBe("00:00");
  });
});
