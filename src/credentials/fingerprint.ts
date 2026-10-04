// key 指纹（批次三 T3，BL-529）：同型 key（ed25519）双凭据在凭据列表/同步冲突
// 预告中不可辨动的收口——旧实现切 key_pub 头 12 字符，OpenSSH 形态下这段恒为
// 「算法名 + base64 类型前缀」（同型全同，形同虚设）。
//
// 方案（简报「base64 首尾/hash」二选一）：取 **base64 体的短指纹**——FNV-1a
// 32 位 → base36 7 位（约 78bit 空间，展示级防撞足够；刻意不用 crypto.subtle：
// 异步面污染纯函数消费方，且此处不是安全比对，是给人眼看的「这两条不一样」）。
// OpenSSH 形态（`type base64 [comment]`）取第二段为体——comment 改动不挪指纹；
// 裸 base64 整体作体。空值 → null（消费方回落既有兜底，如 updated_at 日期）。
//
// 红线不变：指纹材料来自公钥（本就可印），secret/passphrase/totp 永不入摘要面。

/** FNV-1a 32 位（展示指纹用，非安全哈希）。 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 公钥材料 → 展示指纹（base36 ≤7 位）；空/空白 → null。纯函数，测试直测。 */
export function keyFingerprint(keyPub: string): string | null {
  const trimmed = keyPub.trim();
  if (trimmed === "") return null;
  const tokens = trimmed.split(/\s+/);
  const body = tokens.length >= 2 ? (tokens[1] ?? trimmed) : trimmed;
  return fnv1a32(body).toString(36);
}
