// terminalThemeStore 测试（Phase 2 Task 9）：resolve 三态（auto/内置/自定义）、
// vault 真源对齐/迁移、select/addCustom/removeCustom 持久化载荷、脏数据防线。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  AUTO_TERMINAL_THEME_ID,
  findGalleryTheme,
  type TerminalThemeDef,
} from "./gallery";
import { terminalThemes, themeTerminalThemes } from "./terminal-themes";
import {
  resetTerminalThemeStoreForTest,
  resolveTerminalTheme,
  useTerminalThemeStore,
} from "./terminalThemeStore";

const mockedInvoke = invoke as unknown as Mock;

const CUSTOM: TerminalThemeDef = {
  id: "custom-1",
  name: "Snazzy",
  dark: true,
  theme: { ...terminalThemes.dark, background: "#1e1f29" },
};

beforeEach(() => {
  mockedInvoke.mockReset();
  localStorage.clear();
  resetTerminalThemeStoreForTest();
});

describe("resolveTerminalTheme（auto / 内置 / 自定义 / 兜底）", () => {
  it("auto：跟随界面亮暗取 terminalThemes（同引用）", () => {
    const setting = { selection: AUTO_TERMINAL_THEME_ID, custom: [] };
    expect(resolveTerminalTheme("light", setting)).toBe(terminalThemes.light);
    expect(resolveTerminalTheme("dark", setting)).toBe(terminalThemes.dark);
  });

  // theme-suite T2.3：auto 升级为按**主题 id**取配套色板——light/dark 沿用旧两套
  //（同引用不漂移），oled/amethyst/verdant/glass 各取新内置四套。
  it("auto 按主题 id：oled/amethyst/verdant/glass 取配套色板（同引用）", () => {
    const setting = { selection: AUTO_TERMINAL_THEME_ID, custom: [] };
    expect(resolveTerminalTheme("oled", setting)).toBe(themeTerminalThemes.oled);
    expect(resolveTerminalTheme("amethyst", setting)).toBe(themeTerminalThemes.amethyst);
    expect(resolveTerminalTheme("verdant", setting)).toBe(themeTerminalThemes.verdant);
    expect(resolveTerminalTheme("glass", setting)).toBe(themeTerminalThemes.glass);
  });

  it("auto：glass 色板底为半透明 rgba（主题玻璃面透出）", () => {
    const setting = { selection: AUTO_TERMINAL_THEME_ID, custom: [] };
    expect(resolveTerminalTheme("glass", setting).background).toMatch(/^rgba\(/);
  });

  it("内置 id：明暗无关，固定取画廊套", () => {
    const setting = { selection: "dracula", custom: [] };
    const dracula = findGalleryTheme("dracula")!.theme;
    expect(resolveTerminalTheme("light", setting)).toBe(dracula);
    expect(resolveTerminalTheme("dark", setting)).toBe(dracula);
  });

  it("自定义 id 优先于内置同名（自定义清单先查）", () => {
    const setting = { selection: "custom-1", custom: [CUSTOM] };
    expect(resolveTerminalTheme("dark", setting)).toBe(CUSTOM.theme);
  });

  it("未知 id（主题被删/降级）→ auto 兜底", () => {
    const setting = { selection: "ghost-id", custom: [] };
    expect(resolveTerminalTheme("dark", setting)).toBe(terminalThemes.dark);
  });
});

describe("useTerminalThemeStore（持久化面）", () => {
  it("select：状态即变 + settings_set 载荷 { selection, custom } + 缓存镜像", async () => {
    useTerminalThemeStore.getState().select("nord");
    expect(useTerminalThemeStore.getState().selection).toBe("nord");
    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "ui.terminalTheme",
        value: { selection: "nord", custom: [] },
      }),
    );
    expect(
      JSON.parse(localStorage.getItem("ottr.settings.terminalTheme") ?? "{}").selection,
    ).toBe("nord");
  });

  it("addCustom：同名覆盖（重复导入幂等）并选中新条目", () => {
    useTerminalThemeStore.getState().addCustom(CUSTOM);
    const v2: TerminalThemeDef = { ...CUSTOM, id: "custom-2" };
    useTerminalThemeStore.getState().addCustom(v2);
    const state = useTerminalThemeStore.getState();
    expect(state.custom.map((t) => t.id)).toEqual(["custom-2"]); // 同名 Snazzy 只留一条
    expect(state.selection).toBe("custom-2");
  });

  it("removeCustom：删当前选中回 auto；删非选中不动选择", () => {
    useTerminalThemeStore.getState().addCustom(CUSTOM);
    useTerminalThemeStore.getState().addCustom({ ...CUSTOM, id: "custom-2", name: "N" });
    useTerminalThemeStore.getState().select("custom-2");
    useTerminalThemeStore.getState().removeCustom("custom-2");
    // 删的是选中项 → 回 auto（不猜下一个，语义可预期）
    expect(useTerminalThemeStore.getState().selection).toBe(AUTO_TERMINAL_THEME_ID);
    useTerminalThemeStore.getState().select("custom-1");
    useTerminalThemeStore.getState().removeCustom("other-id");
    expect(useTerminalThemeStore.getState().selection).toBe("custom-1");
    expect(useTerminalThemeStore.getState().custom.map((t) => t.id)).toEqual(["custom-1"]);
  });

  it("syncFromVault：vault 有值以 vault 为准并刷新缓存镜像", async () => {
    mockedInvoke.mockImplementation((_cmd: string, args?: { key: string }) =>
      args?.key === "ui.terminalTheme"
        ? Promise.resolve({ selection: "solarized-light", custom: [CUSTOM] })
        : Promise.resolve(null),
    );
    await useTerminalThemeStore.getState().syncFromVault();
    const state = useTerminalThemeStore.getState();
    expect(state.synced).toBe(true);
    expect(state.selection).toBe("solarized-light");
    expect(state.custom).toEqual([CUSTOM]);
    expect(
      JSON.parse(localStorage.getItem("ottr.settings.terminalTheme") ?? "{}").selection,
    ).toBe("solarized-light");
  });

  it("syncFromVault：vault 无值 + 缓存有值 → 迁移写 vault（缓存保留）", async () => {
    localStorage.setItem(
      "ottr.settings.terminalTheme",
      JSON.stringify({ selection: "one-dark", custom: [] }),
    );
    mockedInvoke.mockImplementation(() => Promise.resolve(null));
    await useTerminalThemeStore.getState().syncFromVault();
    expect(useTerminalThemeStore.getState().selection).toBe("one-dark");
    await vi.waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "ui.terminalTheme",
        value: { selection: "one-dark", custom: [] },
      }),
    );
  });

  it("syncFromVault：vault 值带脏条目（缺 theme）→ 清洗后进 store", async () => {
    mockedInvoke.mockImplementation((_cmd: string, args?: { key: string }) =>
      args?.key === "ui.terminalTheme"
        ? Promise.resolve({
            selection: "bad",
            custom: [
              { id: "x", name: "Broken" }, // 缺 theme
              CUSTOM,
            ],
          })
        : Promise.resolve(null),
    );
    await useTerminalThemeStore.getState().syncFromVault();
    expect(useTerminalThemeStore.getState().custom).toEqual([CUSTOM]);
  });

  it("syncFromVault：vault 不可达（reject/undefined）→ 不抛错，标记 synced", async () => {
    mockedInvoke.mockImplementation(() => Promise.reject("backend down"));
    await expect(useTerminalThemeStore.getState().syncFromVault()).resolves.toBeUndefined();
    expect(useTerminalThemeStore.getState().synced).toBe(true);
    expect(useTerminalThemeStore.getState().selection).toBe(AUTO_TERMINAL_THEME_ID);
  });

  it("select/addCustom 在 vault 写失败（非 Tauri）时不阻塞切换", () => {
    mockedInvoke.mockImplementation(() => Promise.reject("no backend"));
    expect(() => useTerminalThemeStore.getState().select("nord")).not.toThrow();
    expect(useTerminalThemeStore.getState().selection).toBe("nord");
  });
});
