// CredentialList（Task 6，A3）：凭据列表 + 删除确认。
// 删除确认（裁定 #6）：确认框提示「N 台主机将解除绑定」——N 从 hosts 数据现算
// （host.credential_id === 凭据 id）；FK ON DELETE SET NULL 只解绑不级联删。
// 列表项不含任何密钥材料（Credential 序列化面天然无密钥），仅展示 kind 与公钥摘要。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Credential } from "../vault/api";
import { useVaultStore } from "../vault/store";
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

  function boundHostCount(id: number): number {
    return hosts.filter((h) => h.credential_id === id).length;
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
            const pubSnippet = c.key_pub ? c.key_pub.trim().split(/\s+/)[1]?.slice(0, 12) : undefined;
            return (
              <li key={c.id} className="cred-item" data-testid={`cred-item-${c.id}`}>
                <span className={`cred-kind cred-kind-${c.kind}`}>{t(`credentials.kind_${c.kind}`)}</span>
                <span className="cred-title">{t("credentials.itemTitle", { id: c.id })}</span>
                {pubSnippet && <code className="cred-pub">{pubSnippet}…</code>}
                <span className="cred-meta">{t("credentials.boundCount", { count: bound })}</span>
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
