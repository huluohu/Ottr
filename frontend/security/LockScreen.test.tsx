// LockScreen 组件测试（T11）：锁定遮罩渲染、空密码本地拦截、错误密码走 store
// 错误面（Rust BadMasterPassword 消息映射为友好文案）、解锁成功调用。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// 词典断言用中文：在 import 前钉住 navigator.language（i18n 实例按它初始化）。
vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

import "../i18n";
import { LockScreen } from "./LockScreen";
import { resetVaultLockStoreForTest, useVaultLockStore } from "./VaultLockStore";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  resetVaultLockStoreForTest();
});

afterEach(() => cleanup());

describe("LockScreen", () => {
  it("渲染遮罩：标题 + 密码框 + 解锁按钮", () => {
    render(<LockScreen />);
    expect(screen.getByTestId("lock-screen")).toBeTruthy();
    expect(screen.getByTestId("lock-password")).toBeTruthy();
    expect(screen.getByTestId("lock-unlock").textContent).toBe("解锁");
  });

  it("空密码：本地拦截（不发起 invoke）", async () => {
    render(<LockScreen />);
    fireEvent.click(screen.getByTestId("lock-unlock"));
    await waitFor(() =>
      expect(screen.getByTestId("lock-error").textContent).toBe("请输入主密码"),
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("密码错误：Rust 错误串映射为「主密码不正确」，phase 不翻转", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_unlock") return Promise.reject("vault is locked: master password is incorrect");
      return Promise.reject(new Error(cmd));
    });
    render(<LockScreen />);
    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("lock-unlock"));
    await waitFor(() =>
      expect(screen.getByTestId("lock-error").textContent).toBe("主密码不正确"),
    );
    // store 侧 error 已置位（调用方 App 的遮罩仍由 locked 事件/状态驱动）
    expect(useVaultLockStore.getState().phase).toBe("boot");
    expect(useVaultLockStore.getState().error).toContain("master password is incorrect");
  });

  it("解锁成功：vault_unlock 携密码调用，error 清空", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_unlock") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    render(<LockScreen />);
    fireEvent.change(screen.getByTestId("lock-password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("lock-unlock"));
    await waitFor(() => expect(useVaultLockStore.getState().phase).toBe("unlocked"));
    expect(mockedInvoke).toHaveBeenCalledWith("vault_unlock", { password: "correct horse" });
    expect(useVaultLockStore.getState().error).toBeNull();
  });
});

// --- 忘记密码？引导（product-ready T5，BL-537 清偿）---------------------------
// 主密码不可找回（加密语义），唯一出路 = 重置应用（1Password 同款）。交互契约：
// 入口常在（锁定屏被困死时必须可达）→ 说明区就地展开（不弹窗）→ danger 二击
// 确认（armed 语义沿 InsertRow T13）→ vault_reset(confirm=true)。

describe("LockScreen 忘记密码引导", () => {
  it("入口默认可见、说明区默认收起（不抢解锁主视觉）", () => {
    render(<LockScreen />);
    expect(screen.getByTestId("lock-forgot").textContent).toBe("忘记密码？");
    expect(screen.queryByTestId("lock-reset-panel")).toBeNull();
    expect(screen.queryByTestId("lock-reset-arm")).toBeNull();
  });

  it("展开说明区：含不可找回/清库/云同步三段语义；二次确认前不调 vault_reset", () => {
    mockedInvoke.mockResolvedValue(null);
    render(<LockScreen />);
    fireEvent.click(screen.getByTestId("lock-forgot"));
    const panel = screen.getByTestId("lock-reset-panel");
    expect(panel.textContent).toContain("无法找回");
    expect(panel.textContent).toContain("清空本机库");
    expect(panel.textContent).toContain("云同步");
    // 一击：armed（按钮变「确认重置」），尚未发起命令
    const arm = screen.getByTestId("lock-reset-arm");
    expect(arm.textContent).toBe("我已知晓，重置应用");
    fireEvent.click(arm);
    expect(screen.getByTestId("lock-reset-arm").textContent).toBe("确认重置");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("armed 二击后调用 vault_reset（confirm: true）", () => {
    mockedInvoke.mockResolvedValue(null);
    render(<LockScreen />);
    fireEvent.click(screen.getByTestId("lock-forgot"));
    fireEvent.click(screen.getByTestId("lock-reset-arm"));
    fireEvent.click(screen.getByTestId("lock-reset-arm"));
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("vault_reset", { confirm: true });
  });

  it("收起说明区即解除 armed（重开从一击开始）", () => {
    mockedInvoke.mockResolvedValue(null);
    render(<LockScreen />);
    fireEvent.click(screen.getByTestId("lock-forgot"));
    fireEvent.click(screen.getByTestId("lock-reset-arm")); // armed
    fireEvent.click(screen.getByTestId("lock-forgot")); // 收起
    fireEvent.click(screen.getByTestId("lock-forgot")); // 再展开
    expect(screen.getByTestId("lock-reset-arm").textContent).toBe("我已知晓，重置应用");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("reset 失败：错误如实上屏（面板内红字），不静默伪装成功", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "vault_reset") return Promise.reject("keychain delete: access denied");
      return Promise.reject(new Error(cmd));
    });
    render(<LockScreen />);
    fireEvent.click(screen.getByTestId("lock-forgot"));
    fireEvent.click(screen.getByTestId("lock-reset-arm"));
    fireEvent.click(screen.getByTestId("lock-reset-arm"));
    await waitFor(() =>
      expect(screen.getByTestId("lock-reset-error").textContent).toContain(
        "keychain delete: access denied",
      ),
    );
    // 错误后可再次二击重试（残余数据重试语义：命令未成功，armed 保持）
    expect(screen.getByTestId("lock-reset-arm").textContent).toBe("确认重置");
  });

  it("i18n：新增键 zh-CN 与 en-US 双语齐备（zh 含 CJK、en 无 CJK）", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // vitest cwd = 项目根；直接按根相对路径读词典源文件（不用 import：与
    // i18n.test 同理，避免 i18n 实例 resources 共享对象引用互相污染）。
    const read = (f: string) => readFileSync(resolve(process.cwd(), "frontend/i18n", f), "utf-8");
    const zh = JSON.parse(read("zh-CN.json")) as Record<string, unknown>;
    const en = JSON.parse(read("en-US.json")) as Record<string, unknown>;
    const keys = [
      "security.lockScreen.forgot",
      "security.lockScreen.resetTitle",
      "security.lockScreen.resetNoRecover",
      "security.lockScreen.resetExplain",
      "security.lockScreen.resetSyncNote",
      "security.lockScreen.resetArm",
      "security.lockScreen.resetArmed",
    ];
    const pick = (obj: Record<string, unknown>, path: string): string => {
      let cur: unknown = obj;
      for (const seg of path.split(".")) {
        cur = (cur as Record<string, unknown>)[seg];
      }
      return String(cur);
    };
    const hasCJK = (s: string) => /[\u4e00-\u9fff]/.test(s);
    for (const key of keys) {
      const zhVal = pick(zh, key);
      const enVal = pick(en, key);
      expect(zhVal.length).toBeGreaterThan(0);
      expect(enVal.length).toBeGreaterThan(0);
      expect(hasCJK(zhVal)).toBe(true);
      expect(hasCJK(enVal)).toBe(false);
    }
  });
});
