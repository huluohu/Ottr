-- 0010_ftp_ftps（Phase 2 Task 5，spec §3 FTP/FTPS 第二后端）：两件事——
--
-- 1) hosts.protocol：主机协议（ssh | ftp | ftps），默认 'ssh'——存量行全是
--    SSH 语义（列在消费面落地时补齐，与 0003 username 同思路的模型缺口）。
--    ADD COLUMN 带 CHECK + NOT NULL DEFAULT：SQLite 要求现有行满足 CHECK，
--    默认值 'ssh' 天然满足。
-- 2) credentials.kind CHECK 放开 'ftp'/'ftps'（FTP 密码凭据与 SSH 密码凭据
--    在 UI 上分型，存储面同为 secret 密封通道）。SQLite 不能 ALTER CHECK →
--    重建表：列集/AAD 字段名（credentials:{id}:{field}）**零变化**，密文列
--    原样平移，AUTOINCREMENT 纪律保留。无新增加密列，不动 scan_registry。
--
-- 重建的正确性要点（评审 I-1 同源）：DROP TABLE 会连带删 sqlite_sequence 行
-- → AUTOINCREMENT 水位丢失 → 若历史上删过最大 id 行，新行复用 id 后旧密文
-- 可原样通过 GCM 认证注入（AAD 绑定 credentials:{id}:{field}）。因此重建
-- **先把旧水位搬进新表的 sequence 行**（旧表无 sequence 行 = 从未插过行，
-- 置 0 安全），再 DROP/RENAME。守卫测试：entities_test::migration_0010_*。

ALTER TABLE hosts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'ssh'
    CHECK (protocol IN ('ssh', 'ftp', 'ftps'));

CREATE TABLE credentials_new (
    -- AUTOINCREMENT 纪律同 0002（AAD 绑定 rowid 的表主键永不复用）
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'totp', 'ftp', 'ftps')),
    secret_enc      BLOB,
    key_pub         TEXT,
    passphrase_enc  BLOB,
    totp_secret_enc BLOB,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

INSERT INTO credentials_new (id, kind, secret_enc, key_pub, passphrase_enc,
                             totp_secret_enc, created_at, updated_at)
    SELECT id, kind, secret_enc, key_pub, passphrase_enc,
           totp_secret_enc, created_at, updated_at
    FROM credentials;

-- 水位搬移必须在 DROP 前（DROP 连带删旧 sequence 行）
UPDATE sqlite_sequence
   SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'credentials'), 0)
 WHERE name = 'credentials_new';

DROP TABLE credentials;
-- ALTER RENAME 会同步改写 sqlite_sequence 里的表名（SQLite ≥ 3.25）
ALTER TABLE credentials_new RENAME TO credentials;
