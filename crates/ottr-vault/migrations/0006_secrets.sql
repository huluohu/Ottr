-- 0006_secrets（Task 13，AI BYOK：provider api key 等敏感配置的密封 KV）。
-- 与 settings（明文面，锁定可读）相对：本表是**密文面**，读写都要求 Master
-- Key 在内存（锁定即拒）——api key 泄露面等同凭据，按凭据同款纪律密封。
-- key TEXT UNIQUE = 逻辑名（如 "ai.apikey.<providerId>"，前端 provider 删除
-- 时连带删除）；value_enc 经 scan_registry 登记（T11 主密码升级重密封扫描
-- 覆盖，漏登 = 升级后旧钥删除该列永久解不开，守卫测试强制）。
-- AUTOINCREMENT 纪律同实体表（T4 评审 I-1）：AAD 绑定 rowid 的表主键必须
-- 永不复用，防被删行的旧密文原样通过 GCM 认证注入新行。

CREATE TABLE secrets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    value_enc  BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
