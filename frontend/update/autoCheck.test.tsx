// autoCheck 单测（2026-10-13 自动检查更新）：三模式调度 / 便携禁用 / 静默
// UX（2026-10-26 起全程静默：发现新版本也不弹 toast，只落 store 让图标轨
// 更新钮浮现）/ 设置页即改即生效。真实 updateStore + toastStore 集成面；
// mock：updater check、app_portable、vault settings。
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const invokeMock = vi.fn();
const settingsGetMock = vi.fn();
const settingsSetMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...a: unknown[]) => checkMock(...a),
  Update: class {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));
vi.mock("../vault/api", () => ({
  vaultApi: {
    settings: {
      get: (...a: unknown[]) => settingsGetMock(...a),
      set: (...a: unknown[]) => settingsSetMock(...a),
    },
  },
}));

import "../i18n";
import { Toaster } from "../ui/Toaster";
import { useToastStore } from "../ui/toastStore";
import {
  __resetForTests,
  applyAutoCheckSetting,
  initAutoCheck,
  parseSetting,
  encodeSetting,
  SETTING_UPDATE_CHECK_MODE,
} from "./autoCheck";
import { useUpdateStore } from "./updateStore";

function fakeUpdate(version: string) {
  return {
    version,
    downloadAndInstall: async () => {},
  };
}

beforeEach(() => {
  __resetForTests();
  useToastStore.setState({ toasts: [] });
  useUpdateStore.setState({ current: "0.9.5", portable: false, phase: { kind: "idle" }, info: null });
  checkMock.mockReset();
  invokeMock.mockReset();
  settingsGetMock.mockReset();
  settingsSetMock.mockReset();
  settingsGetMock.mockResolvedValue("off");
  settingsSetMock.mockResolvedValue(undefined);
  invokeMock.mockResolvedValue(false); // app_portable = false
  checkMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  // 模块级 armed/计时器状态：每用例后以 off 重臂复位
  return act(async () => {
    await applyAutoCheckSetting({ kind: "off", hours: 24 });
  });
});

describe("autoCheck（自动检查更新）", () => {
  it("off：初始化后不发起任何检查", async () => {
    settingsGetMock.mockResolvedValue("off");
    await act(async () => {
      await initAutoCheck();
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("startup：启动即静默查一次；已是最新不发声（不打扰）", async () => {
    render(<Toaster />);
    settingsGetMock.mockResolvedValue("startup");
    await act(async () => {
      await initAutoCheck();
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("startup：发现新版本 → 不弹 toast，只落 store（图标轨据 info 浮现更新钮），不自动下载", async () => {
    render(<Toaster />);
    const dl = vi.fn(async () => {});
    checkMock.mockResolvedValue({ ...fakeUpdate("0.9.6"), downloadAndInstall: dl, body: "Ottr 0.9.6" });
    settingsGetMock.mockResolvedValue("startup");
    await act(async () => {
      await initAutoCheck();
    });
    // 2026-10-26 用户裁定：一次发现两处提醒是重复——自动路径零 toast
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useUpdateStore.getState().phase.kind).toBe("available");
    expect(useUpdateStore.getState().info).toEqual({ version: "0.9.6", date: null, body: "Ottr 0.9.6" });
    expect(dl).not.toHaveBeenCalled();
  });

  it("startup：检查出错保持静默（错误不上屏，手动入口才有完整反馈）", async () => {
    render(<Toaster />);
    checkMock.mockRejectedValue(new Error("network down"));
    settingsGetMock.mockResolvedValue("startup");
    await act(async () => {
      await initAutoCheck();
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("便携版：任何模式都不检查", async () => {
    invokeMock.mockResolvedValue(true); // app_portable = true
    settingsGetMock.mockResolvedValue("startup");
    await act(async () => {
      await initAutoCheck();
    });
    expect(checkMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("设置页即改即生效：applyAutoCheckSetting(startup) 立即按新模式调度", async () => {
    await act(async () => {
      await initAutoCheck(); // 以 off 启动
    });
    expect(checkMock).not.toHaveBeenCalled();
    checkMock.mockResolvedValue(fakeUpdate("0.9.6"));
    await act(async () => {
      await applyAutoCheckSetting({ kind: "startup", hours: 24 });
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().info?.version).toBe("0.9.6");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("非法配置值按 off 处理（安全侧：不查）", async () => {
    settingsGetMock.mockResolvedValue("every-hour");
    await act(async () => {
      await initAutoCheck();
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("档位编解码：interval:<小时> 与裸 interval（=24h 旧值）", () => {
    expect(parseSetting("interval:3")).toEqual({ kind: "interval", hours: 3 });
    expect(parseSetting("interval")).toEqual({ kind: "interval", hours: 24 });
    expect(parseSetting("off")).toEqual({ kind: "off", hours: 24 });
    expect(parseSetting("startup")).toEqual({ kind: "startup", hours: 24 });
    // 非法值（未知枚举 / 非法小时数）→ off（安全侧：不查）
    expect(parseSetting("daily")).toEqual({ kind: "off", hours: 24 });
    expect(parseSetting("interval:7")).toEqual({ kind: "off", hours: 24 });
    // 编解码互逆（24 小时档沿用裸值，不改写旧配置）
    expect(encodeSetting({ kind: "interval", hours: 24 })).toBe("interval");
    expect(encodeSetting({ kind: "interval", hours: 1 })).toBe("interval:1");
    expect(encodeSetting({ kind: "off", hours: 24 })).toBe("off");
  });

  it("定时检查：间隔小时数按设置生效（interval:1 → 满 1 小时复查一次）", async () => {
    vi.useFakeTimers();
    try {
      settingsGetMock.mockResolvedValue("interval:1");
      await act(async () => {
        await initAutoCheck();
      });
      expect(checkMock).toHaveBeenCalledTimes(1); // 启动即查一次
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
      });
      expect(checkMock).toHaveBeenCalledTimes(1); // 未到点
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2);
      });
      expect(checkMock).toHaveBeenCalledTimes(2); // 到点复查
    } finally {
      vi.useRealTimers();
    }
  });

  it("配置键 = update.check_mode", async () => {
    settingsGetMock.mockClear();
    await act(async () => {
      await initAutoCheck();
    });
    expect(settingsGetMock).toHaveBeenCalledWith(SETTING_UPDATE_CHECK_MODE);
  });
});
