// ottyStore 单测：单槽队列（同时最多一个 Otty）、队列上限、开关关闭即丢弃、
// 弱动效偏好跳过、finish 自动出队。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTTY_MOMENT_MS, useOttyStore } from "./ottyStore";

function reset(enabled = true) {
  useOttyStore.setState({ current: null, queue: [], enabled });
}

beforeEach(() => {
  reset();
  // jsdom 无 matchMedia：默认按「无弱动效偏好」处理
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ottyStore（情感时刻调度）", () => {
  it("play：空槽即入场；再 play 排队不替换（同一时刻最多一个 Otty）", () => {
    useOttyStore.getState().play("connect");
    expect(useOttyStore.getState().current).toBe("connect");
    useOttyStore.getState().play("transfer");
    useOttyStore.getState().play("unlock");
    expect(useOttyStore.getState().current).toBe("connect");
    expect(useOttyStore.getState().queue).toEqual(["transfer", "unlock"]);
  });

  it("finish：当前出队、队首自动接续；空队清场", () => {
    useOttyStore.getState().play("connect");
    useOttyStore.getState().play("transfer");
    useOttyStore.getState().finish();
    expect(useOttyStore.getState().current).toBe("transfer");
    useOttyStore.getState().finish();
    expect(useOttyStore.getState().current).toBeNull();
    expect(useOttyStore.getState().queue).toEqual([]);
  });

  it("队列上限 3：爆量丢弃（批量连发不刷屏）", () => {
    useOttyStore.getState().play("connect");
    for (const m of ["transfer", "unlock", "update", "transfer"] as const) {
      useOttyStore.getState().play(m);
    }
    expect(useOttyStore.getState().queue.length).toBe(3);
    expect(useOttyStore.getState().queue).toEqual(["transfer", "unlock", "update"]);
  });

  it("开关关闭：play 直接丢弃（含空槽）", () => {
    reset(false);
    useOttyStore.getState().play("connect");
    expect(useOttyStore.getState().current).toBeNull();
  });

  it("弱动效偏好：play 跳过（纯装饰非理解性反馈）", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    useOttyStore.getState().play("connect");
    expect(useOttyStore.getState().current).toBeNull();
  });

  it("OTTY_MOMENT_MS 与 tokens.css --dur-otty-moment 同值（2.4s；改两处同步）", () => {
    expect(OTTY_MOMENT_MS).toBe(2400);
  });
});
