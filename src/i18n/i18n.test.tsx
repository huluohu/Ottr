// A11（Task 2 Step 4）：i18n 行为测试——系统语言检测、localStorage 覆盖、
// 切换语言重渲染、缺键 fallback（en-US 兜底）。
// 模块在 import 时完成初始化：用 vi.hoisted 在 import 前钉住 navigator.language，
// 全文件共用同一 i18n 实例（检测逻辑单测走导出的 detectLang，不做 resetModules）。
vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "en-US",
    configurable: true,
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import i18n, { detectLang, setLang, syncLangFromVault, useLanguage } from "./index";

const mockedInvoke = invoke as unknown as Mock;
const settingsStore = new Map<string, unknown>();

function setNavigatorLanguage(lang: string) {
  Object.defineProperty(window.navigator, "language", { value: lang, configurable: true });
}

function Probe() {
  const { t } = useTranslation();
  const { lang, setLang } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="ok">{t("common.ok")}</span>
      <button onClick={() => setLang("zh-CN")}>to-zh</button>
      <button onClick={() => setLang("en-US")}>to-en</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  settingsStore.clear();
  // 内存 settings 表（T11 迁移用；未覆盖命令显式失败防误用）
  mockedInvoke.mockImplementation((cmd: string, args?: { key: string; value: unknown }) => {
    if (cmd === "settings_get") {
      return Promise.resolve(settingsStore.has(args!.key) ? settingsStore.get(args!.key) : null);
    }
    if (cmd === "settings_set") {
      settingsStore.set(args!.key, args!.value);
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
  setNavigatorLanguage("en-US");
});

afterEach(() => {
  cleanup();
});

describe("i18n", () => {
  it("detectLang：navigator.language zh* → zh-CN，其余 → en-US", () => {
    setNavigatorLanguage("zh-TW");
    expect(detectLang()).toBe("zh-CN");
    setNavigatorLanguage("en-GB");
    expect(detectLang()).toBe("en-US");
  });

  it("detectLang：localStorage 手动覆盖优先；非法值回落系统检测", () => {
    localStorage.setItem("ottr.settings.lang", "zh-CN");
    setNavigatorLanguage("en-GB");
    expect(detectLang()).toBe("zh-CN");
    localStorage.setItem("ottr.settings.lang", "fr-FR"); // 不支持的语言 → 忽略
    expect(detectLang()).toBe("en-US");
  });

  it("初始化：跟随 navigator.language（en-US）启动，译文可用", () => {
    expect(i18n.language).toBe("en-US");
    expect(i18n.t("common.ok")).toBe("OK");
  });

  it("切换语言重渲染：setLang 后 t() 输出即时切换并持久化", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
    expect(screen.getByTestId("ok").textContent).toBe("OK");
    fireEvent.click(screen.getByText("to-zh"));
    await waitFor(() => expect(screen.getByTestId("ok").textContent).toBe("确定"));
    expect(screen.getByTestId("lang").textContent).toBe("zh-CN");
    // T11：setLang 双写（缓存镜像即时 + vault settings 异步）
    expect(localStorage.getItem("ottr.settings.lang")).toBe("zh-CN");
    await waitFor(() => expect(settingsStore.get("ui.language")).toBe("zh-CN"));
    fireEvent.click(screen.getByText("to-en"));
    await waitFor(() => expect(screen.getByTestId("ok").textContent).toBe("OK"));
    // 等本测试触发的 vault 写落地（fire-and-forget 链不跨测试泄漏，防竞态）
    await waitFor(() => expect(settingsStore.get("ui.language")).toBe("en-US"));
  });

  it("T11 迁移：localStorage 有值、vault 空 → 迁入 ui.language 并清 localStorage 键", async () => {
    localStorage.setItem("ottr.settings.lang", "zh-CN");
    await syncLangFromVault();
    expect(settingsStore.get("ui.language")).toBe("zh-CN");
    expect(localStorage.getItem("ottr.settings.lang")).toBeNull();
    // 幂等：二次 sync 不再写
    mockedInvoke.mockClear();
    await syncLangFromVault();
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === "settings_set")).toHaveLength(0);
  });

  it("T11 真源对齐：vault 有值时以 vault 为准（changeLanguage 生效）", async () => {
    settingsStore.set("ui.language", "en-US");
    await i18n.changeLanguage("zh-CN"); // 实例先在 zh
    await syncLangFromVault();
    expect(i18n.language).toBe("en-US");
    // 缓存镜像刷新为 vault 值
    expect(localStorage.getItem("ottr.settings.lang")).toBe("en-US");
  });

  it("T11 setLang 双写：缓存镜像即时 + vault ui.language 异步", async () => {
    setLang("zh-CN");
    expect(localStorage.getItem("ottr.settings.lang")).toBe("zh-CN");
    await waitFor(() => expect(settingsStore.get("ui.language")).toBe("zh-CN"));
  });

  it("缺键 fallback：zh-CN 缺键回落 en-US 译文；双语皆缺返回键名", () => {
    i18n.addResourceBundle(
      "en-US",
      "translation",
      { fallbackProbe: { only: "English only" } },
      true,
      true,
    );
    expect(i18n.t("fallbackProbe.only", { lng: "zh-CN" })).toBe("English only");
    expect(i18n.t("fallbackProbe.missing", { lng: "zh-CN" })).toBe(
      "fallbackProbe.missing",
    );
  });
});
