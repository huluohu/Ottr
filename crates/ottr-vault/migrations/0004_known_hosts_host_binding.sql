-- 0004_known_hosts_host_binding（Task 8 义务①，T7 裁定必办）：
-- known_hosts 从「fingerprint 主键」改为「host 端点绑定」。
--
-- 动机（spec §10 防 MITM 承诺）：旧表以 fingerprint 为主键、没有 host 身份——
-- 同一主机换钥后，新指纹查不到任何记录 → 策略层只能当「首见」走新一轮 TOFU
-- （pending 问询），而非 changed 强提醒（默认拒绝）。等于服务器密钥轮换 /
-- 中间人攻击在产品表现上与首次连接无异。
--
-- 方案：host_key TEXT PRIMARY KEY，格式 = "{address}:{port}"（IPv6 地址含冒号，
-- 由 host_endpoint_key 统一加方括号 "[addr]:port"）。理由（对比 host_id 关联）：
--   * TOFU 信任锚是**网络端点**而非 vault 行：删主机重建（新 host_id）不应重置
--     信任；两条主机记录指向同一 address:port 本就是同一台服务器，共享信任记录
--     才是防 MITM 的正确语义。
--   * host_id 方案在删 host 行时无论 CASCADE（丢信任）还是 SET NULL（孤儿行）
--     都有坑；address:port 与 OpenSSH known_hosts「主机 → 钥匙」语义一致，免外键。
--   * AAD 约定（0002 文件头）：TEXT 主键、不承载加密字段、不经 AAD 绑定 →
--     AUTOINCREMENT 不适用也不需要。
--
-- 存量数据：旧行没有 host 身份、无法回填真实端点，以 "legacy:{fingerprint}" 虚拟
-- 端点原样保留（不丢历史留痕）。该格式与真实端点键不可能碰撞：端点键的端口段
-- 恒为十进制数字（i64 序列化），而 legacy 键含指纹自带的 "SHA256:" 冒号段；
-- host_endpoint_key 对含冒号地址一律加方括号。旧行的信任关系在下一次连接时按
-- 首见 TOFU 重新建立（无法避免——旧数据本来就没记 host），但 changed_at /
-- state 历史不丢。
--
-- 语义变化（entities.rs KnownHosts 同步）：每端点一行、fingerprint = 该端点
-- 当前信任锚（最近一次 verify 接受的钥匙）。mark_changed 只打 changed 标记、
-- **不覆盖 fingerprint**（保留旧信任锚——拒绝疑似 MITM 后，行内仍钉着原钥匙，
-- 与 OpenSSH「警告且不写 known_hosts」一致）。

CREATE TABLE known_hosts_new (
    host_key    TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    first_seen  INTEGER NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    changed_at  INTEGER,
    state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('ok', 'changed', 'pending'))
);

INSERT INTO known_hosts_new (host_key, fingerprint, first_seen, verified, changed_at, state)
SELECT 'legacy:' || fingerprint, fingerprint, first_seen, verified, changed_at, state
FROM known_hosts;

DROP TABLE known_hosts;
ALTER TABLE known_hosts_new RENAME TO known_hosts;
