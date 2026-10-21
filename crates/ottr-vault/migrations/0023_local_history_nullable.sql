-- 0023_local_history_nullable（2026-10-20 本地终端收口）：history.host_id 与
-- session_summaries.host_id 改可空——本地终端会话没有 vault 主机行，命令历史
-- 与会话纪要此前以 hostId -1 哨兵写入被 FK 静默拒绝（前端 fire-and-forget 吞错，
-- ⌘R 历史跨重启丢失、纪要永不生成）。host_id NULL = 归属「本机」，与 0022
-- recordings.host_id 同一口径。
--
-- SQLite 不能 ALTER 列可空性：四步重建（建新表 → 拷贝 → 删旧 → 改名）。
--
-- history 的特殊处：history_fts 是 **external content** FTS5 表（content='history'），
-- 索引行靠 history_fts_ai / history_fts_ad 触发器同步。重建期间：
--   1. 先删两触发器——否则 INSERT…SELECT 会对每行再触发 ai（索引重复），
--      DROP TABLE 也不触发 ad（索引悬空）；
--   2. 新表改名回 history 后重建同名触发器；
--   3. 最后 'rebuild' 命令让 FTS 按新表内容整体重建索引（id/rowid 原样拷贝，
--      与 content_rowid='id' 对应关系不变）。
--
-- session_summaries 的特殊处：summary_enc 密文列 AAD = session_summaries:{id}:summary，
-- id 原样拷贝 → AAD 不变，不动 scan_registry。唯一索引 (host_id, session_id) 在
-- SQLite 中 NULL 互不相等，本机多次收尾会堆出多行而非 upsert——改用表达式索引
-- COALESCE(host_id, -1) 让 NULL 参与唯一性（-1 与真实主机 id 不冲突：AUTOINCREMENT ≥ 1）。

-- ---------------------------------------------------------------- history
DROP TRIGGER IF EXISTS history_fts_ai;
DROP TRIGGER IF EXISTS history_fts_ad;

CREATE TABLE history_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id    INTEGER REFERENCES hosts (id) ON DELETE CASCADE,
    command    TEXT NOT NULL,
    cwd        TEXT,
    exit_code  INTEGER,
    session_id TEXT,
    ts         INTEGER NOT NULL
);

INSERT INTO history_new (id, host_id, command, cwd, exit_code, session_id, ts)
    SELECT id, host_id, command, cwd, exit_code, session_id, ts FROM history;

DROP TABLE history;
ALTER TABLE history_new RENAME TO history;

CREATE INDEX IF NOT EXISTS idx_history_host_id ON history (host_id);

CREATE TRIGGER history_fts_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts (rowid, command) VALUES (new.id, new.command);
END;

CREATE TRIGGER history_fts_ad AFTER DELETE ON history BEGIN
    INSERT INTO history_fts (history_fts, rowid, command)
    VALUES ('delete', old.id, old.command);
END;

INSERT INTO history_fts (history_fts) VALUES ('rebuild');

-- ---------------------------------------------------------------- session_summaries
CREATE TABLE session_summaries_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id       INTEGER REFERENCES hosts (id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL,
    summary_enc   BLOB NOT NULL,
    command_count INTEGER NOT NULL,
    ts            INTEGER NOT NULL
);

INSERT INTO session_summaries_new (id, host_id, session_id, summary_enc, command_count, ts)
    SELECT id, host_id, session_id, summary_enc, command_count, ts FROM session_summaries;

DROP TABLE session_summaries;
ALTER TABLE session_summaries_new RENAME TO session_summaries;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_summaries_session
    ON session_summaries (COALESCE(host_id, -1), session_id);
