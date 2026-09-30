-- 0002_entities：spec §3 五实体表 + FTS5 trigram 检索（Task 4）。
-- 台账裁定：
--   * history 表（host_id, command, exit_code, ts, session_id + FTS）Task 15 启用，不入本迁移。
--   * jump_chains / port_forwards 等后续域表不入本迁移；hosts.jump_chain_id 暂为普通列，
--     对应表落地时再补 REFERENCES。
-- 统一约定（Task 4 评审 I-1，防密文重注入）：**承载加密字段（现/未来的 *_enc、
--   config_enc 等）的表，主键一律 INTEGER PRIMARY KEY AUTOINCREMENT**。
--   SQLite 裸 rowid = max+1，删掉最大 id 行后新行会复用该 id；AAD 绑定
--   "{table}:{id}:{field}" 时，同主密钥下被删行的旧密文可原样通过 GCM 认证
--   注入复用同 id 的新行。AUTOINCREMENT 走 sqlite_sequence，保证 rowid 严格递增
--   永不复用。本迁移对 host_groups / credentials / hosts / snippets 全部适用
--   （含当下无加密列的表，免得未来加 *_enc 时改表）；known_hosts 主键是
--   fingerprint（TEXT）且不承载任何加密字段、不经 AAD 绑定，AUTOINCREMENT
--   不适用、也不需要。
-- 删除语义（裁定 #3）：credentials / host_groups 是可复用实体，只被引用、不被级联删除；
--   引用列一律 ON DELETE SET NULL——删凭据 → 引用主机解绑；删分组 → 组内主机脱离、子组提根；
--   删主机 → 绑定的 snippet 转全局（host_scope 置空）。
-- CJK 检索（spec §3 + task-3 实测）：FTS5 trigram 外部内容表 + 触发器同步；
--   ≥3 字符查询走 MATCH，超短查询由 API 层 LIKE 兜底（见 entities.rs 的 search）。

CREATE TABLE host_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES host_groups (id) ON DELETE SET NULL,
    color      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE credentials (
    -- AUTOINCREMENT 见文件头「AAD 绑定表一律 AUTOINCREMENT」约定
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'key', 'totp')),
    -- 密文 blob = nonce(12B) || ciphertext || tag(16B)，AES-256-GCM；
    -- AAD = "credentials:{id}:{field}"，一律经 crypto::aad 构造（唯一构造点）。
    -- 明文永不落库：调用方传明文，存储层 seal；读取经 Credentials::reveal 单点 open。
    secret_enc      BLOB,
    key_pub         TEXT,
    passphrase_enc  BLOB,
    totp_secret_enc BLOB,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE hosts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    group_id          INTEGER REFERENCES host_groups (id) ON DELETE SET NULL,
    tags              TEXT NOT NULL DEFAULT '[]', -- JSON 数组
    address           TEXT NOT NULL,
    port              INTEGER NOT NULL DEFAULT 22,
    credential_id     INTEGER REFERENCES credentials (id) ON DELETE SET NULL,
    -- jump_chains 表未建（后续域任务）：暂无 FK，表落地时补 REFERENCES jump_chains(id)
    jump_chain_id     INTEGER,
    encoding_override TEXT,
    theme_override    TEXT,
    monitor_enabled   INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE TABLE snippets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,               -- {{var}} 模板
    variables  TEXT NOT NULL DEFAULT '[]',  -- JSON 数组（变量名）
    tags       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
    host_scope INTEGER REFERENCES hosts (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE known_hosts (
    fingerprint TEXT PRIMARY KEY,
    first_seen  INTEGER NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    changed_at  INTEGER,
    state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('ok', 'changed', 'pending'))
);

-- FTS5 trigram：外部内容表（content=原表）+ 触发器同步，避免双写漂移。
-- 可空列经 coalesce 规整为 ''，保证 delete/update 触发器回放的值与索引时逐字节一致。
CREATE VIRTUAL TABLE hosts_fts USING fts5(
    name,
    notes,
    content = 'hosts',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER hosts_fts_ai AFTER INSERT ON hosts BEGIN
    INSERT INTO hosts_fts (rowid, name, notes)
    VALUES (new.id, new.name, coalesce(new.notes, ''));
END;

CREATE TRIGGER hosts_fts_ad AFTER DELETE ON hosts BEGIN
    INSERT INTO hosts_fts (hosts_fts, rowid, name, notes)
    VALUES ('delete', old.id, old.name, coalesce(old.notes, ''));
END;

CREATE TRIGGER hosts_fts_au AFTER UPDATE ON hosts BEGIN
    INSERT INTO hosts_fts (hosts_fts, rowid, name, notes)
    VALUES ('delete', old.id, old.name, coalesce(old.notes, ''));
    INSERT INTO hosts_fts (rowid, name, notes)
    VALUES (new.id, new.name, coalesce(new.notes, ''));
END;

CREATE VIRTUAL TABLE snippets_fts USING fts5(
    body,
    content = 'snippets',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER snippets_fts_ai AFTER INSERT ON snippets BEGIN
    INSERT INTO snippets_fts (rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER snippets_fts_ad AFTER DELETE ON snippets BEGIN
    INSERT INTO snippets_fts (snippets_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE TRIGGER snippets_fts_au AFTER UPDATE ON snippets BEGIN
    INSERT INTO snippets_fts (snippets_fts, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO snippets_fts (rowid, body) VALUES (new.id, new.body);
END;
