// LockScreen（T11，A7）：锁定遮罩——password 模式下 vault 锁定时盖全屏。
// 解锁失败（主密码错）红字提示；错误文案来自 Rust（BadMasterPassword Display），
// 前端按 "master password is incorrect" 识别出友好文案，其余原样透出。
//
// product-ready T5（BL-537 清偿）：「忘记密码？」引导——主密码不可找回（加密
// 语义，密钥派生自主密码），唯一出路 = 重置应用（清本机库 + 清钥匙链，回到
// 首启状态，1Password 同款）。交互纪律：
//   * 入口 = link 式文本按钮，说明区**就地展开**（不弹窗、不抢解锁主视觉）；
//   * 终局动作二击确认（armed 语义沿 InsertRow T13：一击变「确认重置」、
//     再击执行；收起面板即解除 armed）；
//   * 确认前不发起任何命令（清库在 Rust 侧另有 confirm 门卫双保险）；
//   * 清库失败错误如实上屏，armed 保持可重试。成功 = 进程重启回首启流程
//     （invoke 永不 resolve 是预期——webview 随进程销毁）。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi } from "../vault/api";
import { useVaultLockStore } from "./VaultLockStore";

export function LockScreen() {
  const { t } = useTranslation();
  const unlock = useVaultLockStore((s) => s.unlock);
  const storeError = useVaultLockStore((s) => s.error);
  const unlocking = useVaultLockStore((s) => s.unlocking);
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  // 忘记密码引导（T5/BL-537）：面板展开态 + armed 二击确认 + 重置在途/错误。
  const [helpOpen, setHelpOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  function handleToggleHelp() {
    setHelpOpen((v) => !v);
    setArmed(false);
    setResetError(null);
  }

  function handleReset() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setResetting(true);
    setResetError(null);
    vaultApi.security.reset().catch((e: unknown) => {
      // 进程重启场景下 invoke 不 resolve 也不 reject——走到这里即真实清库
      // 失败，如实上屏；armed 保持，残余数据按重试语义可再次二击。
      setResetting(false);
      setResetError(e instanceof Error ? e.message : String(e));
    });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password === "") {
      setLocalError(t("security.lockScreen.errEmpty"));
      return;
    }
    setLocalError(null);
    void unlock(password);
  }

  const error = localError ?? storeError;
  const wrongPassword = storeError?.includes("master password is incorrect") ?? false;

  return (
    <div className="overlay lock-screen" data-testid="lock-screen" role="dialog" aria-modal="true" aria-label={t("security.lockScreen.title")}>
      <form className="dialog lock-card" onSubmit={handleSubmit} noValidate>
        <h2>{t("security.lockScreen.title")}</h2>
        <p className="dialog-intro">{t("security.lockScreen.hint")}</p>
        <label>
          <span>{t("security.masterPassword")}</span>
          <input
            type="password"
            data-testid="lock-password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        {error && (
          <p className="form-error" data-testid="lock-error">
            {wrongPassword ? t("security.lockScreen.errWrongPassword") : error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn-accent" data-testid="lock-unlock" disabled={unlocking}>
            {unlocking ? t("common.loading") : t("security.lockScreen.unlock")}
          </button>
        </div>
        <button
          type="button"
          className="lock-forgot"
          data-testid="lock-forgot"
          aria-expanded={helpOpen}
          onClick={handleToggleHelp}
        >
          {t("security.lockScreen.forgot")}
        </button>
        {helpOpen && (
          <div className="lock-reset-panel" data-testid="lock-reset-panel">
            <p className="lock-reset-title">{t("security.lockScreen.resetTitle")}</p>
            <p>{t("security.lockScreen.resetNoRecover")}</p>
            <p>{t("security.lockScreen.resetExplain")}</p>
            <p>{t("security.lockScreen.resetSyncNote")}</p>
            {resetError && (
              <p className="form-error" data-testid="lock-reset-error">
                {resetError}
              </p>
            )}
            <button
              type="button"
              className="btn-danger"
              data-testid="lock-reset-arm"
              disabled={resetting}
              onClick={handleReset}
            >
              {armed ? t("security.lockScreen.resetArmed") : t("security.lockScreen.resetArm")}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
