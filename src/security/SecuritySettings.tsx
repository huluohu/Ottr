// SecuritySettings（T11，A7）：安全设置对话框。
// * 模式面：keyring（钥匙链直取，无锁概念）/ password（主密码）+ 说明；
// * 升级向导三步（keyring → password）：设密码（含确认与 ≥8 校验）→
//   重加密进度（ottr://reencrypt-progress 事件驱动）→ 完成（字段数收尾）；
// * 失焦自动锁定配置（password 模式专属；0 = 关）、剪贴板清空配置（0 = 关）；
// * 手动锁定按钮（password 模式；Task 14 快捷键接 vault_lock 同一命令）；
// * 外观（主题）/语言两项沿用 T2 词典键——persist 已迁 vault settings
//   （ThemeContext / i18n index 负责读写，本页只触发 setMode/setLang）。
import { useEffect, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { vaultApi, type ReencryptProgress } from "../vault/api";
import { useTheme, type ThemeMode } from "../theme/ThemeContext";
import { useLanguage, type Lang } from "../i18n";
import { useVaultLockStore } from "./VaultLockStore";

export interface SecuritySettingsProps {
  open: boolean;
  onClose: () => void;
}

const REENCRYPT_EVENT = "ottr://reencrypt-progress";

/** 主密码最小长度（Rust MASTER_PASSWORD_MIN_LEN 同口径，双端校验）。 */
const MIN_MASTER_PASSWORD = 8;

const AUTOLOCK_CHOICES = [0, 1, 5, 10, 30] as const; // 分钟；0 = 关
const CLIPBOARD_CHOICES = [0, 10, 30, 60] as const; // 秒；0 = 关
const THEME_CHOICES: ThemeMode[] = ["light", "dark", "system"];
const LANG_CHOICES: Lang[] = ["zh-CN", "en-US"];

type WizardStep = "password" | "progress" | "done";

export function SecuritySettings({ open, onClose }: SecuritySettingsProps) {
  const { t } = useTranslation();
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  const lockMode = useVaultLockStore((s) => s.mode);
  const lock = useVaultLockStore((s) => s.lock);

  // 升级向导状态（password/progress/done）。
  const [wizard, setWizard] = useState<WizardStep | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReencryptProgress>({ done: 0, total: 0 });
  const [fieldsDone, setFieldsDone] = useState<number | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  // 配置项本地镜像（open 时从 vault settings 现读；改动即写）。
  const [autolock, setAutolock] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<number | null>(null);

  // 每次打开：拉配置 + 挂进度事件；关闭：清向导态。
  useEffect(() => {
    if (!open) {
      setWizard(null);
      setPassword("");
      setConfirm("");
      setWizardError(null);
      setProgress({ done: 0, total: 0 });
      setFieldsDone(null);
      setUpgrading(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const [a, c] = await Promise.all([
          vaultApi.settings.get<number>("security.autolock_minutes"),
          vaultApi.settings.get<number>("security.clipboard_clear_secs"),
        ]);
        if (!disposed) {
          setAutolock(a ?? 10);
          setClipboard(c ?? 30);
        }
      } catch {
        // 非 Tauri 环境 / 后端不可达：控件回落默认值，改动时再报错。
        if (!disposed) {
          setAutolock(10);
          setClipboard(30);
        }
      }
      try {
        const stop = await listen<ReencryptProgress>(REENCRYPT_EVENT, (e) => {
          setProgress(e.payload);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        // 同上：进度条退化为不定态（upgrading 转圈仍可见）。
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  if (!open) return null;

  function validate(): string | null {
    if (password.length < MIN_MASTER_PASSWORD) {
      return t("security.wizard.errTooShort", { min: MIN_MASTER_PASSWORD });
    }
    if (password !== confirm) {
      return t("security.wizard.errMismatch");
    }
    return null;
  }

  async function startUpgrade(e: FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setWizardError(err);
      return;
    }
    setWizardError(null);
    setUpgrading(true);
    setWizard("progress");
    try {
      const fields = await vaultApi.security.upgradeToMasterPassword(password);
      setFieldsDone(fields);
      setWizard("done");
    } catch (err2) {
      // 升级失败 = 库原样未动（Rust 侧单事务），回第一步重试。
      setWizardError(err2 instanceof Error ? err2.message : String(err2));
      setWizard("password");
    } finally {
      setUpgrading(false);
      setPassword("");
      setConfirm("");
    }
  }

  async function saveSetting(key: string, value: number) {
    try {
      await vaultApi.settings.set(key, value);
    } catch (err) {
      // 校验失败/后端错误：控件回落（Rust 侧 validate_setting 是权威）。
      setWizardError(String(err));
    }
  }

  const isPasswordMode = lockMode === "password";

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("settings.title")} data-testid="security-settings">
      <div className="dialog settings-dialog">
        <h2>{t("settings.title")}</h2>

        {/* --- 安全（T11 主区）--- */}
        <section aria-label={t("settings.sectionSecurity")} data-testid="security-section">
          <h3>{t("settings.sectionSecurity")}</h3>

          <div className="settings-row" data-testid="vault-mode">
            <span className="settings-label">{t("security.mode")}</span>
            <span className={`vault-mode-badge vault-mode-${lockMode ?? "unknown"}`}>
              {isPasswordMode ? t("security.modePassword") : t("security.modeKeyring")}
            </span>
          </div>
          <p className="settings-hint">
            {isPasswordMode ? t("security.modePasswordDesc") : t("security.modeKeyringDesc")}
          </p>

          {isPasswordMode ? (
            <div className="settings-row">
              <button type="button" data-testid="lock-now" onClick={() => void lock()}>
                {t("security.lockNow")}
              </button>
            </div>
          ) : wizard === null ? (
            <div className="settings-row">
              <button
                type="button"
                className="btn-accent"
                data-testid="start-upgrade"
                onClick={() => setWizard("password")}
              >
                {t("security.upgrade")}
              </button>
            </div>
          ) : null}

          {wizard === "password" && (
            <form className="wizard-step" onSubmit={(e) => void startUpgrade(e)} noValidate data-testid="upgrade-wizard">
              <p className="dialog-intro" data-testid="wizard-step-title">
                {t("security.wizard.stepPassword")}
              </p>
              <label>
                <span>{t("security.masterPassword")}</span>
                <input
                  type="password"
                  data-testid="wizard-password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
              </label>
              <label>
                <span>{t("security.wizard.confirm")}</span>
                <input
                  type="password"
                  data-testid="wizard-confirm"
                  value={confirm}
                  autoComplete="new-password"
                  onChange={(e) => setConfirm(e.currentTarget.value)}
                />
              </label>
              <p className="settings-hint">{t("security.wizard.intro")}</p>
              {wizardError && (
                <p className="form-error" data-testid="wizard-error">
                  {wizardError}
                </p>
              )}
              <div className="form-actions">
                <button type="button" data-testid="wizard-cancel" onClick={() => setWizard(null)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn-accent" data-testid="wizard-start">
                  {t("security.wizard.start")}
                </button>
              </div>
            </form>
          )}

          {wizard === "progress" && (
            <div className="wizard-step" data-testid="upgrade-progress" aria-busy={upgrading}>
              <p className="dialog-intro">{t("security.wizard.stepProgress")}</p>
              <p className="settings-hint" data-testid="wizard-progress-text">
                {progress.total > 0
                  ? t("security.wizard.progressOf", { done: progress.done, total: progress.total })
                  : t("security.wizard.progressPending")}
              </p>
            </div>
          )}

          {wizard === "done" && (
            <div className="wizard-step" data-testid="upgrade-done">
              <p className="dialog-intro">{t("security.wizard.stepDone")}</p>
              <p className="settings-hint" data-testid="wizard-done-text">
                {t("security.wizard.doneCount", { count: fieldsDone ?? 0 })}
              </p>
            </div>
          )}

          {/* 失焦自动锁定（password 模式专属；keyring 无锁概念，配置隐藏） */}
          {isPasswordMode && (
            <label className="settings-row">
              <span className="settings-label">{t("security.autolock")}</span>
              <select
                data-testid="autolock-select"
                value={autolock ?? 10}
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  setAutolock(v);
                  void saveSetting("security.autolock_minutes", v);
                }}
              >
                {AUTOLOCK_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? t("security.off") : t("security.autolockMinutes", { count: m })}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="settings-row">
            <span className="settings-label">{t("security.clipboardClear")}</span>
            <select
              data-testid="clipboard-select"
              value={clipboard ?? 30}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                setClipboard(v);
                void saveSetting("security.clipboard_clear_secs", v);
              }}
            >
              {CLIPBOARD_CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? t("security.off") : t("security.clipboardSeconds", { count: s })}
                </option>
              ))}
            </select>
          </label>
        </section>

        {/* --- 外观 / 语言（T2 键面沿用；persist 已迁 vault settings）--- */}
        <section aria-label={t("settings.sectionAppearance")}>
          <h3>{t("settings.sectionAppearance")}</h3>
          <div className="settings-row">
            <span className="settings-label">{t("settings.theme")}</span>
            <div className="theme-switch" role="group" aria-label={t("settings.theme")}>
              {THEME_CHOICES.map((m) => (
                <button
                  key={m}
                  data-active={themeMode === m}
                  aria-pressed={themeMode === m}
                  onClick={() => setMode(m)}
                >
                  {t(`settings.theme${m[0].toUpperCase()}${m.slice(1)}`)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section aria-label={t("settings.sectionLanguage")}>
          <h3>{t("settings.sectionLanguage")}</h3>
          <label className="settings-row">
            <span className="settings-label">{t("settings.language")}</span>
            <select
              data-testid="language-select"
              value={lang}
              onChange={(e) => setLang(e.currentTarget.value as Lang)}
            >
              {LANG_CHOICES.map((l) => (
                <option key={l} value={l}>
                  {l === "zh-CN" ? t("settings.langZh") : t("settings.langEn")}
                </option>
              ))}
            </select>
          </label>
        </section>

        <div className="form-actions">
          <button type="button" className="btn-accent" data-testid="settings-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
