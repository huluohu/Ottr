// SecuritySettings 组件测试（T11）：模式面分派（keyring 显示升级入口 / password
// 显示立即锁定 + 自动锁定配置）、升级向导三步（校验 → 进度事件 → 完成计数）、
// 安全配置改动写 settings（Rust 拒绝时回落）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

// 词典断言用中文：在 import 前钉住 navigator.language（i18n 实例按它初始化）。
vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

type ProgressHandler = (e: { payload: { done: number; total: number } }) => void;
let progressHandler: ProgressHandler | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: ProgressHandler) => {
    progressHandler = handler;
    return Promise.resolve(() => {
      progressHandler = null;
    });
  }),
}));

import "../i18n";
import { ThemeProvider } from "../theme/ThemeContext";
import { SecuritySettings } from "./SecuritySettings";
import { resetVaultLockStoreForTest, useVaultLockStore } from "./VaultLockStore";

const mockedInvoke = invoke as unknown as Mock;

function renderDialog() {
  return render(
    <ThemeProvider>
      <SecuritySettings open onClose={() => {}} />
    </ThemeProvider>,
  );
}

function seedMode(mode: "keyring" | "password", locked = false) {
  useVaultLockStore.setState({ phase: locked ? "locked" : "unlocked", mode, error: null });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  progressHandler = null;
  resetVaultLockStoreForTest();
  localStorage.clear();
  // jsdom 无 matchMedia（ThemeProvider 的 system 主题探测需要）
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
  cleanup();
  vi.unstubAllGlobals();
});

describe("SecuritySettings", () => {
  it("keyring 模式：钥匙链徽标 + 升级入口；无「立即锁定」、无自动锁定配置", async () => {
    seedMode("keyring");
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("vault-mode").textContent).toContain("系统钥匙链"));
    expect(screen.getByTestId("start-upgrade")).toBeTruthy();
    expect(screen.queryByTestId("lock-now")).toBeNull();
    expect(screen.queryByTestId("autolock-select")).toBeNull();
    // 剪贴板配置两种模式都有（复制动作在 keyring 模式同样存在）
    await waitFor(() => expect(screen.getByTestId("clipboard-select")).toBeTruthy());
  });

  it("password 模式：主密码徽标 + 立即锁定 + 自动锁定配置", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("vault-mode").textContent).toContain("主密码"));
    expect(screen.getByTestId("lock-now")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("autolock-select")).toBeTruthy());
    expect(screen.queryByTestId("start-upgrade")).toBeNull();
  });

  it("向导校验：短密码 / 两次不一致本地拦截，不发起升级", async () => {
    seedMode("keyring");
    renderDialog();
    fireEvent.click(screen.getByTestId("start-upgrade"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("wizard-confirm"), { target: { value: "short" } });
    fireEvent.click(screen.getByTestId("wizard-start"));
    await waitFor(() =>
      expect(screen.getByTestId("wizard-error").textContent).toContain("至少 8 位"),
    );
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "long enough 1" } });
    fireEvent.click(screen.getByTestId("wizard-start"));
    await waitFor(() =>
      expect(screen.getByTestId("wizard-error").textContent).toContain("两次输入不一致"),
    );
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "vault_upgrade_to_master_password"),
    ).toHaveLength(0);
  });

  it("向导完成：升级命令携密码、进度事件驱动计数、完成页展示字段数并翻模式", async () => {
    seedMode("keyring");
    let resolveUpgrade: ((fields: number) => void) | undefined;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "vault_upgrade_to_master_password") {
        return new Promise<number>((resolve) => {
          resolveUpgrade = resolve;
        });
      }
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    fireEvent.click(screen.getByTestId("start-upgrade"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "correct horse" } });
    fireEvent.change(screen.getByTestId("wizard-confirm"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("wizard-start"));

    // 进度事件（Rust ottr://reencrypt-progress）：2/4 → 文本即时更新
    await waitFor(() => expect(progressHandler).toBeTruthy());
    progressHandler!({ payload: { done: 2, total: 4 } });
    await waitFor(() =>
      expect(screen.getByTestId("wizard-progress-text").textContent).toBe("2/4"),
    );

    resolveUpgrade!(4);
    await waitFor(() => expect(screen.getByTestId("upgrade-done")).toBeTruthy());
    expect(screen.getByTestId("wizard-done-text").textContent).toContain("4");
    expect(mockedInvoke).toHaveBeenCalledWith("vault_upgrade_to_master_password", {
      password: "correct horse",
    });
  });

  it("升级失败：回第一步并展示错误（库原样未动，可重试）", async () => {
    seedMode("keyring");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "vault_upgrade_to_master_password") {
        return Promise.reject(new Error("crypto error: aead::Error"));
      }
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    fireEvent.click(screen.getByTestId("start-upgrade"));
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: "correct horse" } });
    fireEvent.change(screen.getByTestId("wizard-confirm"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByTestId("wizard-start"));
    await waitFor(() =>
      expect(screen.getByTestId("wizard-error").textContent).toContain("aead::Error"),
    );
    // 回到第一步（密码输入框重新可见）
    expect(screen.getByTestId("wizard-password")).toBeTruthy();
  });

  it("配置改动写 settings：autolock=0（关闭）→ settings_set 载荷正确", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    const select = (await waitFor(() => screen.getByTestId("autolock-select"))) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("10")); // 缺省回显 10
    fireEvent.change(select, { target: { value: "0" } });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "security.autolock_minutes",
        value: 0,
      }),
    );
  });

  it("手动锁定：vault_lock 调用 + store 落 locked", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "vault_lock") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    fireEvent.click(await waitFor(() => screen.getByTestId("lock-now")));
    await waitFor(() => expect(useVaultLockStore.getState().phase).toBe("locked"));
    expect(mockedInvoke).toHaveBeenCalledWith("vault_lock");
  });
});
