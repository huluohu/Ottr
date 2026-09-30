// HostForm（Task 5 Step 2）：新建/编辑主机。
// 字段：name/address/port/username/凭据选择/编码覆盖/标签/分组/备注；
// 校验（简报）：地址非空、端口 1-65535 整数；错误提示走 i18n。
// 名称留空时以地址兜底（vault 层拒绝空名，这里先收敛）。
// 凭据创建/编辑属 Task 6 域，此处只从现有凭据中选择绑定。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Host, HostInput } from "../vault/api";
import { useVaultStore } from "../vault/store";

export interface HostFormProps {
  /** 非空 = 编辑模式；null = 新建。 */
  host: Host | null;
  /** 新建时的预选分组（树内分组上下文菜单入口）。 */
  defaultGroupId: number | null;
  onClose: () => void;
}

/** 编码覆盖候选（值与 ottr-term encoding 支持集对齐；"" = 不覆盖）。 */
const ENCODINGS = ["utf-8", "gbk", "gb18030", "big5", "shift_jis", "euc-kr"];

export function HostForm({ host, defaultGroupId, onClose }: HostFormProps) {
  const { t } = useTranslation();
  const hostGroups = useVaultStore((s) => s.hostGroups);
  const credentials = useVaultStore((s) => s.credentials);
  const createHost = useVaultStore((s) => s.createHost);
  const updateHost = useVaultStore((s) => s.updateHost);

  const [name, setName] = useState(host?.name ?? "");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [groupId, setGroupId] = useState<string>(String(host?.group_id ?? defaultGroupId ?? ""));
  const [credentialId, setCredentialId] = useState<string>(
    host?.credential_id != null ? String(host.credential_id) : "",
  );
  const [encoding, setEncoding] = useState(host?.encoding_override ?? "");
  const [tagsText, setTagsText] = useState((host?.tags ?? []).join(", "));
  const [notes, setNotes] = useState(host?.notes ?? "");
  const [errors, setErrors] = useState<{ address?: string; port?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): boolean {
    const next: typeof errors = {};
    if (!address.trim()) {
      next.address = t("hostForm.errAddressRequired");
    }
    // 先做十进制字面量预筛（T5 M-4 收紧，Task 8）：Number() 会把 "0x10"→16、
    // "1e2"→100 当合法数字，宽松解析放过的端口与用户所见不一致；只接受纯数字串。
    const parsed = /^\d+$/.test(port.trim()) ? Number(port.trim()) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      next.port = t("hostForm.errPortRange");
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    const addr = address.trim();
    const input: HostInput = {
      // 名称留空 → 地址兜底（vault 拒绝空名）
      name: name.trim() || addr,
      group_id: groupId === "" ? null : Number(groupId),
      tags: tagsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      address: addr,
      port: Number(port.trim()),
      username: username.trim() === "" ? null : username.trim(),
      credential_id: credentialId === "" ? null : Number(credentialId),
      jump_chain_id: host?.jump_chain_id ?? null,
      encoding_override: encoding === "" ? null : encoding,
      theme_override: host?.theme_override ?? null,
      monitor_enabled: host?.monitor_enabled ?? false,
      notes: notes.trim() === "" ? null : notes.trim(),
    };
    try {
      if (host) {
        await updateHost(host.id, input);
      } else {
        await createHost(input);
      }
      onClose();
    } catch (err) {
      setSubmitError(t("hostForm.saveFailed", { message: String(err) }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={host ? t("hostForm.editTitle") : t("hostForm.newTitle")}>
      <form className="host-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <h2>{host ? t("hostForm.editTitle") : t("hostForm.newTitle")}</h2>

        <label>
          <span>{t("hostForm.name")}</span>
          <input
            data-testid="form-name"
            value={name}
            placeholder={t("hostForm.namePlaceholder")}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <div className="form-row">
          <label className="grow">
            <span>{t("hostForm.host")}</span>
            <input
              data-testid="form-address"
              value={address}
              placeholder={t("hostForm.hostPlaceholder")}
              onChange={(e) => setAddress(e.currentTarget.value)}
              aria-invalid={errors.address != null}
            />
          </label>
          <label className="port">
            <span>{t("hostForm.port")}</span>
            <input
              data-testid="form-port"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.currentTarget.value)}
              aria-invalid={errors.port != null}
            />
          </label>
          <label className="grow">
            <span>{t("hostForm.username")}</span>
            <input
              data-testid="form-username"
              value={username}
              placeholder={t("hostForm.usernamePlaceholder")}
              onChange={(e) => setUsername(e.currentTarget.value)}
            />
          </label>
        </div>
        {(errors.address || errors.port) && (
          <p className="form-error" data-testid="form-error">
            {errors.address ?? errors.port}
          </p>
        )}

        <div className="form-row">
          <label>
            <span>{t("hostForm.group")}</span>
            <select
              data-testid="form-group"
              value={groupId}
              onChange={(e) => setGroupId(e.currentTarget.value)}
            >
              <option value="">{t("hostForm.groupNone")}</option>
              {hostGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("hostForm.credential")}</span>
            <select
              data-testid="form-credential"
              value={credentialId}
              onChange={(e) => setCredentialId(e.currentTarget.value)}
            >
              <option value="">{t("hostForm.credentialNone")}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("hostForm.credentialLabel", { id: c.id, kind: c.kind })}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("hostForm.encoding")}</span>
            <select
              data-testid="form-encoding"
              value={encoding ?? ""}
              onChange={(e) => setEncoding(e.currentTarget.value)}
            >
              <option value="">{t("hostForm.encodingDefault")}</option>
              {ENCODINGS.map((enc) => (
                <option key={enc} value={enc}>
                  {enc.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span>{t("hostForm.tags")}</span>
          <input
            data-testid="form-tags"
            value={tagsText}
            placeholder={t("hostForm.tagsPlaceholder")}
            onChange={(e) => setTagsText(e.currentTarget.value)}
          />
        </label>

        <label>
          <span>{t("hostForm.notes")}</span>
          <textarea
            data-testid="form-notes"
            value={notes}
            placeholder={t("hostForm.notesPlaceholder")}
            rows={3}
            onChange={(e) => setNotes(e.currentTarget.value)}
          />
        </label>

        {submitError && (
          <p className="form-error" data-testid="form-submit-error">
            {submitError}
          </p>
        )}

        <div className="form-actions">
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-accent" disabled={submitting} data-testid="form-submit">
            {host ? t("common.save") : t("hostForm.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
