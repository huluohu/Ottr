// CredentialForm（Task 6，A3）：新建/编辑凭据，五类字段面（Phase 2 Task 5 起
//   kind 扩展 ftp/ftps——密码型，字段面与 password 相同，仅协议归属不同）：
//   password/ftp/ftps → secret（显隐切换）；key → 私钥 PEM + key_pub + passphrase（恒遮蔽）；
//   totp → totp_secret（base32 粗检）。
// 明文纪律：编辑模式不回填现有密钥（明文只经 credentials.reveal 单点出库），
// 留空 = CredentialPatch null = 保留现值（Rust 侧「未重输的密钥不重密封」）。
// 校验（裁定 #6）：password/key 主体非空 + 私钥 PEM 粗检 + TOTP base32 字符集粗检
// ——规则本体已抽至 credentialDraft.ts（Phase 5 T1：HostForm「＋ 新建凭据…」
// 内联子表单共用同一套），本组件只做挂载与提交。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Credential, CredentialKind, CredentialPatch } from "../vault/api";
import { useVaultStore } from "../vault/store";
import {
  CREDENTIAL_KINDS,
  PASSWORD_LIKE_KINDS,
  credentialInputFrom,
  validateCredentialDraft,
} from "./credentialDraft";
import { useEscClose } from "../ui/useEscClose";

/** 「必填」类错误键（编辑模式留空豁免面，见 validate）。 */
const REQUIRED_KEYS = [
  "credentialForm.errSecretRequired",
  "credentialForm.errPrivateKeyRequired",
  "credentialForm.errTotpRequired",
];

export interface CredentialFormProps {
  /** 非空 = 编辑模式；null = 新建。 */
  credential: Credential | null;
  onClose: () => void;
}

export function CredentialForm({ credential, onClose }: CredentialFormProps) {
  const { t } = useTranslation();
  useEscClose(true, onClose);
  const createCredential = useVaultStore((s) => s.createCredential);
  const updateCredential = useVaultStore((s) => s.updateCredential);

  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? "password");
  const [name, setName] = useState(credential?.name ?? "");
  const [secret, setSecret] = useState("");
  const [keyPub, setKeyPub] = useState(credential?.key_pub ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * BL-204（终审C-13）跨族 kind 变更判定：新旧 kind 不同且不都是密码型
   * （password/ftp/ftps 互转字段面完全一致 = 同族）。跨族（涉 key/totp 边界）
   * 时旧族密钥不能以「保留现值」形态挂进新族实体。
   */
  function isCrossFamilyEdit(): boolean {
    if (credential == null || kind === credential.kind) return false;
    return !(
      PASSWORD_LIKE_KINDS.includes(kind) && PASSWORD_LIKE_KINDS.includes(credential.kind)
    );
  }

  function validate(): boolean {
    const errKey = validateCredentialDraft({ name: name.trim(), kind, secret, keyPub, passphrase, totpSecret });
    if (errKey == null) {
      setError(null);
      return true;
    }
    // 编辑模式豁免：「必填」类错误 = 字段留空 = 保留现值（patch null 承接，
    // Rust 侧「未重输的密钥不重密封」）；「格式错」类（重输了但格式不对）仍拦。
    // 三个 err*Required 键只在对应字段为空时产生，豁免无需再查字段值。
    // 跨族 kind 变更豁免不适用：key/totp 边界两侧字段语义不同，新族必填密钥
    // 必须重新输入（否则旧族的密码/PEM 会原样顶新族的密钥用）。
    if (credential != null && !isCrossFamilyEdit() && REQUIRED_KEYS.includes(errKey)) {
      setError(null);
      return true;
    }
    setError(t(errKey));
    return false;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      if (credential) {
        // patch null = 保留现值：编辑时未重输的密钥字段传 null。
        // 跨族 kind 变更（BL-204）：非新族字段显式传 ""（Rust Some("") 覆写
        // 为空），清掉旧族残留——否则 key_pub/passphrase/旧密码会挂在改族后
        // 的实体上（kind→password 时旧公钥残留、kind→totp 时旧密码残留）。
        let patch: CredentialPatch;
        if (isCrossFamilyEdit()) {
          patch = {
            kind,
            name: name.trim() === "" ? null : name.trim(),
            secret: PASSWORD_LIKE_KINDS.includes(kind) || kind === "key" ? secret : "",
            key_pub: kind === "key" ? keyPub.trim() : "",
            passphrase: kind === "key" ? passphrase : "",
            totp_secret: kind === "totp" ? totpSecret : "",
          };
        } else {
          patch = {
            kind: kind === credential.kind ? null : kind,
            name: name.trim() === "" ? null : name.trim(),
            secret: secret === "" ? null : secret,
            key_pub: keyPub.trim() === "" ? null : keyPub.trim(),
            passphrase: passphrase === "" ? null : passphrase,
            totp_secret: totpSecret === "" ? null : totpSecret,
          };
        }
        await updateCredential(credential.id, patch);
      } else {
        await createCredential(credentialInputFrom({ name: name.trim(), kind, secret, keyPub, passphrase, totpSecret }));
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
            {CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`credentials.kind_${k}`)}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>{t("credentialForm.name")}</span>
          <input
            type="text"
            data-testid="credential-name"
            value={name}
            placeholder={t("credentialForm.namePlaceholder")}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>

        {PASSWORD_LIKE_KINDS.includes(kind) && (
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
