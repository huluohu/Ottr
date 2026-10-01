// CredentialForm（Task 6，A3）：新建/编辑凭据，五类字段面（Phase 2 Task 5 起
//   kind 扩展 ftp/ftps——密码型，字段面与 password 相同，仅协议归属不同）：
//   password/ftp/ftps → secret（显隐切换）；key → 私钥 PEM + key_pub + passphrase（恒遮蔽）；
//   totp → totp_secret（base32 粗检）。
// 明文纪律：编辑模式不回填现有密钥（明文只经 credentials.reveal 单点出库），
// 留空 = CredentialPatch null = 保留现值（Rust 侧「未重输的密钥不重密封」）。
// 校验（裁定 #6）：password/key 主体非空 + 私钥 PEM 粗检 + TOTP base32 字符集粗检。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Credential, CredentialInput, CredentialKind, CredentialPatch } from "../vault/api";
import { useVaultStore } from "../vault/store";

export interface CredentialFormProps {
  /** 非空 = 编辑模式；null = 新建。 */
  credential: Credential | null;
  onClose: () => void;
}

/** 凭据类型候选（Phase 2 Task 5：+ ftp/ftps——密码型，见 kind_ftp/kind_ftps）。 */
const KINDS: CredentialKind[] = ["password", "key", "totp", "ftp", "ftps"];

/** 密码型凭据（secret 字段面与 password 完全一致）。 */
const PASSWORD_LIKE: CredentialKind[] = ["password", "ftp", "ftps"];

/** TOTP secret base32 粗检（裁定 #6）：RFC 4648 字符集（A-Z、2-7）+ `=` 填充，
 * 忽略空格；只查字符集与最短长度（8），不校验 padding 对齐——粗检把 obviously
 * 错误的输入挡在 UI，base32 严格解码属 TOTP 生成器（后续任务）。 */
export function isRoughBase32(value: string): boolean {
  const s = value.replace(/\s+/g, "");
  return s.length >= 8 && /^[A-Za-z2-7]+={0,6}$/.test(s);
}

/** 私钥 PEM 粗检：openssh / PKCS#8 / PKCS#1 / PuTTY PPK 一律放行（russh 支持面，
 * 见 ottr-ssh keygen 模块 doc），只挡明显不是私钥的输入。 */
export function looksLikePrivateKey(pem: string): boolean {
  return pem.includes("-----BEGIN") && pem.includes("PRIVATE KEY-----");
}

export function CredentialForm({ credential, onClose }: CredentialFormProps) {
  const { t } = useTranslation();
  const createCredential = useVaultStore((s) => s.createCredential);
  const updateCredential = useVaultStore((s) => s.updateCredential);

  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? "password");
  const [secret, setSecret] = useState("");
  const [keyPub, setKeyPub] = useState(credential?.key_pub ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    // 编辑模式密钥留空 = 保留现值（patch null），只拦「新建必填」与「重输格式错」
    if (PASSWORD_LIKE.includes(kind)) {
      if (secret.trim() === "") {
        if (credential == null) {
          setError(t("credentialForm.errSecretRequired"));
          return false;
        }
      }
    } else if (kind === "key" && secret.trim() !== "" && !looksLikePrivateKey(secret)) {
      setError(t("credentialForm.errPrivateKeyMalformed"));
      return false;
    } else if (kind === "key" && secret.trim() === "") {
      if (credential == null) {
        setError(t("credentialForm.errPrivateKeyRequired"));
        return false;
      }
    }
    if (kind === "totp") {
      if (totpSecret.trim() === "") {
        if (credential == null) {
          setError(t("credentialForm.errTotpRequired"));
          return false;
        }
      } else if (!isRoughBase32(totpSecret)) {
        setError(t("credentialForm.errTotpBase32"));
        return false;
      }
    }
    setError(null);
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (credential) {
        // patch null = 保留现值：编辑时未重输的密钥字段传 null
        const patch: CredentialPatch = {
          kind: kind === credential.kind ? null : kind,
          secret: secret === "" ? null : secret,
          key_pub: keyPub.trim() === "" ? null : keyPub.trim(),
          passphrase: passphrase === "" ? null : passphrase,
          totp_secret: totpSecret === "" ? null : totpSecret,
        };
        await updateCredential(credential.id, patch);
      } else {
        const input: CredentialInput = {
          kind,
          secret: secret === "" ? null : secret,
          key_pub: keyPub.trim() === "" ? null : keyPub.trim(),
          passphrase: passphrase === "" ? null : passphrase,
          totp_secret: totpSecret === "" ? null : totpSecret,
        };
        await createCredential(input);
      }
      onClose();
    } catch (err) {
      setError(t("credentialForm.saveFailed", { message: String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  const editing = credential != null;

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? t("credentialForm.editTitle", { id: credential.id }) : t("credentialForm.newTitle")}
    >
      <form className="host-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <h2>{editing ? t("credentialForm.editTitle", { id: credential.id }) : t("credentialForm.newTitle")}</h2>

        <label>
          <span>{t("credentialForm.kind")}</span>
          <select
            data-testid="cred-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.currentTarget.value as CredentialKind);
              setError(null);
            }}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`credentials.kind_${k}`)}
              </option>
            ))}
          </select>
        </label>

        {PASSWORD_LIKE.includes(kind) && (
          <label>
            <span>{t("credentialForm.secret")}</span>
            <span className="secret-field">
              <input
                data-testid="cred-secret"
                type={showSecret ? "text" : "password"}
                value={secret}
                placeholder={editing ? t("credentialForm.keepSecret") : t("credentialForm.secretPlaceholder")}
                autoComplete="off"
                onChange={(e) => setSecret(e.currentTarget.value)}
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

        {kind === "key" && (
          <label>
            <span>{t("credentialForm.privateKey")}</span>
            <textarea
              data-testid="cred-private-key"
              value={secret}
              rows={5}
              spellCheck={false}
              placeholder={editing ? t("credentialForm.keepSecret") : t("credentialForm.privateKeyPlaceholder")}
              onChange={(e) => setSecret(e.currentTarget.value)}
            />
          </label>
        )}

        {kind === "key" && (
          <>
            <label>
              <span>{t("credentialForm.keyPub")}</span>
              <input
                data-testid="cred-key-pub"
                value={keyPub}
                placeholder={t("credentialForm.keyPubPlaceholder")}
                spellCheck={false}
                onChange={(e) => setKeyPub(e.currentTarget.value)}
              />
            </label>
            <label>
              <span>{t("credentialForm.passphrase")}</span>
              <input
                data-testid="cred-passphrase"
                type="password"
                value={passphrase}
                placeholder={editing ? t("credentialForm.keepSecret") : t("credentialForm.passphrasePlaceholder")}
                autoComplete="new-password"
                onChange={(e) => setPassphrase(e.currentTarget.value)}
              />
            </label>
          </>
        )}

        {kind === "totp" && (
          <label>
            <span>{t("credentialForm.totpSecret")}</span>
            <input
              data-testid="cred-totp-secret"
              type="password"
              value={totpSecret}
              placeholder={editing ? t("credentialForm.keepSecret") : t("credentialForm.totpSecretPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTotpSecret(e.currentTarget.value)}
            />
          </label>
        )}

        {error && (
          <p className="form-error" data-testid="cred-error">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" onClick={onClose} data-testid="cred-cancel">
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-accent" disabled={submitting} data-testid="cred-submit">
            {t("credentialForm.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
