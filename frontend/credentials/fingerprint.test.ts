// keyFingerprint 单测（批次三 T3，BL-529）：同型 key（ed25519）双凭据摘要可辨
// 识——base64 体短指纹（FNV-1a 32 位 → base36 7 位），头 12 字符在 OpenSSH
// 形态下恒为算法名/base64 类型前缀（同型全同）的病灶不再。
import { describe, expect, it } from "vitest";
import { keyFingerprint } from "./fingerprint";

// 两条真实形态的 ed25519 公钥（base64 体头部 20 字符同型恒同，尾部不同）
const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx8vQ0Tc1a2b3c4d5e6f7g8h9i0j kate@web-01";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFz9wR1Ud2e3f4g5h6i7j8k9l0m1n ops@db-01";

describe("keyFingerprint（BL-529 同型 key 指纹）", () => {
  it("同型双 key 指纹互异（头 12 字符相同的病灶消除）", () => {
    const a = keyFingerprint(KEY_A);
    const b = keyFingerprint(KEY_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    // 旧病灶对照：两者 trim().split(/\s+/)[1]?.slice(0, 12) 恒同
    expect(KEY_A.split(/\s+/)[1].slice(0, 12)).toBe(KEY_B.split(/\s+/)[1].slice(0, 12));
  });

  it("OpenSSH 形态取 base64 体哈希（comment/算法名变化不挪指纹；体变则挪）", () => {
    const base = keyFingerprint(KEY_A);
    expect(keyFingerprint(KEY_A.replace("kate@web-01", "other@comment"))).toBe(base);
    expect(keyFingerprint(KEY_A.replace("IGx8", "IZy8"))).not.toBe(base);
  });

  it("裸 base64（无算法前缀）整体作体；空/空白 → null；确定可复现", () => {
    expect(keyFingerprint("AAAAC3NzaC1lZDI1NTE5")).toMatch(/^[0-9a-z]{1,7}$/);
    expect(keyFingerprint("AAAAC3NzaC1lZDI1NTE5")).toBe(keyFingerprint("AAAAC3NzaC1lZDI1NTE5"));
    expect(keyFingerprint("")).toBeNull();
    expect(keyFingerprint("   ")).toBeNull();
  });
});
