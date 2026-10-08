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

  // BL-202：长度口径必须与 Rust 侧权威校验（ottr-vault store.rs
  // MASTER_PASSWORD_MIN_LEN，`chars().count()` = Unicode 码点数）同语义。
  // JS `"😀".length` 是 UTF-16 码元数（增补平面字符 = 2），4 个 emoji 的
  // `.length` 恰为 8——旧口径会放行、后端再以「至少 8 位」拒绝（前端预检
  // 与权威门卫各说各话）。码点口径（[...password].length）下它必须本地拦截。
  it("向导校验：增补平面字符按码点计数——4 个 emoji（UTF-16 长度恰 8）本地拦截", async () => {
    seedMode("keyring");
    renderDialog();
    fireEvent.click(screen.getByTestId("start-upgrade"));
    const fourEmoji = "😀😀😀😀"; // 4 码点 / 8 UTF-16 码元
    expect(fourEmoji.length).toBe(8); // 守住本例与旧口径的分歧前提
    fireEvent.change(screen.getByTestId("wizard-password"), { target: { value: fourEmoji } });
    fireEvent.change(screen.getByTestId("wizard-confirm"), { target: { value: fourEmoji } });
    fireEvent.click(screen.getByTestId("wizard-start"));
    await waitFor(() =>
      expect(screen.getByTestId("wizard-error").textContent).toContain("至少 8 位"),
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

  it("关窗到托盘（A12）：默认开（未设置）；取消勾选写 ui.close_to_tray=0", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    const toggle = (await waitFor(() =>
      screen.getByTestId("close-to-tray-toggle"),
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(true); // 未设置 = 开（Rust 侧同口径）
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "ui.close_to_tray",
        value: 0,
      }),
    );
  });

  it("关窗到托盘（A12）：ui.close_to_tray=0 回显关", async () => {
    seedMode("keyring");
    mockedInvoke.mockImplementation((cmd: string, args?: { key: string }) => {
      if (cmd === "settings_get") {
        return Promise.resolve(args?.key === "ui.close_to_tray" ? 0 : null);
      }
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    const toggle = (await waitFor(() =>
      screen.getByTestId("close-to-tray-toggle"),
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("shell 集成注入开关（T15 fix 1/5）：false 回显关；切换写 shell.integration 布尔；缺省回显开", async () => {
    seedMode("keyring");
    mockedInvoke.mockImplementation((cmd: string, args?: { key: string; value: unknown }) => {
      if (cmd === "settings_get") {
        return Promise.resolve(args?.key === "shell.integration" ? false : null);
      }
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    // 存量 false → 回显关
    const toggle = (await waitFor(() =>
      screen.getByTestId("shell-integration-toggle"),
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    // 切开 → settings_set 布尔 true
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "shell.integration",
        value: true,
      }),
    );

    // 缺省（settings_get 全 null）→ 回显开（Rust 侧缺省开同口径）
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    cleanup();
    renderDialog();
    const fresh = (await waitFor(() =>
      screen.getByTestId("shell-integration-toggle"),
    )) as HTMLInputElement;
    expect(fresh.checked).toBe(true);
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

  // --- B9（Task 6）：主机指纹巡检 + sudo 自动填充 ---

  it("指纹巡检（B9）：缺省关；开启写布尔；出现间隔下拉并写间隔键", async () => {
    seedMode("keyring");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    // 缺省 = 关（主动出网行为默认不开启）
    expect(screen.queryByTestId("hostkey-audit-interval-row")).toBeNull();
    const toggle = (await waitFor(() =>
      screen.getByTestId("hostkey-audit-toggle"),
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "security.hostkey_audit_enabled",
        value: true,
      }),
    );
    // 开启后间隔下拉出现；改间隔写 settings（默认 24h=86400）
    const interval = (await waitFor(() =>
      screen.getByTestId("hostkey-audit-interval"),
    )) as HTMLSelectElement;
    expect(interval.value).toBe("86400");
    fireEvent.change(interval, { target: { value: "3600" } });
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "security.hostkey_audit_interval_secs",
        value: 3600,
      }),
    );
  });

  it("sudo 自动填充（B9）：keyring 模式隐藏（主密码模式限定）", async () => {
    seedMode("keyring");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId("clipboard-select")).toBeTruthy());
    expect(screen.queryByTestId("sudo-autofill-row")).toBeNull();
  });

  it("sudo 自动填充（B9）：默认关；开启走确认框——取消保持关，确认才写 true", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "settings_set") return Promise.resolve(null);
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    const toggle = (await waitFor(() =>
      screen.getByTestId("sudo-autofill-toggle"),
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    // 勾选 → 先弹确认框（风险说明），未确认不写 settings
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("sudo-autofill-dialog")).toBeTruthy());
    // Phase 4 走查批：确认框必须预告「凭据不符会连续失败」——绑定的密码凭据
    // 与主机实际 sudo 密码不一致时，每轮 sudo 都会填错并被反复提示直至中止。
    // （本文件钉 zh-CN 词典，断言用中文。）
    expect(screen.getByTestId("sudo-autofill-dialog").textContent).toContain("连续填充失败");
    expect(
      mockedInvoke.mock.calls.filter(
        ([cmd, args]) => cmd === "settings_set" && (args as { key: string }).key === "security.sudo_autofill",
      ),
    ).toHaveLength(0);
    // 取消 → 开关保持关（写 false 是幂等的关闭语义）
    fireEvent.click(screen.getByTestId("sudo-autofill-cancel"));
    await waitFor(() => expect(screen.queryByTestId("sudo-autofill-dialog")).toBeNull());
    expect(toggle.checked).toBe(false);
    // 再勾选 → 确认 → 写 true、开关亮起
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("sudo-autofill-dialog")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sudo-autofill-accept"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "security.sudo_autofill",
        value: true,
      }),
    );
    expect((screen.getByTestId("sudo-autofill-toggle") as HTMLInputElement).checked).toBe(true);
  });

  it("sudo 自动填充（B9）：已开启（settings true）回显开", async () => {
    seedMode("password");
    mockedInvoke.mockImplementation((cmd: string, args?: { key: string }) => {
      if (cmd === "settings_get") {
        return Promise.resolve(args?.key === "security.sudo_autofill" ? true : null);
      }
      return Promise.reject(new Error(cmd));
    });
    renderDialog();
    await waitFor(() =>
      expect((screen.getByTestId("sudo-autofill-toggle") as HTMLInputElement).checked).toBe(true),
    );
  });
});

