// SecuritySettings（T11，A7）：安全设置对话框。
// * 模式面：keyring（钥匙链直取，无锁概念）/ password（主密码）+ 说明；
// * 升级向导三步（keyring → password）：设密码（含确认与 ≥8 校验）→
//   重加密进度（ottr://reencrypt-progress 事件驱动）→ 完成（字段数收尾）；
// * 失焦自动锁定配置（password 模式专属；0 = 关）、剪贴板清空配置（0 = 关）；
// * 手动锁定按钮（password 模式；Task 14 快捷键接 vault_lock 同一命令）；
// * 外观（主题网格）/语言两项沿用 T2 词典键——persist 已迁 vault settings
//   （ThemeContext / i18n index 负责读写，本页只触发 setMode/setLang）。
import { useEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { vaultApi, type ReencryptProgress } from "../vault/api";
import { useTheme, type ThemeMode } from "../theme/ThemeContext";
import {
  AUTO_TERMINAL_THEME_ID,
  TERMINAL_THEME_GALLERY,
  type TerminalThemeDef,
} from "../theme/gallery";
import { parseThemeFileBytes } from "../theme/importers";
import { useTerminalThemeStore } from "../theme/terminalThemeStore";
import { useLanguage, type Lang } from "../i18n";
import { Switch } from "../ui/Switch";
import { loadTerminalSettings, saveTerminalSettings } from "../terminal/ContextMenu";
import { useEscClose } from "../ui/useEscClose";
import { PaneErrorBoundary } from "../ui/PaneErrorBoundary";
import { UpdateCheck } from "../update/UpdateCheck";
import { useVaultLockStore } from "./VaultLockStore";
import { SyncSettings } from "../sync/SyncSettings";
import { AlertSettings } from "../notify/AlertSettings";
import { McpSettings } from "./McpSettings";

export interface SecuritySettingsProps {
  open: boolean;
  onClose: () => void;
  /** 同步区「立即同步」入口（App 根部挂 SyncDialog，Task 4）。 */
  onOpenSyncDialog?: () => void;
}

const REENCRYPT_EVENT = "ottr://reencrypt-progress";

/**
 * 主密码最小长度（BL-202 双端口径）：**同值同语义**对齐 Rust 权威校验
 * `ottr-vault store.rs::MASTER_PASSWORD_MIN_LEN`（值同为 8）。
 *
 * 语义 = **Unicode 码点数**（Rust `chars().count()`），不是 JS `.length`
 * （UTF-16 码元数，增补平面字符计 2）——预检比权威门卫严一格或松一格都会
 * 出现「前端放行、后端拒绝」的分叉体验（如 4 个 emoji：.length=8、码点=4）。
 * 预检只是 UX 提前拦截，Rust 校验仍是权威（绕过前端直连 IPC 也拦得住）。
 */
export const MIN_MASTER_PASSWORD = 8;

/** 主密码长度计量：Unicode 码点数（与 Rust `chars().count()` 同口径，见上）。 */
function masterPasswordCodePoints(s: string): number {
  return [...s].length;
}

const AUTOLOCK_CHOICES = [0, 1, 5, 10, 30] as const; // 分钟；0 = 关
const CLIPBOARD_CHOICES = [0, 10, 30, 60] as const; // 秒；0 = 关
// 终端字体族候选（2026-10-10 字体/字号项；空 = xterm 默认栈）
const FONT_CHOICES = ["Menlo", "Monaco", "SF Mono", "JetBrains Mono", "Fira Code", "Courier New"] as const;
// 终端字号候选（pt）
const FONT_SIZE_CHOICES = [10, 11, 12, 13, 14, 16, 18, 20] as const;
// theme-suite T2：主题 id 全集（= ThemeContext.ThemeMode；跟随系统保留为一卡）。
const THEME_CHOICES: ThemeMode[] = ["system", "light", "dark", "oled", "amethyst", "verdant", "glass"];
const LANG_CHOICES: Lang[] = ["zh-CN", "en-US"];

// 2026-10-09 设置页交互重构：左侧分区导航 + 右侧内容面板（原单列长滚动、
// 行为开关混进外观节）。未激活面板 hidden 隐藏但**保持挂载**——控件状态、
// 升级/降级向导进度与既有测试断言都不因切换丢面；DOM 顺序 = 导航顺序
// （Tab 序一致）。面板内滚动替代整窗滚动（样式见 16-lock-security.css）。
type SettingsPane = "security" | "sync" | "alerts" | "mcp" | "appearance" | "general";
const PANE_TABS: ReadonlyArray<{ id: SettingsPane; labelKey: string }> = [
  { id: "security", labelKey: "settings.sectionSecurity" },
  { id: "sync", labelKey: "settings.sectionSync" },
  { id: "alerts", labelKey: "settings.sectionAlerts" },
  { id: "mcp", labelKey: "settings.sectionMcp" },
  { id: "appearance", labelKey: "settings.sectionAppearance" },
  { id: "general", labelKey: "settings.sectionGeneral" },
];
// B9 指纹巡检间隔（秒）：1h / 6h / 24h（默认）/ 7d（Rust 校验 60-604800）
const HOSTKEY_AUDIT_CHOICES = [3_600, 21_600, 86_400, 604_800] as const;

const SETTING_HOSTKEY_AUDIT = "security.hostkey_audit_enabled";
const SETTING_HOSTKEY_AUDIT_INTERVAL = "security.hostkey_audit_interval_secs";

type WizardStep = "password" | "progress" | "done";

export function SecuritySettings({ open, onClose, onOpenSyncDialog }: SecuritySettingsProps) {
  const { t } = useTranslation();
  const { mode: themeMode, setMode } = useTheme();
  const { lang, setLang } = useLanguage();
  // 终端配色（B2 主题生态）：选择/清单全局 store（App 就绪门已 syncFromVault）。
  const terminalSelection = useTerminalThemeStore((s) => s.selection);
  const terminalCustom = useTerminalThemeStore((s) => s.custom);
  const selectTerminalTheme = useTerminalThemeStore((s) => s.select);
  const removeTerminalTheme = useTerminalThemeStore((s) => s.removeCustom);
  const selectedCustomDef = terminalCustom.find((t2) => t2.id === terminalSelection) ?? null;
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

  // 降级向导状态（no-lock 任务：password → keyring「切换到免密模式」）。
  const [downgradeStep, setDowngradeStep] = useState<"confirm" | "progress" | "done" | null>(null);
  const [downgradePassword, setDowngradePassword] = useState("");
  const [downgradeError, setDowngradeError] = useState<string | null>(null);

  // 配置项本地镜像（open 时从 vault settings 现读；改动即写）。
  const [autolock, setAutolock] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<number | null>(null);
  // A12（Task 14）：关窗到托盘开关（Rust 侧 CloseRequested 读同一键）。
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  // Task 15 fix 1/5：shell 集成自动注入开关（⌘R 历史入库/报错即诊的数据源）。
  const [shellIntegration, setShellIntegration] = useState<boolean | null>(null);
  // B9（Task 6）：指纹巡检开关/间隔 + sudo 自动填充开关（默认关；开启须确认框）。
  const [hostkeyAudit, setHostkeyAudit] = useState<boolean | null>(null);
  const [hostkeyAuditInterval, setHostkeyAuditInterval] = useState<number | null>(null);
  const [sudoAutofill, setSudoAutofill] = useState<boolean | null>(null);
  const [sudoConfirm, setSudoConfirm] = useState(false);
  // 分区导航当前面板（默认安全——对话框的历史主区）。
  const [pane, setPane] = useState<SettingsPane>("security");
  // 关闭交互统一（2026-10-08）：Esc = 右上 X 等价；sudo 确认子层打开时先收
  // 子层（Esc 逐层退出，不跨层关闭整个面板）——consumeSubLayer 口径。
  useEscClose(open, onClose, () => {
    if (sudoConfirm) {
      setSudoConfirm(false);
      return true;
    }
    return false;
  });
  // B2 主题生态（Phase 2 Task 9）：配色导入的本地反馈面（选择/清单在全局 store）。
  const themeFileRef = useRef<HTMLInputElement | null>(null);
  const [themeImportError, setThemeImportError] = useState<string | null>(null);
  const [themeImportedCount, setThemeImportedCount] = useState<number | null>(null);
  // 终端字体族/字号（外观分节，2026-10-10；localStorage 终端设置 + 事件广播）
  const [termFont, setTermFont] = useState<string | null>(null);
  const [termFontSize, setTermFontSize] = useState<number | null>(null);

  function applyTerminalFont(fontFamily: string | null, fontSize: number | null) {
    saveTerminalSettings({ ...loadTerminalSettings(), fontFamily, fontSize });
    window.dispatchEvent(new CustomEvent("ottr://terminal-settings"));
  }


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
      setDowngradeStep(null);
      setDowngradePassword("");
      setDowngradeError(null);
      setThemeImportError(null);
      setThemeImportedCount(null);
      setSudoConfirm(false);
      setPane("security");
      const ts = loadTerminalSettings();
      setTermFont(ts.fontFamily);
      setTermFontSize(ts.fontSize ?? 13);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const [a, c, tray, shell, audit, auditInterval, sudo] = await Promise.all([
          vaultApi.settings.get<number>("security.autolock_minutes"),
          vaultApi.settings.get<number>("security.clipboard_clear_secs"),
          vaultApi.settings.get<number>("ui.close_to_tray"),
          vaultApi.settings.get<boolean>("shell.integration"),
          vaultApi.settings.get<boolean>(SETTING_HOSTKEY_AUDIT),
          vaultApi.settings.get<number>(SETTING_HOSTKEY_AUDIT_INTERVAL),
          vaultApi.settings.get<boolean>("security.sudo_autofill"),
        ]);
        if (!disposed) {
          setAutolock(a ?? 10);
          setClipboard(c ?? 30);
          setCloseToTray(tray !== 0); // 未设置/非 0 = 开（Rust 侧同口径）
          setShellIntegration(shell !== false); // 未设置 = 开（Rust 侧缺省开同口径）
          setHostkeyAudit(audit === true); // B9：默认关
          setHostkeyAuditInterval(auditInterval ?? 86_400);
          setSudoAutofill(sudo === true); // B9：默认关
        }
      } catch {
        // 非 Tauri 环境 / 后端不可达：控件回落默认值，改动时再报错。
        if (!disposed) {
          setAutolock(10);
          setClipboard(30);
          setCloseToTray(true);
          setShellIntegration(true);
          setHostkeyAudit(false);
          setHostkeyAuditInterval(86_400);
          setSudoAutofill(false);
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
    // 码点口径（BL-202）：见 MIN_MASTER_PASSWORD 文档——`.length` 是 UTF-16
    // 码元数，与 Rust 权威校验的 chars().count() 在增补平面字符上分歧。
    if (masterPasswordCodePoints(password) < MIN_MASTER_PASSWORD) {
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
      // 模式已翻转（keyring → password）：store 的 mode 事件不覆盖，显式重查
      // 落地（否则徽标/入口停留在旧模式直到重启）。
      await useVaultLockStore.getState().refreshStatus();
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

  /** 降级向导提交（password → keyring）：当前主密码确认 → 单命令迁移 →
   * 完成态。库层崩溃安全（先写钥匙链新钥、再单事务重密封+meta 翻转），
   * 失败 = 库原样未动，回确认步可重试。 */
  async function startDowngrade(e: FormEvent) {
    e.preventDefault();
    if (downgradePassword.length === 0) {
      setDowngradeError(t("security.downgrade.errEmpty"));
      return;
    }
    setDowngradeError(null);
    setDowngradeStep("progress");
    try {
      await vaultApi.security.downgradeToKeychain(downgradePassword);
      // 模式已翻转（password → keyring）且必为解锁态：重查落地 store
      // （badge/入口即时翻面），再进完成态。
      await useVaultLockStore.getState().refreshStatus();
      setDowngradeStep("done");
    } catch (err) {
      setDowngradeError(err instanceof Error ? err.message : String(err));
      setDowngradeStep("confirm");
    } finally {
      setDowngradePassword("");
    }
  }

  async function saveSetting(key: string, value: number | boolean) {
    try {
      await vaultApi.settings.set(key, value);
    } catch (err) {
      // 校验失败/后端错误：控件回落（Rust 侧 validate_setting 是权威）。
      setWizardError(String(err));
    }
  }

  /** 配色文件导入（B2 Step 3）：解析分流收口在 theme/importers（BL-512 起
   * 字节级嗅探——bplist00 魔数走二进制 plist 解析器，扩展名无关；文本按
   * 扩展名 .itermcolors/.json/回退链分派）。多 scheme 全部入库，选中间第一个。 */
  async function importThemeFile(file: File | undefined) {
    if (!file) return;
    setThemeImportError(null);
    setThemeImportedCount(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stamp = Date.now();
      const defs: TerminalThemeDef[] = parseThemeFileBytes(file.name, bytes).map((s, i) => ({
        id: `custom-${stamp}-${i}`,
        ...s,
      }));
      const { addCustom, select } = useTerminalThemeStore.getState();
      for (const def of defs) addCustom(def);
      select(defs[0].id); // 多 scheme 导入选中间第一个（其余在清单可选）
      setThemeImportedCount(defs.length);
    } catch (e) {
      setThemeImportError(e instanceof Error ? e.message : String(e));
    }
  }

  const isPasswordMode = lockMode === "password";

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("settings.title")} data-testid="security-settings">
      <div className="dialog settings-dialog">
        <div className="dialog-head">
          <h2>{t("settings.title")}</h2>
          <button
            type="button"
            className="dialog-close"
            data-testid="settings-dialog-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="settings-body">
          <nav
            className="settings-nav"
            role="tablist"
            aria-label={t("settings.title")}
            data-testid="settings-nav"
          >
            {PANE_TABS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={pane === p.id}
                data-testid={`settings-nav-${p.id}`}
                onClick={() => setPane(p.id)}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </nav>
          <div className="settings-panes">
            {/* --- 安全（T11 主区）--- */}
            <section
              role="tabpanel"
              aria-label={t("settings.sectionSecurity")}
              hidden={pane !== "security"}
              data-testid="security-section"
            >
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

          {/* 降级入口（no-lock 任务）：仅 password 模式显示——keyring 模式无可
              降级，向导展开后入口隐藏（避免与步骤面板并列）。 */}
          {isPasswordMode && downgradeStep === null && (
            <div className="settings-row">
              <button
                type="button"
                data-testid="start-downgrade"
                onClick={() => setDowngradeStep("confirm")}
              >
                {t("security.downgrade.start")}
              </button>
            </div>
          )}

          {downgradeStep === "confirm" && (
            <form
              className="wizard-step"
              onSubmit={(e) => void startDowngrade(e)}
              noValidate
              data-testid="downgrade-wizard"
            >
              <p className="dialog-intro" data-testid="downgrade-step-title">
                {t("security.downgrade.stepConfirm")}
              </p>
              <label>
                <span>{t("security.masterPassword")}</span>
                <input
                  type="password"
                  data-testid="downgrade-password"
                  value={downgradePassword}
                  autoComplete="current-password"
                  onChange={(e) => setDowngradePassword(e.currentTarget.value)}
                />
              </label>
              <p className="settings-hint">{t("security.downgrade.intro")}</p>
              {downgradeError && (
                <p className="form-error" data-testid="downgrade-error">
                  {downgradeError}
                </p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  data-testid="downgrade-cancel"
                  onClick={() => {
                    setDowngradeStep(null);
                    setDowngradeError(null);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn-accent" data-testid="downgrade-confirm">
                  {t("security.downgrade.confirm")}
                </button>
              </div>
            </form>
          )}

          {downgradeStep === "progress" && (
            <div className="wizard-step" data-testid="downgrade-progress" aria-busy="true">
              <p className="dialog-intro">{t("security.downgrade.stepProgress")}</p>
              <p className="settings-hint" data-testid="downgrade-progress-text">
                {progress.total > 0
                  ? t("security.wizard.progressOf", { done: progress.done, total: progress.total })
                  : t("security.wizard.progressPending")}
              </p>
            </div>
          )}

          {downgradeStep === "done" && (
            <div className="wizard-step" data-testid="downgrade-done">
              <p className="dialog-intro">{t("security.downgrade.stepDone")}</p>
              <p className="settings-hint" data-testid="downgrade-done-text">
                {t("security.downgrade.doneDesc")}
              </p>
            </div>
          )}

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
              <p className="settings-hint">{t("security.wizard.intro", { min: MIN_MASTER_PASSWORD })}</p>
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

          {/* B9（Task 6）：主机指纹巡检——默认关（主动出网行为），间隔可配 */}
          <label className="settings-row" data-testid="hostkey-audit-row">
            <span className="settings-label">{t("security.hostkeyAudit")}</span>
            <Switch
              testid="hostkey-audit-toggle"
              checked={hostkeyAudit ?? false}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setHostkeyAudit(on);
                void saveSetting(SETTING_HOSTKEY_AUDIT, on);
              }}
            />
          </label>
          {hostkeyAudit && (
            <label className="settings-row" data-testid="hostkey-audit-interval-row">
              <span className="settings-label">{t("security.hostkeyAuditInterval")}</span>
              <select
                data-testid="hostkey-audit-interval"
                value={hostkeyAuditInterval ?? 86_400}
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  setHostkeyAuditInterval(v);
                  void saveSetting(SETTING_HOSTKEY_AUDIT_INTERVAL, v);
                }}
              >
                {HOSTKEY_AUDIT_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {s % 86_400 === 0
                      ? t("security.auditIntervalDays", { count: s / 86_400 })
                      : t("security.auditIntervalHours", { count: s / 3_600 })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="settings-hint">{t("security.hostkeyAuditHint")}</p>

          {/* B9（Task 6）：sudo 密码自动填充——安全敏感：默认关 + password
              （主密码）模式限定 + 开启须确认框说明风险（keyring 模式隐藏） */}
          {isPasswordMode && (
            <>
              <label className="settings-row" data-testid="sudo-autofill-row">
                <span className="settings-label">{t("security.sudoAutofill")}</span>
                <Switch
                  testid="sudo-autofill-toggle"
                  checked={sudoAutofill ?? false}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    if (on) {
                      setSudoConfirm(true); // 开启走确认框（cancel 时控件保持关）
                    } else {
                      setSudoConfirm(false);
                      setSudoAutofill(false);
                      void saveSetting("security.sudo_autofill", false);
                    }
                  }}
                />
              </label>
              <p className="settings-hint">{t("security.sudoAutofillHint")}</p>
              {sudoConfirm && (
                <div className="wizard-step" data-testid="sudo-autofill-dialog">
                  <p className="dialog-intro">{t("security.sudoAutofillWarn")}</p>
                  <div className="form-actions">
                    <button
                      type="button"
                      data-testid="sudo-autofill-cancel"
                      onClick={() => {
                        setSudoConfirm(false);
                        setSudoAutofill(false);
                        void saveSetting("security.sudo_autofill", false);
                      }}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn-accent"
                      data-testid="sudo-autofill-accept"
                      onClick={() => {
                        setSudoConfirm(false);
                        setSudoAutofill(true);
                        void saveSetting("security.sudo_autofill", true);
                      }}
                    >
                      {t("security.sudoAutofillAccept")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

            {/* --- 同步（Phase 5 Task 4）：通道三选一/信封口令/测试连接/立即同步 --- */}
            <div
              role="tabpanel"
              aria-label={t("settings.sectionSync")}
              hidden={pane !== "sync"}
              data-testid="sync-pane"
            >
              <SyncSettings onOpenSync={() => onOpenSyncDialog?.()} />
            </div>

            {/* --- 告警（B9 通知渠道 + 告警规则；自工具 dock 双入口归位设置）--- */}
            <div
              role="tabpanel"
              aria-label={t("settings.sectionAlerts")}
              hidden={pane !== "alerts"}
              data-testid="alerts-pane"
            >
              <PaneErrorBoundary label="alerts" fallbackText={t("settings.panelError")}>
                <AlertSettings open onClose={() => {}} />
              </PaneErrorBoundary>
            </div>

            {/* --- MCP（宿主接入配置；同上双入口）--- */}
            <div
              role="tabpanel"
              aria-label={t("settings.sectionMcp")}
              hidden={pane !== "mcp"}
              data-testid="mcp-pane"
            >
              <PaneErrorBoundary label="mcp" fallbackText={t("settings.panelError")}>
                <McpSettings open onClose={() => {}} />
              </PaneErrorBoundary>
            </div>

            {/* --- 外观（T2 键面沿用；persist 已迁 vault settings）--- */}
            <section
              role="tabpanel"
              aria-label={t("settings.sectionAppearance")}
              hidden={pane !== "appearance"}
              data-testid="appearance-section"
            >
              <h3>{t("settings.sectionAppearance")}</h3>
          {/* theme-suite T2.4：主题网格卡片——每卡 = 主题名 + 迷你色板预览条
              （4 色块纯 CSS，aria-hidden）+ radio 选中态；「跟随系统」保留为
              一卡。radiogroup/radio 互斥单选语义（WAI-ARIA）。卡片缩略色块是
              各主题静态预览（App.css .tp-* 值），不随当前主题走。 */}
          <div className="settings-row">
            <span className="settings-label">{t("settings.theme")}</span>
          </div>
          <div className="theme-grid" role="radiogroup" aria-label={t("settings.theme")} data-testid="theme-grid">
            {THEME_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={themeMode === m}
                data-testid={`theme-card-${m}`}
                className="theme-card"
                onClick={() => setMode(m)}
              >
                <span className={`theme-card-preview tp-${m}`} aria-hidden="true">
                  <i className="tp-swatch tp-bg" />
                  <i className="tp-swatch tp-surface" />
                  <i className="tp-swatch tp-fg" />
                  <i className="tp-swatch tp-accent" />
                </span>
                <span className="theme-card-name">{t(`settings.themes.${m}`)}</span>
              </button>
            ))}
          </div>
          {/* --- 终端配色（B2 主题生态，Phase 2 Task 9）：auto 跟随界面 /
              内置画廊 / 自定义（iTerm2 .itermcolors 与 Windows Terminal .json
              导入，vault settings 持久化）--- */}
          <label className="settings-row" data-testid="terminal-theme-row">
            <span className="settings-label">{t("settings.terminalTheme")}</span>
            <select
              data-testid="terminal-theme-select"
              value={terminalSelection}
              onChange={(e) => selectTerminalTheme(e.currentTarget.value)}
            >
              <option value={AUTO_TERMINAL_THEME_ID}>{t("settings.terminalThemeAuto")}</option>
              <optgroup label={t("settings.terminalThemeGallery")}>
                {TERMINAL_THEME_GALLERY.map((def) => (
                  <option key={def.id} value={def.id}>
                    {def.name}
                    {def.dark ? "" : ` · ${t("settings.terminalThemeLightTag")}`}
                  </option>
                ))}
              </optgroup>
              {terminalCustom.length > 0 && (
                <optgroup label={t("settings.terminalThemeCustom")}>
                  {terminalCustom.map((def) => (
                    <option key={def.id} value={def.id}>
                      {def.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <p className="settings-hint">{t("settings.terminalThemeHint")}</p>
          <div className="settings-row">
            <span className="settings-label">{t("settings.terminalThemeImport")}</span>
            <input
              ref={themeFileRef}
              type="file"
              accept=".itermcolors,.json,application/json,text/xml,text/plain"
              style={{ display: "none" }}
              data-testid="terminal-theme-file"
              onChange={(e) => {
                void importThemeFile(e.currentTarget.files?.[0]);
                e.currentTarget.value = ""; // 同名文件重选也触发 onChange
              }}
            />
            <button
              type="button"
              data-testid="terminal-theme-import"
              onClick={() => themeFileRef.current?.click()}
            >
              {t("settings.terminalThemeImport")}
            </button>
            {selectedCustomDef && (
              <button
                type="button"
                data-testid="terminal-theme-delete"
                onClick={() => removeTerminalTheme(selectedCustomDef.id)}
              >
                {t("common.delete")}
              </button>
            )}
          </div>
          {themeImportError && (
            <p className="form-error" data-testid="terminal-theme-error">
              {t("settings.terminalThemeImportFailed", { message: themeImportError })}
            </p>
          )}
          {themeImportedCount != null && (
            <p className="settings-hint" data-testid="terminal-theme-imported">
              {t("settings.terminalThemeImported", { count: themeImportedCount })}
            </p>
          )}
          {/* 终端字体族/字号（2026-10-10 用户要求）：写终端本地设置并广播
              ottr://terminal-settings，活动终端即时应用。 */}
          <label className="settings-row" data-testid="terminal-font-row">
            <span className="settings-label">{t("settings.terminalFont")}</span>
            <select
              data-testid="terminal-font-select"
              value={termFont ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value || null;
                setTermFont(v);
                applyTerminalFont(v, termFontSize ?? 13);
              }}
            >
              <option value="">{t("settings.terminalFontDefault")}</option>
              {FONT_CHOICES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-row" data-testid="terminal-font-size-row">
            <span className="settings-label">{t("settings.terminalFontSize")}</span>
            <select
              data-testid="terminal-font-size-select"
              value={String(termFontSize ?? 13)}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                setTermFontSize(v);
                applyTerminalFont(termFont, v);
              }}
            >
              {FONT_SIZE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {t("settings.terminalFontSizePt", { n })}
                </option>
              ))}
            </select>
          </label>
        </section>

            {/* --- 通用：语言 + 行为开关（关窗到托盘 / shell 集成，自外观节归位）--- */}
            <section
              role="tabpanel"
              aria-label={t("settings.sectionGeneral")}
              hidden={pane !== "general"}
              data-testid="general-section"
            >
              <h3>{t("settings.sectionGeneral")}</h3>
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
              {/* A12（Task 14）：关窗到托盘（三端统一默认开，简报裁定）。 */}
              <label className="settings-row" data-testid="close-to-tray-row">
                <span className="settings-label">{t("settings.closeToTray")}</span>
                <Switch
                  testid="close-to-tray-toggle"
                  checked={closeToTray ?? true}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setCloseToTray(on);
                    void saveSetting("ui.close_to_tray", on ? 1 : 0);
                  }}
                />
              </label>
              <p className="settings-hint">{t("settings.closeToTrayHint")}</p>
              {/* Task 15 fix 1/5：shell 集成自动注入（⌘R 历史搜索 / T13 报错即诊的
                  数据源）。关 = attach 不探测不注入；已自带集成的远端自动跳过。 */}
              <label className="settings-row" data-testid="shell-integration-row">
                <span className="settings-label">{t("settings.shellIntegration")}</span>
                <Switch
                  testid="shell-integration-toggle"
                  checked={shellIntegration ?? true}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setShellIntegration(on);
                    void saveSetting("shell.integration", on);
                  }}
                />
              </label>
              <p className="settings-hint">{t("settings.shellIntegrationHint")}</p>
              {/* 应用内检查更新（2026-10-09）：latest.json 更新源 + 签名校验下载安装 */}
              <div className="settings-row">
                <span className="settings-label">{t("settings.softwareUpdate")}</span>
              </div>
              <UpdateCheck />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
