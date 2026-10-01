// HostForm（Task 5 Step 2）：新建/编辑主机。
// 字段：name/address/port/username/凭据选择/编码覆盖/跳板链（Phase 2
// Task 2：链式连接的绑定，none=直连）/标签/分组/备注；
// 校验（简报）：地址非空、端口 1-65535 整数；错误提示走 i18n。
// 名称留空时以地址兜底（vault 层拒绝空名，这里先收敛）。
// 凭据创建/编辑属 Task 6 域，此处只从现有凭据中选择绑定。
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Host, HostInput, HostProtocol } from "../vault/api";
import { useVaultStore } from "../vault/store";

export interface HostFormProps {
  /** 非空 = 编辑模式；null = 新建。 */
  host: Host | null;
  /** 新建时的预选分组（树内分组上下文菜单入口）。 */
  defaultGroupId: number | null;
  onClose: () => void;
}

/** 编码覆盖候选（Task 9 收口：与 Rust encoding_from_str 支持集一致——
 * utf-8/gbk/gb18030；big5 等无解码器的候选移除，防「存了就乱码」的静默陷阱）。 */
const ENCODINGS = ["utf-8", "gbk", "gb18030"];

/** 协议候选（Phase 2 Task 5）：ssh = 终端 + 文件；ftp/ftps = 纯文件会话。 */
const PROTOCOLS: HostProtocol[] = ["ssh", "ftp", "ftps"];

/** 协议默认端口（协议切换时若端口仍是某个默认值则跟随切换，避免「改协议忘改端口」）。 */
const DEFAULT_PORTS: Record<HostProtocol, number> = { ssh: 22, ftp: 21, ftps: 990 };

export function HostForm({ host, defaultGroupId, onClose }: HostFormProps) {
  const { t } = useTranslation();
  const hostGroups = useVaultStore((s) => s.hostGroups);
  const credentials = useVaultStore((s) => s.credentials);
  const jumpChains = useVaultStore((s) => s.jumpChains);
  const createHost = useVaultStore((s) => s.createHost);
  const updateHost = useVaultStore((s) => s.updateHost);

  const [name, setName] = useState(host?.name ?? "");
  const [address, setAddress] = useState(host?.address ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [protocol, setProtocol] = useState<HostProtocol>(host?.protocol ?? "ssh");
  const [groupId, setGroupId] = useState<string>(String(host?.group_id ?? defaultGroupId ?? ""));
  const [credentialId, setCredentialId] = useState<string>(
    host?.credential_id != null ? String(host.credential_id) : "",
  );
  const [jumpChainId, setJumpChainId] = useState<string>(
    host?.jump_chain_id != null ? String(host.jump_chain_id) : "",
  );
  const [encoding, setEncoding] = useState(host?.encoding_override ?? "");
  const [production, setProduction] = useState(host?.is_production ?? false);
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
      protocol,
      credential_id: credentialId === "" ? null : Number(credentialId),
      jump_chain_id: jumpChainId === "" ? null : Number(jumpChainId),
      encoding_override: encoding === "" ? null : encoding,
      theme_override: host?.theme_override ?? null,
      monitor_enabled: host?.monitor_enabled ?? false,
      is_production: production,
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
        <div className="form-row">
          {/* 协议（Phase 2 Task 5）：ssh = 终端 + 文件面板；ftp/ftps = 纯文件
              会话（FilePanel 后端切换依据，Rust 侧 ftp_attach 承接）。 */}
          <label>
            <span>{t("hostForm.protocol")}</span>
            <select
              data-testid="form-protocol"
              value={protocol}
              onChange={(e) => {
                const next = e.currentTarget.value as HostProtocol;
                setProtocol(next);
                // 端口仍在「某个协议默认值」上时跟随新协议默认（用户自定义不动）
                if (Object.values(DEFAULT_PORTS).includes(Number(port.trim()))) {
                  setPort(String(DEFAULT_PORTS[next]));
                }
              }}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {t(`hostForm.protocol_${p}`)}
                </option>
              ))}
            </select>
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
          {/* 跳板链（Phase 2 Task 2，B7 下半）：绑定后连接经链上逐跳直达本机
              （编辑器入口在顶栏「跳板链」）。 */}
          <label>
            <span>{t("hostForm.chain")}</span>
            <select
              data-testid="form-jump-chain"
              value={jumpChainId}
              onChange={(e) => setJumpChainId(e.currentTarget.value)}
            >
              <option value="">{t("hostForm.chainNone")}</option>
              {jumpChains.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* 生产环境标记（Phase 2 Task 11，B11 防呆）：终端红框 + 页签 PROD 徽标
            + danger 输入提醒的消费依据。显式勾选，导入/编辑不臆测。 */}
        <label className="form-check" data-testid="form-production-row">
          <input
            type="checkbox"
            data-testid="form-production"
            checked={production}
            onChange={(e) => setProduction(e.currentTarget.checked)}
          />
          <span>{t("hostForm.production")}</span>
          <span className="form-check-hint">{t("hostForm.productionHint")}</span>
        </label>

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
