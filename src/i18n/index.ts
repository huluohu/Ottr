// i18n 脚手架（A11，Task 2 产出；全任务消费）：
// i18next + react-i18next，单文件 translation 命名空间起步；词典 zh-CN/en-US JSON。
// 语言 = 系统检测（navigator.language，zh* → zh-CN，其余 → en-US）+ 手动覆盖。
// 持久化（T11 迁移完成）：真源 = vault settings `ui.language`（明文面，锁定可读，
// syncLangFromVault 对齐/迁移）；localStorage 键降级为启动缓存镜像（防闪烁）。
// fallback = en-US：词典缺键时回落英文，绝不让键名裸露给用户。
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export const LANGS = ["zh-CN", "en-US"] as const;
export type Lang = (typeof LANGS)[number];

/** localStorage 缓存镜像键（真源 = vault settings，见文件头）。 */
const LANG_KEY = "ottr.settings.lang";
/** vault settings 键。 */
export const LANG_SETTING_KEY = "ui.language";

function readCache(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

function writeCache(lang: string): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 缓存失败不阻塞
  }
}

/** 语言检测：缓存镜像优先（真源对齐前的首帧口径），其次 navigator.language
 * （zh* → zh-CN）。 */
export function detectLang(): Lang {
  const stored = readCache();
  if (stored !== null && (LANGS as readonly string[]).includes(stored)) {
    return stored as Lang;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

// 资源内联、无异步 backend：init 同步完成，首次渲染即有译文。
void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    "en-US": { translation: enUS },
  },
  lng: detectLang(),
  fallbackLng: "en-US",
  // React 自带 XSS 转义；关闭 i18next 二次转义避免 &amp; 双重转义
  interpolation: { escapeValue: false },
});

export default i18n;

/** 切换语言并持久化：缓存镜像即时 + vault 真源异步（T11 迁移完成态）。
 * vault 写成功后发 `ottr://ui-language`（A12，Task 14）——Rust 侧菜单/托盘
 * 文案随 vault settings 重建，故必须**在真源落地之后**发（有先后依赖）；
 * vault 写失败（非 Tauri 环境/纯浏览器 dev）不通知——开发环境本无原生菜单。 */
export function setLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  writeCache(lang);
  void import("../vault/api")
    .then(({ vaultApi }) => vaultApi.settings.set(LANG_SETTING_KEY, lang))
    .then(() => import("@tauri-apps/api/event"))
    .then(({ emit }) => emit("ottr://ui-language"))
    .catch(() => {
      // 非 Tauri 环境（纯浏览器 dev / vitest 无 mock）：镜像已是持久化面
    });
}

/** T11 迁移 + 真源对齐（App 挂载后调用一次）：
 * 1. vault 有合法值 → 以 vault 为准（changeLanguage + 刷新缓存镜像）；
 * 2. vault 无值 + localStorage 有合法值 → 迁移：写 vault、清 localStorage 键；
 * 3. 两边皆无 → 不动（保持系统检测）。 */
export async function syncLangFromVault(): Promise<void> {
  const { vaultApi } = await import("../vault/api");
  let stored: string | null = null;
  try {
    stored = await vaultApi.settings.get<string>(LANG_SETTING_KEY);
  } catch {
    return; // 后端不可达：维持现状
  }
  if (stored !== null && (LANGS as readonly string[]).includes(stored)) {
    if (i18n.language !== stored) {
      await i18n.changeLanguage(stored);
    }
    writeCache(stored);
    return;
  }
  const cached = readCache();
  if (cached !== null && (LANGS as readonly string[]).includes(cached)) {
    try {
      await vaultApi.settings.set(LANG_SETTING_KEY, cached);
      localStorage.removeItem(LANG_KEY);
      // 迁移落库后必须通知 Rust 重建菜单/托盘文案——迁移前菜单按空 ui.language
      // 走了 En 兜底，不通知则「中文界面 + 英文菜单」直到重启（用户实测）。
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit("ottr://ui-language"))
        .catch(() => {});
    } catch {
      // 迁移失败下次再试（localStorage 键保留即迁移未完成的标记）
    }
    return;
  }
  // 分支 3 补全（2026-10-08 菜单语言根因修复）：两边皆无 ≠ 不动——界面语言来自
  // 系统检测（navigator.language），此前从不落 vault，Rust 菜单读 ui.language
  // 恒空 → 恒走 En 兜底，中文用户的原生菜单与界面语言不一致（验收实测复现：
  // vault settings 只有 ui.theme 无 ui.language）。把检测语言落 vault 为真源
  // 初始值（幂等；用户后续手动切换照旧走 setLang 覆盖）。
  try {
    await vaultApi.settings.set(LANG_SETTING_KEY, detectLang());
    // 真源落地后发重建事件（同 setLang 契约）：菜单可能早于本函数在
    // vault-ready 时按 En 兜底重建过，不补发则首启菜单停留英文。
    const { emit } = await import("@tauri-apps/api/event");
    await emit("ottr://ui-language");
  } catch {
    // 非 Tauri 环境：无原生菜单，无须落库/通知
  }
}

/** 简报接口：useLanguage() -> { lang, setLang }。lang 取当前实例语言（设置页/语言菜单消费）。 */
export function useLanguage(): { lang: Lang; setLang: (lang: Lang) => void } {
  const { i18n: inst } = useTranslation();
  const lang = (LANGS as readonly string[]).includes(inst.language)
    ? (inst.language as Lang)
    : detectLang();
  return { lang, setLang };
}
