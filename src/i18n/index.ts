// i18n 脚手架（A11，Task 2 产出；全任务消费）：
// i18next + react-i18next，单文件 translation 命名空间起步；词典 zh-CN/en-US JSON。
// 语言 = 系统检测（navigator.language，zh* → zh-CN，其余 → en-US）+ 手动覆盖
// （localStorage 持久化；迁移点见 LANG_KEY 注释，Task 4 vault 落地后迁移）。
// fallback = en-US：词典缺键时回落英文，绝不让键名裸露给用户。
import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import zhCN from "./zh-CN.json";
import enUS from "./en-US.json";

export const LANGS = ["zh-CN", "en-US"] as const;
export type Lang = (typeof LANGS)[number];

/** 持久化迁移点（Task 4）：settings 表落 vault 后改走 vault，localStorage 仅过渡。 */
const LANG_KEY = "ottr.settings.lang";

/** 语言检测：手动覆盖（localStorage）优先，其次 navigator.language（zh* → zh-CN）。 */
export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored !== null && (LANGS as readonly string[]).includes(stored)) {
      return stored as Lang;
    }
  } catch {
    // localStorage 不可用（隐私模式等）→ 走系统语言检测
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

/** 切换语言并持久化（Task 4 迁移点：见 LANG_KEY 注释）。 */
export function setLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 持久化失败不阻塞切换
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
