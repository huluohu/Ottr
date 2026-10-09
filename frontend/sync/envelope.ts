// 同步加密信封（Phase 5 Task 2）——分类数据 JSON → 单一 AES-256-GCM 信封。
//
// 格式（版本化，spec 计划 Task 2 裁定字段）：
//   {"ottr-sync":1,
//    "kdf":{"alg":"pbkdf2-sha256","salt":"<b64u>","iterations":310000},
//    "nonce":"<b64u>","ciphertext":"<b64u>"}
//
// 裁定实录（task-2 简报协调者裁定）：
//   * 信封在 TS 侧（WebCrypto SubtleCrypto 异步友好 + 与通道适配器同栈），
//     Rust 不参与（ottr-vault crypto.rs 只作参数与 AAD 纪律的先例对齐）；
//   * KDF 用 PBKDF2-SHA256 310k 迭代（WebCrypto 原生，零新依赖）：信封口令
//     是用户为同步单独设置的高熵口令场景（非低熵 vault 主密码），且口令不落
//     盘（存系统钥匙链/每次输入，归 Task 4 UI 面）；argon2-browser 引入 wasm
//     依赖的复杂度对本场景不成比例。alg 字段入格式——未来升 Argon2id 时版本
//     字段 bump、旧信封显式拒绝（见 envelope.test 拒绝面）；
//   * 信封口令独立于 vault 主密码（双层加密语义归 Task 3 论证）。
//
// AAD 纪律（沿 ottr-vault crypto.rs「防密文换绑」）：GCM additionalData =
// 头部（版本+kdf 参数）的 canonical JSON——密文绑死在它的头部参数上，事后篡改
// iterations/版本（降级替换攻击面）开封必败。
//
// 错误二分（EnvelopeError.reason）：format = 结构/版本/参数非法（不该进 KDF）；
// auth = GCM 认证失败（错口令、密文/头部被篡改）。上层 UI 只需区分
// 「信封坏了」与「口令不对」。

/** 顶层版本键（格式版本字段；未来不兼容演进 bump 到 2 并显式拒绝 1）。 */
export const ENVELOPE_MAGIC = "ottr-sync" as const;
export const ENVELOPE_FORMAT_VERSION = 1;

/** KDF 算法标识与迭代档（裁定：PBKDF2-SHA256 310k——OWASP PBKDF2-SHA256
 * 推荐量级下沿，高熵同步口令场景够用；增量余地留 iterations 字段）。 */
export const KDF_ALG = "pbkdf2-sha256" as const;
export const ENVELOPE_KDF_ITERATIONS = 310_000;

const SALT_LEN = 16; // 128-bit salt
const NONCE_LEN = 12; // GCM 96-bit
const TAG_LEN = 16; // GCM 认证标签
const KEY_LEN = 256 / 8;

/** iterations 结构合法域：低于下沿 = 降级/损坏；高于上沿 = DoS 防护。 */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

/** 同步信封（JSON 序列化后即传输载荷；字段面被格式版本钉死）。 */
export interface SyncEnvelope {
  [ENVELOPE_MAGIC]: typeof ENVELOPE_FORMAT_VERSION;
  kdf: {
    alg: typeof KDF_ALG;
    /** base64url（无 padding）。 */
    salt: string;
    iterations: number;
  };
  /** base64url，12B。 */
  nonce: string;
  /** base64url，明文 + 16B GCM tag。 */
  ciphertext: string;
}

/** 信封错误：reason = "format"（结构/版本/参数非法）| "auth"（认证失败）。 */
export class EnvelopeError extends Error {
  readonly reason: "format" | "auth";
  constructor(reason: "format" | "auth", message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.reason = reason;
  }
}

// --- 编码原语（base64url 无 padding；不依赖 Buffer——webview/test 同栈） ------

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** WebCrypto BufferSource 兼容字节（buffer 恒为本进程 ArrayBuffer）。 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function b64uEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64U[b0 >> 2];
    out += B64U[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64U[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64U[b2 & 63];
  }
  return out;
}

