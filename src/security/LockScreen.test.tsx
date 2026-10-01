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
