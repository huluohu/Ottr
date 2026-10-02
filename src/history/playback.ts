// playback.ts（Phase 3 Task 5，B3）：asciinema 回放的**纯调度核**——时间推进、
// 事件定位（seek）、倍速。与渲染面（RecordingPlayer 的 xterm 实例）解耦：
// tick(dt) 只返回「该写进终端的数据块」，组件负责 write/reset。纯函数式推进
// 让 seek/倍速的边界语义可被 vitest 精确断言（xterm 不进测试）。
//
// seek 语义（asciinema 官方播放器同款）：
// * 前跳：只补写 (old, new] 区间的事件——终端状态 = 逐事件累积，不重放；
// * 后跳：无法撤销已写内容 → 组件 term.reset() 后从 0 重放到新位置
//   （controller.seek 返回重放事件流，组件一次 write 完）。

/** 回放事件（Rust CastEvent 同构；录制面只产 "o" 事件）。 */
export interface CastEventLite {
  time: number;
  data: string;
}

/** 倍速档位（简报定值 0.5/1/2/4）。 */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export class PlaybackController {
  private events: CastEventLite[];
  /** 下一个待消费事件的下标（pos 单调推进时不回退）。 */
  private cursor = 0;
  private _pos = 0;
  private _speed: PlaybackSpeed = 1;

  constructor(events: CastEventLite[]) {
    // 时间序防御：录制面保证单调，外部文件（导出再导入）仍兜底排序
    this.events = [...events].sort((a, b) => a.time - b.time);
  }

  /** 当前播放头（秒）。 */
  get pos(): number {
    return this._pos;
  }

  /** 时长 = 末事件时间（空录制 = 0；与 Rust 端 duration 同口径）。 */
  get duration(): number {
    return this.events.length > 0 ? this.events[this.events.length - 1].time : 0;
  }

  get speed(): PlaybackSpeed {
    return this._speed;
  }

  setSpeed(s: PlaybackSpeed): void {
    this._speed = s;
  }

  /** 是否已到末尾（播放头 ≥ 时长）。 */
  get ended(): boolean {
    return this._pos >= this.duration;
  }

  /**
   * 推进 `dt` 秒（真实墙钟 × 倍速由调用方换算：传 dt = wall × speed 或先
   * setSpeed 后由本方法乘——本方法乘，调用方传未放大的墙钟秒）。返回区间
   * (old, new] 内应写入的事件数据块（时间序）。
   */
  tick(dtSeconds: number): string[] {
    return this.advanceTo(this._pos + Math.max(0, dtSeconds) * this._speed).chunks;
  }

  /**
   * 定位到 `t` 秒（拖动时间轴）。返回定位说明：
   * * forward = true：chunks 是 (old, t] 增量（直接 write）；
   * * forward = false：chunks 是 [0, t] 全量重放（组件先 reset 再 write）。
   */
  seek(t: number): { forward: boolean; chunks: string[] } {
    const target = Math.min(Math.max(0, t), this.duration);
    const forward = target >= this._pos;
    const { chunks } = this.advanceTo(target, !forward);
    return { forward, chunks };
  }

  /** 推进到 target（可选从 0 重扫），消费经过的事件并更新 cursor/pos。 */
  private advanceTo(
    target: number,
    fromZero = false,
  ): { pos: number; chunks: string[] } {
    if (fromZero) {
      this.cursor = 0;
      this._pos = 0;
    }
    const chunks: string[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].time <= target) {
      chunks.push(this.events[this.cursor].data);
      this.cursor += 1;
    }
    // 播放头收敛到 [0, duration]（tick 过冲/seek 越界都夹住；ended 语义简单）。
    this._pos = Math.min(Math.max(target, 0), this.duration);
    return { pos: this._pos, chunks };
  }
}

/** mm:ss 展示（时间轴/时长标签）。 */
export function formatPlaybackTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
