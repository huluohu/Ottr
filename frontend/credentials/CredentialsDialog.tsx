// CredentialsDialog（Task 6，A3/A4）：凭据与密钥的挂载点——overlay 对话框三 tab
// （凭据列表 / 密钥管理 / 已知主机 B9），入口在顶栏。布局语言沿用 ImportDialog
// （.overlay > .dialog）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useEscClose } from "../ui/useEscClose";
import { CredentialList } from "./CredentialList";
import { KeyManager } from "./KeyManager";
import { KnownHostsManager } from "../security/KnownHostsManager";

type DialogTab = "credentials" | "keys" | "knownHosts";

export function CredentialsDialog({ onClose, closing }: { onClose: () => void; closing?: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DialogTab>("credentials");
  // 子层（凭据表单 / 已知主机取证与删除确认）先挂载先注册，Esc 由其先消费
  // （hook 内 stopImmediatePropagation），此处只在无子层时关整框。
  useEscClose(true, onClose);

  return (
    <div
      className={`overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("credentials.dialogTitle")}
    >
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
          <button
            role="tab"
            aria-selected={tab === "knownHosts"}
            data-active={tab === "knownHosts"}
            data-testid="known-hosts-tab"
            onClick={() => setTab("knownHosts")}
          >
            {t("credentials.tabKnownHosts")}
          </button>
        </div>
        {tab === "credentials" ? (
          <CredentialList />
        ) : tab === "keys" ? (
          <KeyManager />
        ) : (
          <KnownHostsManager />
        )}
      </div>
    </div>
  );
}
