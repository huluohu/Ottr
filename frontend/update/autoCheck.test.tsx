// autoCheck 单测（2026-10-13 自动检查更新）：三模式调度 / 便携禁用 / 静默
// UX（只有「发现新版本」发声）/ 设置页即改即生效。真实 updateStore +
// toastStore 集成面；mock：updater check、app_portable、vault settings。
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
  applyAutoCheckMode,
  initAutoCheck,
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
  useUpdateStore.setState({ current: "0.9.5", portable: false, phase: { kind: "idle" } });
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
    await applyAutoCheckMode("off");
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

  it("startup：发现新版本 → 单条 toast 带「下载并安装」，不自动下载", async () => {
    render(<Toaster />);
    checkMock.mockResolvedValue(fakeUpdate("0.9.6"));
    settingsGetMock.mockResolvedValue("startup");
    await act(async () => {
      await initAutoCheck();
    });
    const actionToast = useToastStore.getState().toasts.find((t) => t.action);
    expect(actionToast?.message).toContain("v0.9.6");
    expect(actionToast?.action?.label).toBe("Download & install");
    expect(useUpdateStore.getState().phase.kind).toBe("available");
    expect(useToastStore.getState().toasts.some((t) => t.message.includes("Checking"))).toBe(
      false,
    );
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

  it("设置页即改即生效：applyAutoCheckMode('startup') 立即按新模式调度", async () => {
    await act(async () => {
      await initAutoCheck(); // 以 off 启动
    });
    expect(checkMock).not.toHaveBeenCalled();
    checkMock.mockResolvedValue(fakeUpdate("0.9.6"));
    await act(async () => {
      await applyAutoCheckMode("startup");
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts.some((t) => t.action)).toBe(true);
  });

  it("非法配置值按 off 处理（安全侧：不查）", async () => {
    settingsGetMock.mockResolvedValue("every-hour");
    await act(async () => {
      await initAutoCheck();
    });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("配置键 = update.check_mode", async () => {
    settingsGetMock.mockClear();
    await act(async () => {
      await initAutoCheck();
    });
    expect(settingsGetMock).toHaveBeenCalledWith(SETTING_UPDATE_CHECK_MODE);
  });
});
