-- 0026_credential_agent（2026-11-02 批次五 P2）：系统 ssh-agent 凭据类型。
--
-- 背景：把私钥存进 Ottr 的 vault 意味着 Ottr 持有私钥；不少用户更希望私钥留在
-- 系统 agent（ssh-agent / 1Password agent / Keychain 桥）里，Ottr 只借用签名
-- 能力。新增 kind='agent'：**不存任何密钥材料**（无 *_enc 列参与），认证时由
-- Ottr 向系统 agent 请求签名。
--
-- SQLite 不能 ALTER CHECK → 重建表（与 0010 同款做法）：列集/AAD 字段名
-- （credentials:{id}:{field}）**零变化**，密文列原样平移，AUTOINCREMENT 纪律
-- 保留（先搬 sqlite_sequence 水位再 DROP/RENAME）。
-- 无新增加密列，不动 scan_registry。
CREATE TABLE credentials_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'totp', 'ftp', 'ftps', 'agent')),
    secret_enc      BLOB,
    key_pub         TEXT,
    passphrase_enc  BLOB,
    totp_secret_enc BLOB,
    totp_digits     INTEGER,
    totp_period     INTEGER,
    name            TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

INSERT INTO credentials_new (id, kind, secret_enc, key_pub, passphrase_enc,
                             totp_secret_enc, totp_digits, totp_period, name,
                             created_at, updated_at)
    SELECT id, kind, secret_enc, key_pub, passphrase_enc,
           totp_secret_enc, totp_digits, totp_period, name,
           created_at, updated_at
    FROM credentials;

-- **水位搬移必须在 DROP 前**（DROP 连带删旧 sequence 行）：把旧表的 seq
-- 搬进**新表**的 sequence 行。搬错了的后果不是「id 不好看」而是**密文 AAD
-- 复用**：AAD 绑定 credentials:{id}:{field}，若新行复用了被删过的 id，旧密文
-- 可原样通过 GCM 认证注入（0010 同一教训）。
UPDATE sqlite_sequence
   SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'credentials'), 0)
 WHERE name = 'credentials_new';

DROP TABLE credentials;
-- ALTER RENAME 会同步改写 sqlite_sequence 里的表名（SQLite ≥ 3.25）
ALTER TABLE credentials_new RENAME TO credentials;
