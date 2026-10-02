// 同步加密信封单测（Phase 5 Task 2）：
//   * 格式 golden：{"ottr-sync":1,"kdf":{alg,salt,iterations},"nonce","ciphertext"}
//     ——版本字段钉死（未来算法演进 bump 版本，旧信封显式拒绝而非误读）；
//   * roundtrip（ASCII + Unicode 明文）；错口令/篡改 → 认证错（非格式错）；
//   * AAD 绑定：头部（版本+kdf 参数）进 GCM additionalData——参数事后被改
//     （降级替换攻击面）开封必败（vault crypto.rs AAD 纪律的信封版）；
//   * 确定性：注入固定 salt+nonce 可复现同一密文（golden 稳定面）；生产路径
//     两次密封同明文产出不同信封（随机 salt/nonce）。
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_FORMAT_VERSION,
  ENVELOPE_KDF_ITERATIONS,
  EnvelopeError,
  b64uDecode,
  b64uEncode,
  openEnvelope,
  sealEnvelope,
  utf8,
  type Bytes,
  type SyncEnvelope,
} from "./envelope";

const PASSWORD = "correct horse battery staple";
const PLAINTEXT = JSON.stringify({ hosts: [1, 2, 3], credentials: [] });

/** 固定随机源（确定性 golden）：salt=0..15、nonce=1..12 逐字节可辨。 */
const fixedRandom = (): ((len: number) => Bytes) => {
  let first = true;
  return (len: number): Bytes => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = first ? i : 100 + i;
    first = false;
    return out;
  };
};

async function sealFixed(plaintext: string | Uint8Array, password: string): Promise<SyncEnvelope> {
  return sealEnvelope(plaintext, password, { random: fixedRandom() });
}

