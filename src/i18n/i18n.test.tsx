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

  // --- 语言包完整性快照（fix round 1/5 I-1 回归防：键存在 ≠ 值语言正确）---

  /** 判断字符串是否含 CJK 表意文字（U+4E00–U+9FFF；含中文即算）。 */
  function hasCJK(s: string): boolean {
    return /[\u4e00-\u9fff]/.test(s);
  }

  function flatten(obj: Record<string, unknown>, prefix = ""): [string, string][] {
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object") {
        out.push(...flatten(v as Record<string, unknown>, key));
      } else {
        out.push([key, String(v)]);
      }
    }
    return out;
  }

  /** en-US 的 i18next 复数后缀键（_one/_other）→ 裸键（zh-CN 无复数形态）。 */
  function stripPluralSuffix(key: string): string {
    return key.replace(/_(one|other)$/, "");
  }

  it("快照：en-US 全部叶子值非中文（键集与 zh-CN 对齐、en 值是真译文）", async () => {
    // 直接读语言包源文件（不能用 import：i18n 实例的 addResourceBundle 与
    // resources 共享对象引用，同文件先行的 fallback 测试会污染模块对象）
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");
    const zh = JSON.parse(read("zh-CN.json"));
    const en = JSON.parse(read("en-US.json"));
    const zhKeys = new Set(flatten(zh).map(([k]) => k));
    const enLeaves = flatten(en);
    const enKeys = new Set(enLeaves.map(([k]) => stripPluralSuffix(k)));

    const missing = [...zhKeys].filter((k) => !enKeys.has(k));
    expect(missing, "en-US 缺键（英文 UI 会渲染原始键名）").toEqual([]);

    // 抽查 I-1 现场关键键的英文语义（CJK 断言兜底值语言，这里钉死内容，
    // 防「换成中文近义词」式回归静默通过）
    const enFlat = new Map(enLeaves.map(([k, v]) => [k, v]));
    expect(en.credentials.tabKnownHosts).toBe("Known Hosts");
    expect(en.notify.kindSecurity).toBe("Security");
    expect(en.notify.title.hostKeyChanged).toBe("Host key changed alert");
    expect(en.knownHosts.verify).toBe("Trust");
    expect(en.knownHosts.deleteTitle).toBe("Forget this endpoint?");
    expect(en.security.sudoAutofillAccept).toBe("Enable");

    // 语言选择器的「语言自主名称」惯例（en 包里也用原文显示「中文」）——豁免；
    // 其余任何 CJK 都是语言包损坏（I-1 现场）。
    const SELF_NAMED_LANG_KEYS = new Set(["settings.langZh", "palette.langToggle"]);
    const cjk = enLeaves.filter(([k, v]) => !SELF_NAMED_LANG_KEYS.has(k) && hasCJK(v));
    expect(cjk, "en-US 值含中文（英文用户看到中文文案）").toEqual([]);

    // 反向对齐：en 侧裸键（剥复数后缀后）也须在 zh 有归处（防 en 独有键漂移）
    const orphans = [...enKeys].filter((k) => !zhKeys.has(k));
    expect(orphans, "en-US 独有键（zh-CN 无对应）").toEqual([]);
    expect(enFlat.get("credentials.deleteWillUnbind_one")).toContain("{{count}}");
  });

  it("快照：zh-CN 与 en-US 插值占位符一致（{{x}} 面对齐，防缺参渲染）", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");
    const zh = JSON.parse(read("zh-CN.json"));
    const en = JSON.parse(read("en-US.json"));
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const enFlat = new Map(flatten(en).map(([k, v]) => [stripPluralSuffix(k), v]));
    for (const [k, zv] of flatten(zh)) {
      const ev = enFlat.get(k);
      expect(vars(String(ev)), `占位符不一致: ${k}`).toEqual(vars(zv));
    }
  });
});
