// entityRefresh 单测（BL-525）：同步导入落地后的实体 store 刷新例程。
// 断言面 = 逐类映射的刷新通道恰调一次；vault 主刷新失败 → 本地化包装错误
// 上抛（不吞，对话框错误面呈现）。store 模块全 mock——本测只看接线与错误
// 语义，不测各 store 自身（它们有自己的测试）。
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂被提升到文件顶——spy 必须经 vi.hoisted 创建方可被工厂引用。
const h = vi.hoisted(() => ({
  refreshVault: vi.fn(),
  refreshCron: vi.fn(),
  bootstrapNotify: vi.fn(),
  remount: vi.fn(),
  reloadRules: vi.fn(),
  syncLang: vi.fn(),
  syncTheme: vi.fn(),
  syncTerm: vi.fn(),
}));
vi.mock("../vault/store", () => ({
  useVaultStore: { getState: () => ({ refresh: h.refreshVault }) },
}));
vi.mock("../cron/cronStore", () => ({
  useCronStore: { getState: () => ({ refresh: h.refreshCron }) },
}));
vi.mock("../notify/core", () => ({
  useNotifyStore: { getState: () => ({ bootstrap: h.bootstrapNotify }) },
}));
vi.mock("../notify/channelRegistry", () => ({ remountChannels: h.remount }));
vi.mock("../notify/rules", () => ({ engine: { reload: h.reloadRules } }));
vi.mock("../i18n", () => ({
  default: { t: (key: string) => `T(${key})` },
  syncLangFromVault: h.syncLang,
}));
vi.mock("../theme/ThemeContext", () => ({ syncThemeFromVault: h.syncTheme }));
vi.mock("../theme/terminalThemeStore", () => ({
  useTerminalThemeStore: { getState: () => ({ syncFromVault: h.syncTerm }) },
}));

import { refreshEntitiesAfterImport } from "./entityRefresh";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("refreshEntitiesAfterImport（BL-525 映射例程）", () => {
  it("逐类映射的刷新通道各恰调一次（vault/cron/notify/渠道重挂/规则重载/语言/主题/终端配色）", async () => {
    await refreshEntitiesAfterImport();
    expect(h.refreshVault).toHaveBeenCalledTimes(1);
    expect(h.refreshCron).toHaveBeenCalledTimes(1);
    expect(h.bootstrapNotify).toHaveBeenCalledTimes(1); // muted_kinds 随 settings 类导入
    expect(h.remount).toHaveBeenCalledTimes(1);
    expect(h.reloadRules).toHaveBeenCalledTimes(1);
    expect(h.syncLang).toHaveBeenCalledTimes(1);
    expect(h.syncTheme).toHaveBeenCalledTimes(1);
    expect(h.syncTerm).toHaveBeenCalledTimes(1);
  });

  it("vault 主刷新失败 → 本地化包装错误上抛（不吞；其余通道不再阻塞上报）", async () => {
    h.refreshVault.mockRejectedValue(new Error("boom-cause"));
    await expect(refreshEntitiesAfterImport()).rejects.toThrow(
      /T\(sync\.dialog\.refreshFailed\).*boom-cause/,
    );
  });

  it("吞错型通道（cron/bootstrap/重挂/重载/三设置函数）失败不阻断整体刷新", async () => {
    h.refreshCron.mockRejectedValue(new Error("cron"));
    h.bootstrapNotify.mockRejectedValue(new Error("notify"));
    h.remount.mockRejectedValue(new Error("mount"));
    h.reloadRules.mockRejectedValue(new Error("rules"));
    h.syncLang.mockRejectedValue(new Error("lang"));
    h.syncTheme.mockRejectedValue(new Error("theme"));
    h.syncTerm.mockRejectedValue(new Error("term"));
    await expect(refreshEntitiesAfterImport()).resolves.toBeUndefined();
    expect(h.refreshVault).toHaveBeenCalledTimes(1);
  });
});
