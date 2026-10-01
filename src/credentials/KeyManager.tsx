// KeyManager（Task 6，A4）：密钥生成 / openssh 导入 / 导出 / 指纹展示 / 公钥部署。
//   * 生成与导入走 Rust keygen（ottr-ssh），支持矩阵：ed25519 / ecdsa-p256 / rsa
//     可生成，dsa 明确拒绝；导入含加密私钥（口令解锁）。
//   * 导出确认（裁定 #2）：主密码模式 Task 11 才有——本任务 = 显式点击 +
//     加密私钥须先输入正确 passphrase（key_inspect 验证通过才允许 key_export）。
//   * 部署（裁定 #3）：幂等 exec 追加 authorized_keys；认证材料服务端从 vault
//     取（key_deploy），明文不过前端；TOTP 凭据不在部署支持面。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  vaultApi,
  type KeyAlgorithm,
  type KeyDeployReport,
  type KeyMaterial,
} from "../vault/api";
import { useVaultStore } from "../vault/store";

const ALGORITHMS: KeyAlgorithm[] = ["ed25519", "ecdsa-p256", "rsa"];
const KH_STATE_KEY: Record<KeyDeployReport["known_hosts_state"], string> = {
  ok: "keyManager.khOk",
  changed: "keyManager.khChanged",
  pending: "keyManager.khPending",
};