describe("信封格式 golden", () => {
  it("顶层四键 + 版本字段 + kdf 参数面（alg/salt/iterations）", async () => {
    const env = await sealFixed(PLAINTEXT, PASSWORD);
    expect(Object.keys(env).sort()).toEqual(["ciphertext", "kdf", "nonce", "ottr-sync"]);
    expect(env["ottr-sync"]).toBe(ENVELOPE_FORMAT_VERSION);
    expect(env.kdf.alg).toBe("pbkdf2-sha256");
    expect(env.kdf.iterations).toBe(ENVELOPE_KDF_ITERATIONS);
    expect(b64uDecode(env.kdf.salt)).toHaveLength(16); // 128-bit salt
    expect(b64uDecode(env.nonce)).toHaveLength(12); // GCM 96-bit nonce
    expect(b64uDecode(env.ciphertext).length).toBeGreaterThan(16); // 明文+tag
  });

  it("base64url 字母表（无 +/；padding 允许）——golden：固定随机源下整体信封逐字可复现", async () => {
    const env = await sealFixed("ottr", PASSWORD);
    for (const field of [env.kdf.salt, env.nonce, env.ciphertext]) {
      expect(field).not.toMatch(/[+/]/);
    }
    // 确定性：同随机源 + 同输入 → 逐字节同一信封
    const again = await sealFixed("ottr", PASSWORD);
    expect(JSON.stringify(again)).toBe(JSON.stringify(env));
    // 明文按 UTF-8 编码（4 字节 emoji → 密文长度 = 4 + 16B tag）
    const emoji = await sealFixed("🦦", PASSWORD);
    expect(b64uDecode(emoji.ciphertext)).toHaveLength(4 + 16);
  });

  it("生产随机源：同明文两次密封产出不同信封（salt/nonce 独立采样）", async () => {
    const a = await sealEnvelope(PLAINTEXT, PASSWORD);
    const b = await sealEnvelope(PLAINTEXT, PASSWORD);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("roundtrip", () => {
  it("ASCII 明文（分类数据 JSON 形态）", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    const opened = utf8.decode(await openEnvelope(env, PASSWORD));
    expect(opened).toBe(PLAINTEXT);
  });

  it("Unicode 明文（中文 + emoji）与空明文", async () => {
    for (const text of ['{"name":"水獭 🦦","标签":"生产"}', ""]) {
      const opened = utf8.decode(await openEnvelope(await sealEnvelope(text, "口令pass"), "口令pass"));
      expect(opened).toBe(text);
    }
  });

  it("二进制明文（Uint8Array 直入，非 string 假设）", async () => {
    const bytes = new Uint8Array(257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const opened = await openEnvelope(await sealEnvelope(bytes, PASSWORD), PASSWORD);
    expect(Array.from(opened)).toEqual(Array.from(bytes));
  });
});

describe("拒绝面", () => {
  it("错口令 → EnvelopeError(auth)，不泄漏格式错信息", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    const err = await openEnvelope(env, "wrong password").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EnvelopeError);
    expect((err as EnvelopeError).reason).toBe("auth");
  });

  it("密文/盐/nonce 篡改 → auth 错", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    const flip = (b64: string): string => {
      const bytes = b64uDecode(b64);
      bytes[0] ^= 0x01;
      return b64uEncode(bytes);
    };
    await expect(openEnvelope({ ...env, ciphertext: flip(env.ciphertext) }, PASSWORD)).rejects.toMatchObject({
      reason: "auth",
    });
    await expect(openEnvelope({ ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt) } }, PASSWORD)).rejects.toMatchObject(
      { reason: "auth" },
    );
    await expect(openEnvelope({ ...env, nonce: flip(env.nonce) }, PASSWORD)).rejects.toMatchObject({ reason: "auth" });
  });

  it("AAD 绑定：头部参数（iterations/version）事后被改 → auth 错（防降级替换）", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    // iterations 改成合法域内的不同值（310k→350k）：过格式校验，只可能因
    // AAD 认证失败被拒——头部参数被替换的降级面在认证层封死
    const downgrade = {
      ...env,
      kdf: { ...env.kdf, iterations: 350_000 },
    };
    await expect(openEnvelope(downgrade, PASSWORD)).rejects.toMatchObject({ reason: "auth" });
    // 版本字段同面：1→无法改 2（格式校验拒绝），但若未来版本字段值合法域扩大，
    // AAD 绑定保证旧密文不能被重新标记为新版本——此处钉 iterations 面即可
  });

  it("格式错（format）：缺版本/版本不识/缺键/短 nonce/短密文/bad alg", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    const cases: unknown[] = [
      null,
      "string",
      {},
      { "ottr-sync": 2, kdf: env.kdf, nonce: env.nonce, ciphertext: env.ciphertext }, // 未来版本 → 显式拒绝
      { kdf: env.kdf, nonce: env.nonce, ciphertext: env.ciphertext }, // 缺版本键
      { "ottr-sync": 1, nonce: env.nonce, ciphertext: env.ciphertext }, // 缺 kdf
      { "ottr-sync": 1, kdf: { alg: "argon2id", salt: env.kdf.salt, iterations: 3 }, nonce: env.nonce, ciphertext: env.ciphertext },
      { "ottr-sync": 1, kdf: { alg: "pbkdf2-sha256", salt: "not-base64!", iterations: 310000 }, nonce: env.nonce, ciphertext: env.ciphertext },
      { "ottr-sync": 1, kdf: env.kdf, nonce: b64uEncode(new Uint8Array(8)), ciphertext: env.ciphertext }, // nonce 不足 12B
      { "ottr-sync": 1, kdf: env.kdf, nonce: env.nonce, ciphertext: b64uEncode(new Uint8Array(10)) }, // 短于 tag
      { "ottr-sync": 1, kdf: env.kdf, nonce: env.nonce, ciphertext: "!!!" },
    ];
    for (const bad of cases) {
      const err = await openEnvelope(bad, PASSWORD).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("format");
    }
  });

  it("iterations 非法值（0/负/超界）→ format 错，不进 KDF", async () => {
    const env = await sealEnvelope(PLAINTEXT, PASSWORD);
    for (const iterations of [0, -1, 1, 99_999, 100_000_000]) {
      await expect(
        openEnvelope({ ...env, kdf: { ...env.kdf, iterations } }, PASSWORD),
      ).rejects.toMatchObject({ reason: "format" });
    }
  });
});

describe("base64url helpers", () => {
  it("二进制 roundtrip 全字节域 + 空", () => {
    expect(b64uDecode(b64uEncode(new Uint8Array(0)))).toEqual(new Uint8Array(0));
    for (const len of [1, 2, 3, 4, 5, 12, 16, 100]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
      expect(Array.from(b64uDecode(b64uEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("RFC 4648 向量（'foobar' 系列，pad=URL 安全字母表）", () => {
    const enc = (s: string): string => b64uEncode(utf8.encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg");
    expect(enc("fo")).toBe("Zm8");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg");
    expect(enc("fooba")).toBe("Zm9vYmE");
    expect(enc("foobar")).toBe("Zm9vYmFy");
  });
});
