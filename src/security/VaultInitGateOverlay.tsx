// VaultInitGate 遮罩（Task 16.5 引入于 App.tsx，BL-208 F3 迁出为独立组件）：
// vault 后台初始化 loading/failed 两态的全屏遮罩。
//
// BL-208 F3（0×0 系，终审C-16）「就绪窗口键盘可达」：failed 态是模态错误面，
// 键盘用户必须能不碰鼠标就到达唯一动作（退出）——挂载即聚焦退出按钮 +
// role=alertdialog/aria-modal 语义（读屏器宣告为对话框、遮罩外内容视为惰性）。
// loading 态无动作可操作，role=status 播报即可。
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { VaultInitPhase } from "./VaultInitGate";

export interface VaultInitGateOverlayProps {
  phase: VaultInitPhase;
  error: string | null;
}

export function VaultInitGateOverlay({ phase, error }: VaultInitGateOverlayProps) {
  const { t } = useTranslation();
  const quitRef = useRef<HTMLButtonElement>(null);

  // F3：failed 面出现即把焦点交给退出按钮（Tab 环第一站，免全屏 Tab 巡历）。
  useEffect(() => {
    if (phase === "failed") quitRef.current?.focus();
  }, [phase]);

  if (phase === "initializing") {
    return (
      <div className="overlay lock-screen" data-testid="vault-init-loading" role="status">
        <div className="dialog lock-card">
          <h2>Ottr</h2>
          <p className="dialog-intro">{t("security.vaultInit.loading")}</p>
        </div>
      </div>
    );
  }
  if (phase === "failed") {
    return (
      <div className="overlay lock-screen" data-testid="vault-init-failed" role="alertdialog" aria-modal="true">
        <div className="dialog lock-card">
          <h2>{t("security.vaultInit.failedTitle")}</h2>
          <p className="form-error" data-testid="vault-init-error">
            {error}
          </p>
          <p className="dialog-intro">{t("security.vaultInit.failedHint")}</p>
          <div className="form-actions">
            <button
              type="button"
              className="btn-accent"
              data-testid="vault-init-quit"
              ref={quitRef}
              onClick={() => invoke("quit_app").catch(() => {})}
            >
              {t("security.vaultInit.quit")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
