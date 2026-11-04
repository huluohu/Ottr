// orbStore 单测（Ask Ottr Task 4）：开关三态（null 未加载 → 球隐藏防闪烁）、
// vault 真源对齐、乐观镜像 + 代数计数（迟到旧保存不得覆盖新值）、保存失败
// 镜像保持 + toast 可见、位置 localStorage 持久化（读取校验 + 钳制 + 重置）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂被提升到文件顶——spy 必须经 vi.hoisted 创建方可被工厂引用。
const h = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../vault/api", () => ({
  vaultApi: { settings: { get: h.settingsGet, set: h.settingsSet } },
}));
vi.mock("../ui/toastStore", () => ({ showToast: h.showToast }));

import i18n from "../i18n";
import {
  ORB_POSITION_KEY,
  ORB_SETTING_KEY,
  normalizePosition,
  syncOrbFromVault,
  useOrbStore,
} from "./orbStore";

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 等 vault 落库链完整结算：setEnabled 的动态 import → settings.set →
 * catch/toast 链跨多个微任务拍（vitest 模块运行器还可能跨宏任务拍），裸
 * tick 等不满会让上一用例的在途保存泄漏进下一用例（吃掉它的 once-mock）。
 * 先等调用次数到位，再补一拍让 catch 分支走完。 */
async function awaitSettled(calls: number): Promise<void> {
  await vi.waitFor(() => expect(h.settingsSet).toHaveBeenCalledTimes(calls));
  await tick();
}

beforeEach(() => {
  localStorage.clear();
  useOrbStore.setState({ enabled: null, position: null });
  vi.clearAllMocks();
  h.settingsGet.mockResolvedValue(null);
  h.settingsSet.mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
});

