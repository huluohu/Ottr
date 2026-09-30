// LockScreen（T11，A7）：锁定遮罩——password 模式下 vault 锁定时盖全屏。
// 解锁失败（主密码错）红字提示；错误文案来自 Rust（BadMasterPassword Display），
// 前端按 "master password is incorrect" 识别出友好文案，其余原样透出。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVaultLockStore } from "./VaultLockStore";

export function LockScreen() {
  const { t } = useTranslation();
  const unlock = useVaultLockStore((s) => s.unlock);
  const storeError = useVaultLockStore((s) => s.error);
  const unlocking = useVaultLockStore((s) => s.unlocking);
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

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
      </form>
    </div>
  );
}