export function KeyManager() {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const credentials = useVaultStore((s) => s.credentials);
  const createCredential = useVaultStore((s) => s.createCredential);

  // 生成
  const [algorithm, setAlgorithm] = useState<KeyAlgorithm>("ed25519");
  const [genPassphrase, setGenPassphrase] = useState("");
  const [comment, setComment] = useState("ottr");
  const [generating, setGenerating] = useState(false);

  // 导入
  const [importPem, setImportPem] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");

  // 解析结果（生成/导入共用）
  const [material, setMaterial] = useState<KeyMaterial | null>(null);
  const [materialPassphrase, setMaterialPassphrase] = useState("");
  const [materialEncrypted, setMaterialEncrypted] = useState(false);
  const [savedCredentialId, setSavedCredentialId] = useState<number | null>(null);

  // 导出确认（裁定 #2：显式点击 + 加密私钥 passphrase 验证）
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportedPath, setExportedPath] = useState<string | null>(null);

  // 部署
  const [deployHostId, setDeployHostId] = useState("");
  const [deployAuthId, setDeployAuthId] = useState("");
  const [deployPub, setDeployPub] = useState("");
  const [deployReport, setDeployReport] = useState<KeyDeployReport | null>(null);
  const [deploying, setDeploying] = useState(false);

  const [error, setError] = useState<string | null>(null);

  function adoptMaterial(m: KeyMaterial, passphrase: string) {
    setMaterial(m);
    setMaterialPassphrase(passphrase);
    setMaterialEncrypted(passphrase !== "");
    setDeployPub(m.public_openssh);
    setSavedCredentialId(null);
    setExportedPath(null);
    setError(null);
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const pass = genPassphrase;
      const m = await vaultApi.keys.generate(algorithm, pass === "" ? null : pass, comment.trim() === "" ? null : comment.trim());
      adoptMaterial(m, pass);
    } catch (err) {
      setError(t("keyManager.generateFailed", { message: String(err) }));
    } finally {
      setGenerating(false);
    }
  }

  async function handleImport() {
    setError(null);
    try {
      const pass = importPassphrase;
      const m = await vaultApi.keys.inspect(importPem, pass === "" ? null : pass);
      adoptMaterial(m, pass);
    } catch (err) {
      setError(t("keyManager.importFailed", { message: String(err) }));
    }
  }

  async function handleSaveAsCredential() {
    if (!material) return;
    setError(null);
    try {
      const cred = await createCredential({
        kind: "key",
        secret: material.private_openssh,
        key_pub: material.public_openssh,
        passphrase: materialPassphrase === "" ? null : materialPassphrase,
        totp_secret: null,
      });
      setSavedCredentialId(cred.id);
    } catch (err) {
      setError(t("keyManager.saveFailed", { message: String(err) }));
    }
  }

  /** 导出确认。加密私钥（裁定 #2）：先 key_inspect 验证口令，通过才落盘。 */
  async function handleExportConfirm() {
    if (!material) return;
    setError(null);
    try {
      if (materialEncrypted) {
        // 校验与写入分离：inspect 不过 = 口令错误，不触导出
        await vaultApi.keys.inspect(material.private_openssh, exportPassphrase === "" ? null : exportPassphrase);
      }
      const path = await vaultApi.keys.export(material.private_openssh, null);
      setExportedPath(path);
      setExportOpen(false);
      setExportPassphrase("");
    } catch (err) {
      setError(t("keyManager.exportFailed", { message: String(err) }));
    }
  }

  async function handleDeploy() {
    setError(null);
    setDeployReport(null);
    if (deployHostId === "") {
      setError(t("keyManager.errHostRequired"));
      return;
    }
    if (deployAuthId === "") {
      setError(t("keyManager.errAuthRequired"));
      return;
    }
    if (deployPub.trim() === "" || deployPub.trim().includes("\n")) {
      setError(t("keyManager.errPubRequired"));
      return;
    }
    const host = hosts.find((h) => String(h.id) === deployHostId);
    if (!host) return;
    setDeploying(true);
    try {
      const report = await vaultApi.keys.deploy(
        Number(deployAuthId),
        host.address,
        host.port,
        host.username ?? "",
        deployPub.trim(),
      );
      setDeployReport(report);
    } catch (err) {
      setError(t("keyManager.deployFailed", { message: String(err) }));
    } finally {
      setDeploying(false);
    }
  }

  const deployableAuths = credentials.filter((c) => c.kind === "password" || c.kind === "key");
  const selectedHost = hosts.find((h) => String(h.id) === deployHostId) ?? null;

  return (
    <section aria-label={t("credentials.tabKeys")} data-testid="key-manager">
      <div className="km-panel">
        <h3>{t("keyManager.generateTitle")}</h3>
        <div className="form-row">
          <label>
            <span>{t("keyManager.algorithm")}</span>
            <select
              data-testid="km-algorithm"
              value={algorithm}
              onChange={(e) => setAlgorithm(e.currentTarget.value as KeyAlgorithm)}
            >
              {ALGORITHMS.map((a) => (
                <option key={a} value={a}>
                  {t(`keyManager.alg_${a}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("keyManager.generatePassphrase")}</span>
            <input
              data-testid="km-gen-passphrase"
              type="password"
              value={genPassphrase}
              autoComplete="new-password"
              onChange={(e) => setGenPassphrase(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t("keyManager.comment")}</span>
            <input data-testid="km-comment" value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
          </label>
        </div>
        <div className="form-actions">
          <button
            className="btn-accent"
            data-testid="km-generate"
            disabled={generating}
            onClick={() => void handleGenerate()}
          >
            {generating ? t("keyManager.generating") : t("keyManager.generate")}
          </button>
        </div>
      </div>

      <div className="km-panel">
        <h3>{t("keyManager.importTitle")}</h3>
        <label>
          <span>{t("keyManager.importPem")}</span>
          <textarea
            data-testid="km-import-pem"
            rows={4}
            spellCheck={false}
            value={importPem}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            onChange={(e) => setImportPem(e.currentTarget.value)}
          />
        </label>
        <label>
          <span>{t("keyManager.importPassphrase")}</span>
          <input
            data-testid="km-import-passphrase"
            type="password"
            value={importPassphrase}
            autoComplete="off"
            onChange={(e) => setImportPassphrase(e.currentTarget.value)}
          />
        </label>
        <div className="form-actions">
          <button data-testid="km-import" onClick={() => void handleImport()}>
            {t("keyManager.import")}
          </button>
        </div>
      </div>

      {material && (
        <div className="km-panel km-result" data-testid="km-result">
          <h3>{t("keyManager.resultTitle")}</h3>
          <p>
            <span className="km-label">{t("keyManager.algorithm")}</span>
            <code data-testid="km-result-algorithm">{material.algorithm}</code>
          </p>
          <p>
            <span className="km-label">{t("keyManager.fingerprint")}</span>
            <code data-testid="km-fingerprint">{material.fingerprint}</code>
          </p>
          <p className="km-pub">
            <span className="km-label">{t("keyManager.publicKey")}</span>
            <code data-testid="km-public-key">{material.public_openssh}</code>
          </p>
          <div className="form-actions">
            <button data-testid="km-save-credential" onClick={() => void handleSaveAsCredential()}>
              {t("keyManager.saveAsCredential")}
            </button>
            <button data-testid="km-export" onClick={() => setExportOpen(true)}>
              {t("keyManager.export")}
            </button>
          </div>
          {savedCredentialId != null && (
            <p className="tree-status" data-testid="km-saved">
              {t("keyManager.savedAsCredential", { id: savedCredentialId })}
            </p>
          )}
          {exportedPath && (
            <p className="tree-status" data-testid="km-exported">
              {t("keyManager.exported", { path: exportedPath })}
            </p>
          )}
          {exportOpen && (
            <div className="km-export-confirm" data-testid="km-export-confirm">
              <p>
                {materialEncrypted
                  ? t("keyManager.exportPassphrasePrompt")
                  : t("keyManager.exportNoPassphrasePrompt")}
              </p>
              {materialEncrypted && (
                <input
                  data-testid="km-export-passphrase"
                  type="password"
                  value={exportPassphrase}
                  autoComplete="off"
                  onChange={(e) => setExportPassphrase(e.currentTarget.value)}
                />
              )}
              <div className="form-actions">
                <button type="button" data-testid="km-export-cancel" onClick={() => setExportOpen(false)}>
                  {t("common.cancel")}
                </button>
                <button type="button" className="btn-accent" data-testid="km-export-do" onClick={() => void handleExportConfirm()}>
                  {t("keyManager.exportConfirm")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="km-panel">
        <h3>{t("keyManager.deployTitle")}</h3>
        <div className="form-row">
          <label>
            <span>{t("keyManager.deployHost")}</span>
            <select
              data-testid="km-deploy-host"
              value={deployHostId}
              onChange={(e) => setDeployHostId(e.currentTarget.value)}
            >
              <option value="">—</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("keyManager.deployAuth")}</span>
            <select
              data-testid="km-deploy-auth"
              value={deployAuthId}
              onChange={(e) => setDeployAuthId(e.currentTarget.value)}
            >
              <option value="">{t("keyManager.deployAuthNone")}</option>
              {deployableAuths.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("hostForm.credentialLabel", { id: c.id, kind: c.kind })}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selectedHost && (
          <p className="dialog-intro" data-testid="km-deploy-target">
            {selectedHost.username ? `${selectedHost.username}@` : ""}
            {selectedHost.address}:{selectedHost.port}
          </p>
        )}
        <label>
          <span>{t("keyManager.deployPublicKey")}</span>
          <input
            data-testid="km-deploy-pub"
            value={deployPub}
            spellCheck={false}
            onChange={(e) => setDeployPub(e.currentTarget.value)}
          />
        </label>
        <div className="form-actions">
          <button className="btn-accent" data-testid="km-deploy" disabled={deploying} onClick={() => void handleDeploy()}>
            {deploying ? t("keyManager.deploying") : t("keyManager.deploy")}
          </button>
        </div>
        {deployReport && (
          <div className="km-deploy-report" data-testid="km-deploy-result">
            <p className="tree-status" data-testid="km-deploy-status">
              {deployReport.status === "added"
                ? t("keyManager.deployAdded")
                : t("keyManager.deployAlreadyPresent")}
            </p>
            <p>
              <span className="km-label">{t("keyManager.fingerprint")}</span>
              <code>{deployReport.public_key_fingerprint}</code>
            </p>
            {deployReport.host_key_fingerprint && (
              <p className="dialog-intro">
                {t("keyManager.deployHostKey", {
                  fingerprint: deployReport.host_key_fingerprint,
                  state: t(KH_STATE_KEY[deployReport.known_hosts_state]),
                })}
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="form-error" data-testid="km-error">
          {error}
        </p>
      )}
    </section>
  );
}
