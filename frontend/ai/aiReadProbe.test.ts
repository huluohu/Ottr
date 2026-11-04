// AI 只读探查总开关（2026-11-04 修补 B3）纯函数测试：
//   * 默认开（无存档 → 开）；
//   * 存本机 localStorage（**不进 vault**——不同步）；
//   * 写档失败不阻塞（隐私模式）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_READ_PROBE_STORAGE_KEY,
  readAiReadProbeEnabled,
  writeAiReadProbeEnabled,
} from "./aiReadProbe";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("AI 只读探查总开关", () => {
  it("默认开（无存档 → 开）", () => {
    expect(readAiReadProbeEnabled()).toBe(true);
  });

  it("关闭后读回为关，且存档落在本机 localStorage（键 ottr.ai.readProbe）", () => {
    writeAiReadProbeEnabled(false);
    expect(localStorage.getItem(AI_READ_PROBE_STORAGE_KEY)).toBe("off");
    expect(readAiReadProbeEnabled()).toBe(false);
    writeAiReadProbeEnabled(true);
    expect(readAiReadProbeEnabled()).toBe(true);
  });

  it("存档被手改成非法值 → 回落默认开（不落到更宽松/更严的意外档）", () => {
    localStorage.setItem(AI_READ_PROBE_STORAGE_KEY, "maybe");
    expect(readAiReadProbeEnabled()).toBe(true);
  });

  it("读档抛错（隐私模式）→ 回落默认开，不崩", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readAiReadProbeEnabled()).toBe(true);
  });

  it("写档抛错 → 不抛（不阻塞设置页交互）", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeAiReadProbeEnabled(false)).not.toThrow();
  });
});