// theme-suite T2.4：主题选择从三选段控改网格卡片——七主题（含跟随系统卡），
// 每卡主题名 + 迷你色板预览条 + radio 选中态 aria；点击即切换并持久化。
describe("SecuritySettings 主题网格（theme-suite T2）", () => {
  it("七张主题卡齐全；当前模式 aria-checked；点 OLED 即切（data-theme=oled）并写 vault", async () => {
    seedMode("keyring");
    renderDialog();
    for (const id of ["system", "light", "dark", "oled", "amethyst", "verdant", "glass"]) {
      expect(screen.getByTestId(`theme-card-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("theme-card-system").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("theme-card-oled").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByTestId("theme-card-oled"));
    expect(document.documentElement.dataset.theme).toBe("oled");
    expect(screen.getByTestId("theme-card-oled").getAttribute("aria-checked")).toBe("true");
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", { key: "ui.theme", value: "oled" }),
    );
    localStorage.removeItem("ottr.settings.theme");
  });

  it("主题名走 settings.themes.* 词典：中文环境显示「暗黑 OLED/自然之灵/透明毛玻璃」", async () => {
    seedMode("keyring");
    renderDialog();
    const grid = screen.getByTestId("theme-grid");
    expect(grid.textContent).toContain("暗黑 OLED");
    expect(grid.textContent).toContain("自然之灵");
    expect(grid.textContent).toContain("透明毛玻璃");
    expect(grid.textContent).toContain("跟随系统");
  });

  it("迷你色板预览条：每卡 4 个色块（纯 CSS，aria-hidden）", async () => {
    seedMode("keyring");
    renderDialog();
    const preview = screen.getByTestId("theme-card-verdant").querySelector(".theme-card-preview")!;
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.querySelectorAll("i").length).toBe(4);
  });
});
