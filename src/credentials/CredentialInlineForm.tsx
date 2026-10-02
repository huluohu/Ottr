// CredentialInlineForm（Phase 5 T1）：HostForm 凭据下拉选「＋ 新建凭据…」时
// 的内联子表单——用户不离开主机表单即可就地填写并随主机保存一并创建凭据。
// 复用纪律：字段面/校验/载荷全部来自 credentialDraft.ts 共享规则（与凭据
// 对话框 CredentialForm 同源），存储只经调用方传入的 createCredential
// （useVaultStore → vaultApi credentials_create → vault seal），无自建路径。
// 本组件纯受控呈现：值与错误由 HostForm 持有（提交时统一校验），这里只渲染
// 与回传变更；testid 与 CredentialForm 同名对齐（cred-kind/cred-secret/…），
// 同一套断言两个挂点都可复用。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CREDENTIAL_KINDS, PASSWORD_LIKE_KINDS, type CredentialDraft } from "./credentialDraft";

export interface CredentialInlineFormProps {
  draft: CredentialDraft;
  /** 任意字段变更（含类型切换）回传 HostForm。 */
  onDraftChange: (next: CredentialDraft) => void;
  /** 已渲染的错误文案（HostForm 在提交时校验后传入）；null = 无错误。 */
  error: string | null;
  /** 收起内联子表单（放弃草稿）。 */
  onCancel: () => void;
}

export function CredentialInlineForm({ draft, onDraftChange, error, onCancel }: CredentialInlineFormProps) {
  const { t } = useTranslation();
  const [showSecret, setShowSecret] = useState(false);
  const patch = (part: Partial<CredentialDraft>) => onDraftChange({ ...draft, ...part });

  return (
    <div className="cred-inline" data-testid="form-cred-inline">
      <div className="cred-inline-head">
        <span>{t("credentials.newCredential")}</span>
        <button type="button" data-testid="form-cred-cancel" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>

      <label>
        <span>{t("credentialForm.kind")}</span>
        <select
          data-testid="cred-kind"
          value={draft.kind}
          onChange={(e) => {
            patch({ kind: e.currentTarget.value as CredentialDraft["kind"] });
            setShowSecret(false);
          }}
        >
          {CREDENTIAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`credentials.kind_${k}`)}
            </option>
          ))}
        </select>
      </label>

      {PASSWORD_LIKE_KINDS.includes(draft.kind) && (
        <label>
          <span>{t("credentialForm.secret")}</span>
          <span className="secret-field">
            <input
              data-testid="cred-secret"
              type={showSecret ? "text" : "password"}
              value={draft.secret}
              placeholder={t("credentialForm.secretPlaceholder")}
              autoComplete="off"
              onChange={(e) => patch({ secret: e.currentTarget.value })}
            />
            <button
              type="button"
              className="secret-toggle"
              data-testid="cred-toggle-secret"
              aria-pressed={showSecret}
              aria-label={showSecret ? t("credentialForm.hide") : t("credentialForm.reveal")}
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? t("credentialForm.hide") : t("credentialForm.reveal")}
            </button>
          </span>
        </label>
      )}

      {draft.kind === "key" && (
        <label>
          <span>{t("credentialForm.privateKey")}</span>
          <textarea
            data-testid="cred-private-key"
            value={draft.secret}
            rows={4}
            spellCheck={false}
            placeholder={t("credentialForm.privateKeyPlaceholder")}
            onChange={(e) => patch({ secret: e.currentTarget.value })}
          />
        </label>
      )}

      {draft.kind === "key" && (
        <div className="form-grid-2">
          <label>
            <span>{t("credentialForm.keyPub")}</span>
            <input
              data-testid="cred-key-pub"
              value={draft.keyPub}
              placeholder={t("credentialForm.keyPubPlaceholder")}
              spellCheck={false}
              onChange={(e) => patch({ keyPub: e.currentTarget.value })}
            />
          </label>
          <label>
            <span>{t("credentialForm.passphrase")}</span>
            <input
              data-testid="cred-passphrase"
              type="password"
              value={draft.passphrase}
              placeholder={t("credentialForm.passphrasePlaceholder")}
              autoComplete="new-password"
              onChange={(e) => patch({ passphrase: e.currentTarget.value })}
            />
          </label>
        </div>
      )}

      {draft.kind === "totp" && (
        <label>
          <span>{t("credentialForm.totpSecret")}</span>
          <input
            data-testid="cred-totp-secret"
            type="password"
            value={draft.totpSecret}
            placeholder={t("credentialForm.totpSecretPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => patch({ totpSecret: e.currentTarget.value })}
          />
        </label>
      )}

      {error && (
        <p className="form-error" data-testid="cred-error">
          {error}
        </p>
      )}
    </div>
  );
}
