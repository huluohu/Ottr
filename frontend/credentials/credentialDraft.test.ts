// credentialDraft 单测（Phase 5 T1）：共享校验/载荷构造的纯函数契约——
// HostForm 内联子表单与 CredentialForm 对话框两个挂点共用，规则漂移在此钉死。
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KINDS,
  PASSWORD_LIKE_KINDS,
  credentialInputFrom,
  emptyCredentialDraft,
  isRoughBase32,
  looksLikePrivateKey,
  validateCredentialDraft,
  type CredentialDraft,
} from "./credentialDraft";

const draft = (part: Partial<CredentialDraft>): CredentialDraft => ({
  ...emptyCredentialDraft(),
  ...part,
});

describe("credentialDraft 粗检", () => {
  it("isRoughBase32：字符集/最短长度/padding 宽容", () => {
    expect(isRoughBase32("JBSWY3DPEHPK3PXP")).toBe(true);
    expect(isRoughBase32("jbsw y3dp ehpk 3pxp")).toBe(true); // 空格忽略
    expect(isRoughBase32("JBSWY3DP==")).toBe(true); // padding 宽容
    expect(isRoughBase32("SHORT")).toBe(false); // <8
    expect(isRoughBase32("JBSWY3DP1")).toBe(false); // 1/8/0 不在 base32 字符集
  });

  it("looksLikePrivateKey：PEM 头尾块判据", () => {
    expect(looksLikePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
    expect(looksLikePrivateKey("-----BEGIN CERTIFICATE-----")).toBe(false);
    expect(looksLikePrivateKey("not a key")).toBe(false);
  });
});

describe("validateCredentialDraft（i18n 键契约）", () => {
  it("密码型必填；key 必填/PEM 粗检；totp 必填/base32", () => {
    expect(validateCredentialDraft(draft({ kind: "password" }))).toBe("credentialForm.errSecretRequired");
    expect(validateCredentialDraft(draft({ kind: "ftp" }))).toBe("credentialForm.errSecretRequired");
    expect(validateCredentialDraft(draft({ kind: "key" }))).toBe("credentialForm.errPrivateKeyRequired");
    expect(validateCredentialDraft(draft({ kind: "key", secret: "garbage" }))).toBe(
      "credentialForm.errPrivateKeyMalformed",
    );
    expect(validateCredentialDraft(draft({ kind: "totp" }))).toBe("credentialForm.errTotpRequired");
    expect(validateCredentialDraft(draft({ kind: "totp", totpSecret: "nope" }))).toBe(
      "credentialForm.errTotpBase32",
    );
  });

  it("合法草稿 → null（key 带 PEM、totp 合法 base32、密码型有值）", () => {
    expect(validateCredentialDraft(draft({ kind: "password", secret: "p" }))).toBeNull();
    expect(
      validateCredentialDraft(draft({ kind: "key", secret: "-----BEGIN PRIVATE KEY-----" })),
    ).toBeNull();
    expect(validateCredentialDraft(draft({ kind: "totp", totpSecret: "JBSWY3DPEHPK3PXP" }))).toBeNull();
  });

  it("类型候选全集（与凭据对话框一致，功能零丢失）", () => {
    expect(CREDENTIAL_KINDS).toEqual(["password", "key", "totp", "ftp", "ftps"]);
    expect(PASSWORD_LIKE_KINDS).toEqual(["password", "ftp", "ftps"]);
  });
});

describe("credentialInputFrom（trim/null 语义）", () => {
  it("空串 → null、keyPub trim；secret/passphrase 原样（不 trim——可含首尾空格）", () => {
    expect(
      credentialInputFrom(
        draft({ kind: "key", secret: "  x  ", keyPub: "  ssh-ed25519 AAAA ", passphrase: " pp ", totpSecret: "" }),
      ),
    ).toEqual({ kind: "key", name: null, secret: "  x  ", key_pub: "ssh-ed25519 AAAA", passphrase: " pp ", totp_secret: null });
    expect(
      credentialInputFrom(draft({ kind: "password", secret: " p " })),
    ).toEqual({ kind: "password", name: null, secret: " p ", key_pub: null, passphrase: null, totp_secret: null });
  });
});