export function b64uDecode(text: string): Bytes {
  const rev = new Map<string, number>();
  for (let i = 0; i < B64U.length; i++) rev.set(B64U[i]!, i);
  const clean = text.replace(/=+$/, "");
  if (clean.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let pos = 0;
  for (const ch of clean) {
    const v = rev.get(ch);
    if (v === undefined) {
      throw new EnvelopeError("format", `invalid base64url character: ${JSON.stringify(ch)}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  // 余位非零 = 编码不 canonical（如 "Zh" → 丢弃位非 0）——拒绝而非静默容忍
  if ((acc & ((1 << bits) - 1)) !== 0) {
    throw new EnvelopeError("format", "non-canonical base64url padding bits");
  }
  return out;
}

/** UTF-8 面（口令与明文统一走 bytes，免 crypto API 的隐式编码歧义）。 */
export const utf8 = {
  encode: (text: string): Bytes => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder().decode(bytes),
};

/** 随机源注入位（测试确定性 golden）；生产 = crypto.getRandomValues。 */
export interface EnvelopeDeps {
  random?: (len: number) => Bytes;
}

const defaultRandom = (len: number): Bytes => crypto.getRandomValues(new Uint8Array(len));

// --- 头部 canonical JSON（AAD 原料；键序手工钉死免实现差异） ------------------

function headerJson(env: Pick<SyncEnvelope, typeof ENVELOPE_MAGIC | "kdf">): string {
  return (
    `{"${ENVELOPE_MAGIC}":${env[ENVELOPE_MAGIC]},"kdf":{"alg":"${env.kdf.alg}",` +
    `"salt":"${env.kdf.salt}","iterations":${env.kdf.iterations}}}`
  );
}

// --- KDF + AES-GCM（WebCrypto SubtleCrypto；每次运算即取即用不缓存密钥） ------

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new EnvelopeError("format", "WebCrypto SubtleCrypto unavailable");
  return s;
}

async function deriveKey(password: string, salt: Bytes, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", utf8.encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: KEY_LEN * 8 },
    false,
    usage,
  );
}

// --- 结构校验（唯一 format 错误出口；校验过即头部件可信进 AAD） ---------------

/**
 * 校验并收窄未知 JSON 为 {@link SyncEnvelope}。失败抛 EnvelopeError("format")。
 * 三通道 fetch 落地后的统一入口（传输层只管搬运字节，格式语义归本层）。
 */
export function parseEnvelope(raw: unknown): SyncEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnvelopeError("format", "envelope must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (!(ENVELOPE_MAGIC in obj)) {
    throw new EnvelopeError("format", `missing version key "${ENVELOPE_MAGIC}"`);
  }
  if (obj[ENVELOPE_MAGIC] !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeError("format", `unsupported envelope format version: ${String(obj[ENVELOPE_MAGIC])}`);
  }
  const kdf = obj["kdf"];
  if (kdf === null || typeof kdf !== "object" || Array.isArray(kdf)) {
    throw new EnvelopeError("format", "missing kdf block");
  }
  const k = kdf as Record<string, unknown>;
  if (k["alg"] !== KDF_ALG) {
    throw new EnvelopeError("format", `unsupported kdf alg: ${String(k["alg"])}`);
  }
  const iterations = k["iterations"];
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new EnvelopeError("format", `kdf iterations out of range [${MIN_ITERATIONS}, ${MAX_ITERATIONS}]: ${String(iterations)}`);
  }
  if (typeof k["salt"] !== "string") throw new EnvelopeError("format", "missing kdf salt");
  const salt = b64uDecode(k["salt"]);
  if (salt.length !== SALT_LEN) {
    throw new EnvelopeError("format", `salt must be ${SALT_LEN} bytes, got ${salt.length}`);
  }
  if (typeof obj["nonce"] !== "string") throw new EnvelopeError("format", "missing nonce");
  const nonce = b64uDecode(obj["nonce"]);
  if (nonce.length !== NONCE_LEN) {
    throw new EnvelopeError("format", `nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }
  if (typeof obj["ciphertext"] !== "string") throw new EnvelopeError("format", "missing ciphertext");
  const ciphertext = b64uDecode(obj["ciphertext"]);
  // 至少要装得下 GCM tag（空明文 = 纯 16B tag，合法）
  if (ciphertext.length < TAG_LEN) {
    throw new EnvelopeError("format", `ciphertext too short (${ciphertext.length} bytes)`);
  }
  return {
    [ENVELOPE_MAGIC]: ENVELOPE_FORMAT_VERSION,
    kdf: { alg: KDF_ALG, salt: k["salt"], iterations },
    nonce: obj["nonce"],
    ciphertext: obj["ciphertext"],
  };
}

// --- 密封 / 开封 ---------------------------------------------------------------

/**
 * 密封：随机 128-bit salt + 96-bit nonce（每次密封独立采样）；口令 →
 * PBKDF2-SHA256 → AES-256-GCM，头部（版本+kdf）进 AAD。
 * deps.random 仅供测试确定性 golden，生产留空。
 */
export async function sealEnvelope(
  plaintext: Uint8Array | string,
  password: string,
  deps: EnvelopeDeps = {},
): Promise<SyncEnvelope> {
  const random = deps.random ?? defaultRandom;
  const salt = random(SALT_LEN);
  const nonce = random(NONCE_LEN);
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN) {
    throw new EnvelopeError("format", "random source returned wrong length");
  }
  const saltB64 = b64uEncode(salt);
  const envHead: Pick<SyncEnvelope, typeof ENVELOPE_MAGIC | "kdf"> = {
    [ENVELOPE_MAGIC]: ENVELOPE_FORMAT_VERSION,
    kdf: { alg: KDF_ALG, salt: saltB64, iterations: ENVELOPE_KDF_ITERATIONS },
  };
  const key = await deriveKey(password, salt, ENVELOPE_KDF_ITERATIONS, ["encrypt"]);
  const body = typeof plaintext === "string" ? utf8.encode(plaintext) : new Uint8Array(plaintext);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8.encode(headerJson(envHead)), tagLength: 128 },
    key,
    body,
  );
  // SubtleCrypto 返回 ciphertext||tag（与 vault blob 布局同构，tag 在尾）
  return { ...envHead, nonce: b64uEncode(nonce), ciphertext: b64uEncode(new Uint8Array(sealed)) };
}

/**
 * 开封：结构校验（format 错不进 KDF）→ 按信封内参数派生密钥 → GCM 认证解密。
 * 错口令/篡改（含头部参数事后被改——AAD 绑定）→ EnvelopeError("auth")。
 */
export async function openEnvelope(envelope: unknown, password: string): Promise<Bytes> {
  const env = parseEnvelope(envelope);
  const key = await deriveKey(password, b64uDecode(env.kdf.salt), env.kdf.iterations, ["decrypt"]);
  try {
    const opened = await subtle().decrypt(
      { name: "AES-GCM", iv: b64uDecode(env.nonce), additionalData: utf8.encode(headerJson(env)), tagLength: 128 },
      key,
      b64uDecode(env.ciphertext),
    );
    return new Uint8Array(opened);
  } catch {
    throw new EnvelopeError("auth", "envelope authentication failed (wrong passphrase or tampered data)");
  }
}
