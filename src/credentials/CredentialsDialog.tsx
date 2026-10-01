// CredentialsDialog（Task 6，A3/A4）：凭据与密钥的挂载点——overlay 对话框双 tab
// （凭据列表 / 密钥管理），入口在顶栏。布局语言沿用 ImportDialog（.overlay > .dialog）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CredentialList } from "./CredentialList";
import { KeyManager } from "./KeyManager";

export function CredentialsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"credentials" | "keys">("credentials");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("credentials.dialogTitle")}>
      <div className="dialog credentials-dialog" data-testid="credentials-dialog">
        <div className="dialog-head">
          <h2>{t("credentials.dialogTitle")}</h2>
          <button type="button" className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dialog-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "credentials"}
            data-active={tab === "credentials"}
            data-testid="cred-tab"
            onClick={() => setTab("credentials")}
          >
            {t("credentials.tabCredentials")}
          </button>
          <button
            role="tab"
            aria-selected={tab === "keys"}
            data-active={tab === "keys"}
            data-testid="keys-tab"
            onClick={() => setTab("keys")}
          >
            {t("credentials.tabKeys")}
          </button>
        </div>
        {tab === "credentials" ? <CredentialList /> : <KeyManager />}
      </div>
    </div>
  );
}
