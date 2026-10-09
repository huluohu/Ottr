// 凭据草稿（Phase 5 T1 内联创建）：「新建凭据」的校验与载荷构造从
// CredentialForm 抽出为纯函数——HostForm 的「＋ 新建凭据…」内联子表单与
// 凭据对话框（CredentialForm）共用同一套规则，防双源漂移。
// 存储路径纪律不变：两处都只经 useVaultStore.createCredential → vaultApi
// credentials_create（vault seal 链），无任何自建存储面。
import type { CredentialInput, CredentialKind } from "../vault/api";

/** 凭据类型候选（与 CredentialForm KINDS 一致：Phase 2 Task 5 起 ftp/ftps
 * 为密码型；内联子表单同样全类型可选——功能零丢失）。 */
export const CREDENTIAL_KINDS: CredentialKind[] = ["password", "key", "totp", "ftp", "ftps"];

/** 密码型凭据（secret 字段面与 password 完全一致）。 */
export const PASSWORD_LIKE_KINDS: CredentialKind[] = ["password", "ftp", "ftps"];

/** 内联/对话框共用的「新建凭据」草稿值（明文只在内存，提交才 seal 落库）。 */
export interface CredentialDraft {
  /** 名称/标签（可选，明文非敏感；0021）。 */
  name: string;
  kind: CredentialKind;
  secret: string;
  keyPub: string;
  passphrase: string;
  totpSecret: string;
}

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

/**
 * 新建凭据草稿校验（CredentialForm.validate 的抽取态，语义逐分支等价）。
 * 返回错误 i18n 键（credentialForm.err*），null = 通过。`isNew` 恒 true
 * （草稿只有新建语义；编辑模式的「留空保留现值」patch 逻辑留在 CredentialForm）。
 */
export function validateCredentialDraft(draft: CredentialDraft): string | null {
  const { kind, secret, totpSecret } = draft;
  if (PASSWORD_LIKE_KINDS.includes(kind)) {
    if (secret.trim() === "") {
      return "credentialForm.errSecretRequired";
    }
  } else if (kind === "key" && secret.trim() !== "" && !looksLikePrivateKey(secret)) {
    return "credentialForm.errPrivateKeyMalformed";
  } else if (kind === "key" && secret.trim() === "") {
    return "credentialForm.errPrivateKeyRequired";
  }
  if (kind === "totp") {
    if (totpSecret.trim() === "") {
      return "credentialForm.errTotpRequired";
    }
    if (!isRoughBase32(totpSecret)) {
      return "credentialForm.errTotpBase32";
    }
  }
  return null;
}

/** 草稿 → CredentialInput（trim/null 语义与 CredentialForm 创建分支一致）。 */
export function credentialInputFrom(draft: CredentialDraft): CredentialInput {
  return {
    kind: draft.kind,
    name: draft.name.trim() === "" ? null : draft.name.trim(),
    secret: draft.secret === "" ? null : draft.secret,
    key_pub: draft.keyPub.trim() === "" ? null : draft.keyPub.trim(),
    passphrase: draft.passphrase === "" ? null : draft.passphrase,
    totp_secret: draft.totpSecret === "" ? null : draft.totpSecret,
  };
}

/** 空草稿（内联展开的初始值：默认密码型）。 */
export function emptyCredentialDraft(): CredentialDraft {
  return { name: "", kind: "password", secret: "", keyPub: "", passphrase: "", totpSecret: "" };
}