describe("orbStore（Ask Ottr 悬浮球状态）", () => {
  it("syncFromVault：键缺省（null）→ enabled 落为 true（未加载态收敛为默认开，球不永久隐藏）", async () => {
    await syncOrbFromVault();
    expect(h.settingsGet).toHaveBeenCalledWith(ORB_SETTING_KEY);
    expect(useOrbStore.getState().enabled).toBe(true);
  });

  it("syncFromVault：读取 boolean 即镜像（false / true 各一枚）", async () => {
    h.settingsGet.mockResolvedValue(false);
    await syncOrbFromVault();
    expect(useOrbStore.getState().enabled).toBe(false);
    h.settingsGet.mockResolvedValue(true);
    await syncOrbFromVault();
    expect(useOrbStore.getState().enabled).toBe(true);
  });

  it("syncFromVault：vault 读失败 → 保持默认开（ottyStore 同口径：失败不改哑）", async () => {
    h.settingsGet.mockRejectedValue(new Error("boom"));
    await syncOrbFromVault();
    expect(useOrbStore.getState().enabled).toBe(true);
  });

  it("setEnabled：乐观镜像即时生效 + vault 保存（键、值正确；镜像同步、落库过微任务）", async () => {
    useOrbStore.getState().setEnabled(false);
    expect(useOrbStore.getState().enabled).toBe(false); // 镜像同步生效
    await awaitSettled(1); // 动态 import 的落库在微任务后发起
    expect(h.settingsSet).toHaveBeenCalledWith(ORB_SETTING_KEY, false);
    useOrbStore.getState().setEnabled(true);
    expect(useOrbStore.getState().enabled).toBe(true);
    await awaitSettled(2);
    expect(h.settingsSet).toHaveBeenCalledWith(ORB_SETTING_KEY, true);
  });

  it("代数计数：慢保存迟到了不覆盖新值（串行链下先放行①再等②，镜像以最后一次本地操作为准）", async () => {
    let resolveFirst!: () => void;
    h.settingsSet
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => Promise.resolve());
    useOrbStore.getState().setEnabled(false); // 保存①在途
    await awaitSettled(1); // 保存①已发起且挂起
    useOrbStore.getState().setEnabled(true); // 保存②排队（串行链尾）
    resolveFirst(); // 先放行保存①……
    await awaitSettled(2); // ……链尾保存②随之落盘
    expect(useOrbStore.getState().enabled).toBe(true);
    await tick();
    expect(useOrbStore.getState().enabled).toBe(true); // 不被旧值回写
  });

  it("代数计数：迟到旧保存失败不弹 toast（新值已落库，报错即谎报）", async () => {
    h.settingsSet
      .mockImplementationOnce(() => Promise.reject(new Error("slow boom")))
      .mockImplementationOnce(() => Promise.resolve());
    useOrbStore.getState().setEnabled(false);
    useOrbStore.getState().setEnabled(true);
    await awaitSettled(2); // 两笔保存的 catch 链都在本用例内走完
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it("保存失败：会话镜像保持（已生效）+ error toast 可见（当前代）", async () => {
    h.settingsSet.mockRejectedValueOnce(new Error("boom"));
    useOrbStore.getState().setEnabled(false);
    expect(useOrbStore.getState().enabled).toBe(false); // 镜像不回滚
    await awaitSettled(1);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(i18n.t("settings.askOttrOrbSaveFailed"), "error");
  });

  it("序列化落库：快速双 toggle 只有一条串行链，且每步写执行时点的当前期望值——磁盘终值 = 最后一次 toggle", async () => {
    const started: boolean[] = [];
    let resolveFirst!: () => void;
    h.settingsSet
      .mockImplementationOnce((_key: string, v: boolean) => {
        started.push(v);
        return new Promise<void>((r) => (resolveFirst = r));
      })
      .mockImplementationOnce((_key: string, v: boolean) => {
        started.push(v);
        return Promise.resolve();
      });
    useOrbStore.getState().setEnabled(false);
    useOrbStore.getState().setEnabled(true); // 镜像即时翻 true
    await tick(); // 步骤①起跑，步骤②仍在链上排队（严格串行）
    expect(started).toEqual([true]); // 步骤①写的是执行时点的当前值（true），非捕获旧值
    resolveFirst();
    await awaitSettled(2);
    expect(started).toEqual([true, true]); // 第二笔在第一笔落定后才发起（无并发写）
    const lastCall = h.settingsSet.mock.calls[h.settingsSet.mock.calls.length - 1];
    expect(lastCall?.[1]).toBe(true); // 磁盘终值 = 最新选择
  });

  it("在途保存中再 toggle：旧值先落盘也被链尾最新值覆盖（收敛，无多余写）", async () => {
    const saved: boolean[] = [];
    let resolveFirst!: () => void;
    h.settingsSet
      .mockImplementationOnce((_key: string, v: boolean) => {
        saved.push(v);
        return new Promise<void>((r) => (resolveFirst = r));
      })
      .mockImplementationOnce((_key: string, v: boolean) => {
        saved.push(v);
        return Promise.resolve();
      });
    useOrbStore.getState().setEnabled(false);
    await awaitSettled(1); // 步骤①执行中（写 false、挂起）
    useOrbStore.getState().setEnabled(true); // 镜像 true，步骤②排队
    resolveFirst(); // 步骤①带着旧值 false 落盘……
    await awaitSettled(2); // ……链尾步骤②立即用最新值 true 覆盖
    expect(saved).toEqual([false, true]);
    expect(useOrbStore.getState().enabled).toBe(true);
    expect(h.settingsSet).toHaveBeenCalledTimes(2); // 恰两笔：无并发写、无多余写
  });

  it("链式失败：中间步骤失败静默（会被后续步骤重写），仅最终失败弹一次 toast；失败不断链、无 unhandled rejection", async () => {
    h.settingsSet.mockRejectedValue(new Error("boom"));
    useOrbStore.getState().setEnabled(false); // gen1（中间）
    useOrbStore.getState().setEnabled(true); // gen2（中间）
    useOrbStore.getState().setEnabled(false); // gen3（当前代）
    await awaitSettled(3);
    expect(h.settingsSet).toHaveBeenCalledTimes(3); // 链未因失败断裂
    expect(h.showToast).toHaveBeenCalledTimes(1); // 仅当前代可见
  });

  it("setPosition：fraction 钳制 0..1 并持久化 localStorage", () => {
    useOrbStore.getState().setPosition({ edge: "left", fraction: 1.4 });
    expect(useOrbStore.getState().position).toEqual({ edge: "left", fraction: 1 });
    useOrbStore.getState().setPosition({ edge: "bottom", fraction: -0.2 });
    expect(useOrbStore.getState().position).toEqual({ edge: "bottom", fraction: 0 });
    const raw = localStorage.getItem(ORB_POSITION_KEY);
    expect(JSON.parse(raw ?? "null")).toEqual({ edge: "bottom", fraction: 0 });
  });

  it("resetPosition：清 localStorage + 归位 null（球回默认位）", () => {
    useOrbStore.getState().setPosition({ edge: "top", fraction: 0.3 });
    expect(localStorage.getItem(ORB_POSITION_KEY)).not.toBeNull();
    useOrbStore.getState().resetPosition();
    expect(useOrbStore.getState().position).toBeNull();
    expect(localStorage.getItem(ORB_POSITION_KEY)).toBeNull();
  });

  it("normalizePosition：非法形状弃用、越界 fraction 钳制（读档防线）", () => {
    expect(normalizePosition(null)).toBeNull();
    expect(normalizePosition("garbage")).toBeNull();
    expect(normalizePosition({ edge: "diagonal", fraction: 0.5 })).toBeNull();
    expect(normalizePosition({ edge: "left", fraction: "0.5" })).toBeNull();
    expect(normalizePosition({ edge: "right", fraction: 7 })).toEqual({ edge: "right", fraction: 1 });
    expect(normalizePosition({ edge: "top", fraction: 0.25 })).toEqual({ edge: "top", fraction: 0.25 });
  });

  it("启动读档：合法存档恢复、损坏 JSON 弃用（球回默认位不崩）", async () => {
    localStorage.setItem(ORB_POSITION_KEY, JSON.stringify({ edge: "left", fraction: 0.8 }));
    const { readStoredPosition } = await import("./orbStore");
    expect(readStoredPosition()).toEqual({ edge: "left", fraction: 0.8 });
    localStorage.setItem(ORB_POSITION_KEY, "{not json");
    expect(readStoredPosition()).toBeNull();
    localStorage.setItem(ORB_POSITION_KEY, JSON.stringify({ edge: "left", fraction: 9 }));
    expect(readStoredPosition()).toEqual({ edge: "left", fraction: 1 });
  });
});
