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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { detectLang, useLanguage } from "./index";

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
    // 迁移点注记：localStorage 键 ottr.settings.lang，Task 4 vault 落地后迁移
    expect(localStorage.getItem("ottr.settings.lang")).toBe("zh-CN");
    fireEvent.click(screen.getByText("to-en"));
    await waitFor(() => expect(screen.getByTestId("ok").textContent).toBe("OK"));
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
