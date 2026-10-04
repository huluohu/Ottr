// CredentialList（Task 6，A3）：凭据列表 + 删除确认 + 密码复制（T11）。
// 删除确认（裁定 #6）：确认框提示「N 台主机将解除绑定」——N 从 hosts 数据现算
// （host.credential_id === 凭据 id）；FK ON DELETE SET NULL 只解绑不级联删。
// 列表项不含任何密钥材料（Credential 序列化面天然无密钥），仅展示 kind 与公钥摘要。
// T11 密码复制：vault_copy_credential_secret——明文在 Rust 侧解密直写剪贴板并
// 定时清空（默认 30s 可关），前端永不接触明文（复制成功只亮「已复制」提示）。
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type Credential } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { keyFingerprint } from "./fingerprint";
import { CredentialForm } from "./CredentialForm";

export function CredentialList() {
  const { t } = useTranslation();
  const credentials = useVaultStore((s) => s.credentials);
  const hosts = useVaultStore((s) => s.hosts);
  const deleteCredential = useVaultStore((s) => s.deleteCredential);
  /** 删除确认中的凭据 id（inline 确认条，语义同 HostTree「再次点击确认」但带计数）。 */
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  /** 正在编辑的凭据；"new" = 新建表单。 */
  const [form, setForm] = useState<Credential | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 复制成功提示的凭据 id（「已复制」微光；复制失败走 error 条）。 */
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function boundHostCount(id: number): number {
    return hosts.filter((h) => h.credential_id === id).length;
  }

  async function handleCopyPassword(c: Credential) {
    setError(null);
    try {
      // 明文不回前端：命令内部 reveal + 剪贴板 + 清空调度（Rust security.rs）。
      await vaultApi.copyCredentialSecret(c.id, "secret");
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      setCopiedId(c.id);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      setError(t("credentials.copyFailed", { message: String(err) }));
    }
  }

  async function handleConfirmDelete(id: number) {
    setError(null);
    try {
      await deleteCredential(id);
      setConfirmingId(null);
    } catch (err) {
      setError(t("credentials.deleteFailed", { message: String(err) }));
    }
  }

  return (
    <section aria-label={t("credentials.tabCredentials")} data-testid="cred-list">
      <div className="cred-toolbar">
        <button className="btn-accent" data-testid="cred-new" onClick={() => setForm("new")}>
          {t("credentials.newCredential")}
        </button>
      </div>

      {credentials.length === 0 ? (
        <p className="tree-empty" data-testid="cred-empty">
          {t("credentials.empty")}
        </p>
      ) : (
        <ul className="cred-items">
          {credentials.map((c) => {
            const bound = boundHostCount(c.id);
            // key 指纹（批次三 T3，BL-529）：base64 体短指纹——旧「头 12 字符」
            // 在同型 key（ed25519）下恒同，双凭据不可辨
            const pubSnippet = c.key_pub ? keyFingerprint(c.key_pub) : null;
            return (
              <li key={c.id} className="cred-item" data-testid={`cred-item-${c.id}`}>
                <span className={`cred-kind cred-kind-${c.kind}`}>{t(`credentials.kind_${c.kind}`)}</span>
                <span className="cred-title">{t("credentials.itemTitle", { id: c.id })}</span>
                {pubSnippet && (
                  <code className="cred-pub" title={t("credentials.fingerprintTitle", { fp: pubSnippet })}>
                    #{pubSnippet}
                  </code>
                )}
                <span className="cred-meta">{t("credentials.boundCount", { count: bound })}</span>
                {c.kind === "password" && (
                  <button
                    type="button"
                    data-testid={`cred-copy-${c.id}`}
                    aria-label={t("credentials.copyPasswordAria", { id: c.id })}
                    onClick={() => void handleCopyPassword(c)}
                  >
                    {copiedId === c.id ? t("credentials.copied") : t("credentials.copyPassword")}
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`cred-edit-${c.id}`}
                  aria-label={t("credentials.editAria", { id: c.id })}
                  onClick={() => setForm(c)}
                >
                  {t("common.edit")}
                </button>
                <button
                  type="button"
                  data-testid={`cred-delete-${c.id}`}
                  aria-label={t("credentials.deleteAria", { id: c.id })}
                  onClick={() => setConfirmingId(c.id)}
                >
                  {t("common.delete")}
                </button>

                {confirmingId === c.id && (
                  <div className="cred-confirm" data-testid={`cred-confirm-${c.id}`}>
                    <p data-testid="cred-confirm-text">
                      {bound > 0
                        ? t("credentials.deleteWillUnbind", { count: bound })
                        : t("credentials.deleteNoHosts")}
                    </p>
                    <div className="form-actions">
                      <button type="button" data-testid="cred-cancel-delete" onClick={() => setConfirmingId(null)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        data-testid="cred-confirm-delete"
                        onClick={() => void handleConfirmDelete(c.id)}
                      >
                        {t("credentials.confirmDelete")}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="form-error" data-testid="cred-list-error">
          {error}
        </p>
      )}

      {form && (
        <CredentialForm credential={form === "new" ? null : form} onClose={() => setForm(null)} />
      )}
    </section>
  );
}
